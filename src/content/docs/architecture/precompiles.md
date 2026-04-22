---
title: Precompiles — extending 2D without an EVM
description: Every chain eventually needs custom on-chain logic. 2D reaches for a short list of reviewed Elixir modules instead of an EVM — and that design choice opens doors a wrapped bridge can't reach.
---

A chain that only moves value can't do much. Lending, escrows, swaps, authenticated oracle writes, atomic on-ramps — every serious protocol stack needs on-chain code beyond "debit A, credit B".

The default answer across the industry is an **EVM**: a general-purpose bytecode interpreter that runs arbitrary code anyone can deploy. The price is well-known — gas metering, a language designed around that metering, a whole VM attack surface, and the open question of what happens when untrusted code does unexpected things to your state.

2D takes a different path: a **small, explicit precompile registry**. Each "contract" is a reviewed Elixir module that implements a fixed behaviour and lives at a fixed address in the `0x2D00…` namespace. There is no bytecode interpreter, no gas-metering layer to get wrong, and — because the code set is closed — no question about what runs. You know it because the operator shipped it.

This article is the walkthrough: how a transaction finds a precompile, what the `@behaviour Chain.Precompile` asks of an implementer, where the registry lives, what a real precompile looks like (sketched against the forthcoming HTLC target), and why that sketch ends up strictly stronger than a wrapped bridge.

## How a transaction finds a precompile

Every transaction has a `to` address. The block producer walks the happy path step by step: decode the signed tx, check the nonce, then ask the precompile registry whether `to` belongs to a registered handler. A hit dispatches to the handler's `execute/3`. A miss falls through to the native USDC transfer — that's the path 99% of traffic takes, because plain account-to-account USDC is not a precompile; it's the default.

The dispatch code ([`lib/chain/block_producer.ex:291-319`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/block_producer.ex#L291-L319)):

```elixir
defp execute_tx_inner(pending, tx, from, to, value, fee, block_number, tx_index) do
  case to && Chain.Precompiles.Registry.lookup(to) do
    {:ok, handler} ->
      case Crypto.decode_hex_safe(tx.input) do
        {:error, _} ->
          {:error, :invalid_calldata}

        {:ok, input} ->
          if byte_size(input) < 4 do
            {:error, :invalid_calldata}
          else
            <<selector::binary-4, args::binary>> = input
            run_precompile_execute(handler, selector, args, ...)
          end
      end

    _ ->
      # native USDC transfer: debit sender, credit receiver, deduct fee.
      ...
  end
end
```

Two branches, one decision. Registered → call the handler. Unregistered → move USDC. Nothing else is custom execution; everything custom goes through a precompile.

## The `@behaviour Chain.Precompile`

Each precompile implements three callbacks ([`lib/chain/precompiles/precompile.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/precompiles/precompile.ex)):

```elixir
defmodule Chain.Precompile do
  @callback address() :: binary()

  @callback execute(selector :: binary(), args :: binary(), context :: map()) ::
              {:ok, result :: binary(), logs :: list()} | {:revert, reason :: binary()}

  @callback read(selector :: binary(), args :: binary()) ::
              {:ok, abi_encoded :: binary()} | {:revert, reason :: binary()}
end
```

- `address/0` — where this precompile lives. Hardcoded in the 0x2D00… range so the set is easy to enumerate.
- `execute/3` — state-changing entry point. Called inside the block's database transaction. Returns a result plus a log list that flows into the tx receipt, or `{:revert, reason}` to abort cleanly.
- `read/2` — view call. Used by `eth_call` and `triggerconstantcontract`. Never mutates state.

The `context` map passed to `execute/3` carries what solidity would call `msg.sender`, `msg.value`, plus block height and tx index — everything a handler needs to reason about who it's acting for. Keeping this narrow is deliberate: an `execute/3` that can only do `Accounts.debit/credit` and read `context` is a much smaller thing to review than a whole EVM.

## The registry

The registry ([`lib/chain/precompiles/registry.ex`](https://github.com/igor53627/2d/blob/c68ddb7/lib/chain/precompiles/registry.ex)) is an ETS table keyed by address:

```elixir
def lookup(address) when is_binary(address) do
  case :ets.lookup(@table, address) do
    [{^address, module}] -> {:ok, module}
    [] -> :not_found
  end
end

def register(address, handler_module) do
  GenServer.call(__MODULE__, {:register, address, handler_module})
end
```

Boot loads the enabled precompiles once, and every transaction thereafter pays only an ETS lookup — a single-digit-microsecond operation. Adding a new precompile is one call to `register/2` plus a deploy of the module. There is no mempool-submitted bytecode; operators ship precompiles the same way they ship the rest of the node.

Address namespace matters. All system precompiles live at `0x2D00…` — the top byte `0x2D` (ASCII `-`, and the project's namesake) is a reserved prefix. `eth_getCode` returns `0x01` for any address in this range that resolves, so wallets that branch on "is there code here?" get the right answer without needing a full EVM.

## Sketching an HTLC precompile

A real example helps. Here's the target design for the HTLC precompile — the first concrete implementation on our roadmap (tracked as TASK-18). It is not yet deployed; this is shape, not inventory.

An HTLC — hashed time-locked contract — is the primitive behind on-chain atomic swaps. Alice locks funds with a hash `H` and a deadline. Whoever knows the preimage `P` such that `sha256(P) = H` can claim before the deadline. If no one claims in time, Alice refunds herself. The magic is that two parties on two different chains can run matching HTLCs and produce a swap that is either fully complete (preimage revealed on both sides) or fully rolled back (both deadlines hit, both parties refund). No custodian, no bridge validator set, no pooled TVL.

```elixir
defmodule Chain.Precompiles.HTLC do
  @moduledoc """
  Hashed time-locked contract — atomic swaps without a trusted bridge.
  Design target for TASK-18.
  """
  @behaviour Chain.Precompile

  @address <<0x2D, 0::144, 0x00, 0x01>>  # 0x2D00…0001

  # 4-byte Keccak-256 selectors
  @lock   <<0x38, 0x5F, 0x65, 0xC3>>  # lock(bytes32,address,uint256)
  @claim  <<0x3A, 0x17, 0x94, 0xE2>>  # claim(bytes32)
  @refund <<0x02, 0xB8, 0x1C, 0x7C>>  # refund(bytes32)

  @impl true
  def address, do: @address

  @impl true
  def execute(@lock, <<hash::binary-32, receiver::binary-20, deadline::256>>, ctx) do
    case Store.get(hash) do
      :none ->
        Store.put(hash, %{
          sender: ctx.from,
          receiver: receiver,
          amount: ctx.value,
          deadline: deadline
        })

        {:ok, <<>>, [log(:HTLC_Locked, hash, ctx.from, receiver, ctx.value, deadline)]}

      _already_locked ->
        {:revert, "hash already locked"}
    end
  end

  def execute(@claim, <<preimage::binary-32>>, ctx) do
    hash = :crypto.hash(:sha256, preimage)

    with %{receiver: r, amount: a, deadline: d} <- Store.get(hash),
         true <- ctx.block_timestamp < d,
         true <- ctx.from == r,
         :ok <- Accounts.credit(r, a),
         :ok <- Store.delete(hash) do
      {:ok, <<>>, [log(:HTLC_Claimed, hash, preimage)]}
    else
      :none -> {:revert, "no lock for hash"}
      false -> {:revert, "deadline passed or not receiver"}
    end
  end

  def execute(@refund, <<hash::binary-32>>, ctx) do
    with %{sender: s, amount: a, deadline: d} <- Store.get(hash),
         true <- ctx.block_timestamp >= d,
         true <- ctx.from == s,
         :ok <- Accounts.credit(s, a),
         :ok <- Store.delete(hash) do
      {:ok, <<>>, [log(:HTLC_Refunded, hash)]}
    else
      :none -> {:revert, "no lock for hash"}
      false -> {:revert, "deadline not reached or not sender"}
    end
  end
end
```

Roughly 40 lines, end-to-end, for a complete atomic-swap primitive. Three selectors, one ETS-backed state store keyed by hash, strict preconditions on each branch. Every state transition is one reviewable `with` chain — no reentrancy, no hidden loops, no gas surprise.

## Why this beats a bridge

The usual alternative for moving value across chains is a **wrapped bridge** — Alice sends USDC to a custody contract on chain A, a validator federation observes the lock, and a wrapped representation is minted for her on chain B. Familiar, widely deployed, and catastrophically vulnerable: **over $2.8 billion has been stolen from cross-chain bridges since 2020, roughly 40% of all Web3 theft volume** ([Chainalysis / industry summary](https://www.certik.com/resources/blog/GuBAYoHdhrS1mK9Nyfyto-cross-chain-vulnerabilities-and-bridge-exploits-in-2022)). 2026 alone logged **over $750M in bridge losses in under four months** ([Phemex DeFi hacks 2026](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained)).

The headline failures read as a who's-who of validation-layer compromise:

- **Ronin** (2022, ~$620M) — five of nine validator keys phished; the attacker approved two massive withdrawals.
- **Wormhole** (2022, ~$320M) — a misused Solana helper accepted a forged guardian signature, minting wETH out of thin air.
- **Nomad** (2022, ~$190M) — an upgrade accidentally bypassed a crucial check, turning the bridge into a free-for-all.
- **Poly Network** (2021, ~$611M) — cross-chain manager's `lock` function could be tricked into unlocking arbitrary amounts.

An HTLC precompile does not have a validator set to compromise, does not have a signature to forge, does not have an upgrade path that can be fat-fingered, and does not pool TVL in any contract that could become a honeypot. Its entire trust model is "you know a preimage" plus "a deadline exists on this chain".

| | Wrapped bridge (Wormhole / Ronin / Nomad / …) | HTLC precompile |
|---|---|---|
| Trust model | N-of-M validator federation, custodian, or oracle | `sha256(preimage) = hash` + on-chain deadline |
| Failure mode (happy path) | Custodian approves wrap/unwrap | Preimage reveal, funds move |
| Failure mode (unhappy path) | Validator compromise → drain of entire pool | Deadline hits → both sides refund |
| TVL concentration | Yes — billions in one contract | No — each lock is independent, bounded by its own amount |
| Upgrade risk | Multisig can upgrade (new attack path) | Handler deploy is operator change; fixed at a known address |
| What's on-chain | A contract that trusts off-chain signers | The full state machine, every branch |
| Total lost since 2020 | $2.8B+ | Design allows a single lock to go wrong per user, bounded by that user's deposit |

The final row matters most. Bridge failures are *systemic* — one bug drains everything. HTLC failures are *per-swap* — one party can fail to claim or refund in time, and they lose at most what they put into that single lock. There is no "drain the bridge" threat model because there is no bridge.

The precompile design also sidesteps a subtle problem with bridge-based swaps: **the bridge is a smart contract, and smart contracts on a VM are only as safe as their implementation and their upgrade controls**. A precompile is an Elixir module reviewed before it ships; its upgrade path is a node release, not a multisig transaction; its state is in an ETS table whose layout is statically known. The attack surface is shifted from "does the contract do what the whitepaper says" to "does the Elixir code match the spec" — and the latter is a problem formal methods can actually attack at scale (see [TASK-23](https://github.com/igor53627/2d/blob/c68ddb7/backlog/tasks/task-23%20-%20Formal-verification-for-precompiles-—-tooling-article.md) for the verification roadmap).

## Tradeoffs against EVM

The precompile model is not a free lunch. It gives up real things:

- **No third-party deployment.** You cannot deploy a new precompile by submitting bytecode to a mempool. Adding one is an operator release — same as adding any other feature to the node. This is a feature when you want a curated code set, a bug when you want open permissionless contract platform.
- **Less expressivity.** A precompile is a single Elixir module with a fixed entry point. You cannot build ad-hoc composability between two untrusted contracts the way you can on EVM. If two precompiles need to interact, that interaction is written in Elixir by the operator.
- **Smaller ecosystem.** The entire dApp ecosystem on EVM-compatible chains assumes Solidity + an EVM. A precompile chain is a different target — integrations require walking through each precompile's ABI rather than pointing an existing Solidity toolchain at it.

What you get in return:

- **Every on-chain code path is reviewable Elixir** — typed, testable, runnable in a REPL, bounded by the module's file size.
- **No gas-metering complexity.** Gas metering exists to stop untrusted code from running forever. Precompile code is trusted — it doesn't need a per-opcode meter. The chain's gas model ([TASK-15](https://github.com/igor53627/2d/blob/c68ddb7/backlog/tasks/task-15%20-%20Free-Tier-Gas-Model.md)) can be simple: 10 free tx per account per day, then $0.01 USDC flat fee. No opcode-level accounting needed because there are no adversarial opcodes.
- **Zero VM attack surface.** No EVM bugs, no bytecode exploits, no subtle opcode-interaction oracles. The attack surface is the handful of precompile modules plus the BEAM itself — a dramatic reduction.

## Safety posture

A closed, auditable precompile set opens doors in code-verification that are genuinely difficult when the code set is "anything anyone wants to deploy":

- **Tier 0 (baseline, today).** Dialyzer + Elixir 1.20 set-theoretic types give precompile modules real static guarantees. Function specs on the `@behaviour` callbacks already rule out whole classes of malformed-input bugs.
- **Tier 1 (planned as real precompiles land).** Property-based tests via PropCheck, driving `execute/3` with random selector+args tuples against module-level invariants ("sum of balances preserved", "a lock exists iff it's in the store").
- **Tier 2 (concurrency).** Concuerror exhaustively explores interleavings of ETS reads/writes between the registry, the handler, and the block producer — catching races and deadlocks that ordinary tests miss.
- **Tier 3 (protocol).** TLA+ specs (generatable to runnable Erlang via Erla+) for precompiles whose correctness is a multi-step protocol rather than a single function — HTLC's "completed XOR rolled back, never partial" being the canonical target.

Each tier is progressively more expensive and progressively stronger. The roadmap lives in [TASK-23](https://github.com/igor53627/2d/blob/c68ddb7/backlog/tasks/task-23%20-%20Formal-verification-for-precompiles-—-tooling-article.md). A dedicated article will follow once there is a real precompile to verify — abstract proofs of nothing help no one.

## What's next

- **First real precompile**: HTLC, tracked as TASK-18. The sketch above is the target shape; the implementation PR will land with PropCheck properties from day one.
- **Verification tooling**: TASK-23 — Dialyzer wiring, PropCheck on the precompiles directory, Concuerror race test, TLA+ spec of HTLC atomicity.
- **Follow-up article**: *Proving our precompiles: from Dialyzer to TLA+* — queued for after the HTLC precompile ships and has something real to prove about.

If the idea of "atomic swaps without a bridge" sounds appealing, TASK-18 is the PR to watch.
