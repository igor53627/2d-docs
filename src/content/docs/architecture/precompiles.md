---
title: Precompiles — extending 2D without an EVM
description: Every chain eventually needs custom on-chain logic. 2D reaches for a short list of Elixir modules each of which fits in one file and can be read end to end, instead of an EVM. That design choice opens doors a wrapped bridge can't reach.
---

A chain that only moves value can't do much. Lending, escrows, swaps, authenticated oracle writes, atomic on-ramps; every serious protocol stack needs on-chain code beyond "debit A, credit B".

The default answer across the industry is an **EVM**: a general-purpose bytecode interpreter that runs arbitrary code anyone can deploy. The price is well known. Gas metering, a language designed around that metering, a whole VM attack surface, and the open question of what happens when untrusted code does unexpected things to your state.

2D takes a different path: a **small, explicit precompile registry**. Each "contract" is an Elixir module that fits in one file and implements a fixed behaviour at a fixed address in the `0x2D00…` namespace. There is no bytecode interpreter, no gas-metering layer to get wrong, and because the code set is closed, no question about what runs. You know it because the operator shipped it.

This article walks through how a transaction finds a precompile, what the `@behaviour Chain.Precompile` asks of an implementer, where the registry lives, what a real precompile looks like (sketched against the forthcoming HTLC target), and why that sketch ends up strictly stronger than a wrapped bridge.

## How a transaction finds a precompile

Every transaction has a `to` address. The block producer walks the happy path step by step. Decode the signed tx, check the nonce, then ask the precompile registry whether `to` belongs to a registered handler. A hit dispatches to the handler's `execute/3`. A miss falls through to the native USDC transfer. That second path handles 99% of traffic, because plain account-to-account USDC is not a precompile; it's the default.

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

Two branches, one decision. Registered? Call the handler. Unregistered? Move USDC. Nothing else counts as custom execution; everything custom goes through a precompile.

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

- `address/0`. Where this precompile lives. Hardcoded in the `0x2D00…` range so the set is easy to enumerate.
- `execute/3`. State-changing entry point. Called inside the block's transaction. Returns a result plus a log list that flows into the tx receipt, or `{:revert, reason}` to abort cleanly.
- `read/2`. View call. Used by `eth_call` and `triggerconstantcontract`. Never mutates state.

The `context` map passed to `execute/3` carries what Solidity calls `msg.sender`, `msg.value`, plus block height and tx index. That's everything a handler needs to reason about who it's acting for. Keeping this narrow is deliberate: an `execute/3` that can only do `Accounts.debit/credit` and read `context` is a much smaller thing to review than a whole EVM.

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

Boot loads the enabled precompiles once, and every transaction thereafter pays only an ETS lookup. Single-digit-microsecond. Adding a new precompile is one call to `register/2` plus a deploy of the module. There is no mempool-submitted bytecode; operators ship precompiles the same way they ship the rest of the node.

Address namespace matters. All system precompiles live at `0x2D00…`; the top byte `0x2D` (ASCII `-`, and the project's namesake) is a reserved prefix. `eth_getCode` returns `0x01` for any address in this range that resolves, so wallets that branch on "is there code here?" get the right answer without needing a full EVM.

## The HTLC precompile

Talking about precompiles in the abstract only gets you so far. Below is the HTLC precompile at `0x2D00…0001`, the first precompile with real state on the chain ([`lib/chain/precompiles/htlc.ex`](https://github.com/igor53627/2d/blob/7338952/lib/chain/precompiles/htlc.ex)).

An HTLC (hashed time-locked contract) is the primitive behind on-chain atomic swaps. Alice locks funds with a hash `H` and a deadline. Whoever knows the preimage `P` such that `sha256(P) = H` can claim before the deadline. If no one claims in time, Alice refunds herself. The magic: two parties on two different chains can run matching HTLCs and produce a swap that is either fully complete (preimage revealed on both sides) or fully rolled back (both deadlines hit, both parties refund). No custodian to trust, no validator set to convene, no pooled contract holding all the locked funds.

```elixir
defmodule Chain.Precompiles.HTLC do
  @moduledoc """
  Hashed time-locked contract: atomic swaps without a trusted bridge.
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

Roughly 40 lines end to end for a complete atomic-swap primitive. Three selectors, one ETS-backed state store keyed by hash, strict preconditions on each branch. Every state transition is one readable `with` chain: no reentrancy, no hidden loops, no gas surprise.

## Why this beats a bridge

The usual way to move tokens between chains is a **wrapped bridge**. Alice sends USDC to a custody contract on chain A, a validator federation observes the lock, and a wrapped representation is minted for her on chain B. Familiar, widely deployed, and catastrophically vulnerable: **over $2.8 billion has been stolen from cross-chain bridges since 2020, roughly 40% of all Web3 theft volume** ([Chainalysis / industry summary](https://www.certik.com/resources/blog/GuBAYoHdhrS1mK9Nyfyto-cross-chain-vulnerabilities-and-bridge-exploits-in-2022)). 2026 alone logged **over $750M in bridge losses in under four months** ([Phemex DeFi hacks 2026](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained)).

The headline failures read as a who's-who of validation-layer compromise:

- **Ronin** (2022, ~$620M). Five of nine validator keys phished; the attacker approved two massive withdrawals.
- **Wormhole** (2022, ~$320M). A misused Solana helper accepted a forged guardian signature, minting wETH out of thin air.
- **Nomad** (2022, ~$190M). An upgrade accidentally bypassed a crucial check, turning the bridge into a free-for-all.
- **Poly Network** (2021, ~$611M). The cross-chain manager's `lock` function could be tricked into unlocking arbitrary amounts.

An HTLC precompile has no validator set to compromise, no signature to forge, no upgrade path that can be fat-fingered, and no pool of TVL that could become an obvious target. Its entire trust model is "you know a preimage" plus "a deadline exists on this chain".

| | Wrapped bridge (Wormhole / Ronin / Nomad / …) | HTLC precompile |
|---|---|---|
| Trust model | N-of-M validator federation, custodian, or oracle | `sha256(preimage) = hash` + on-chain deadline |
| Failure mode (happy path) | Custodian approves wrap/unwrap | Preimage reveal, funds move |
| Failure mode (unhappy path) | Validator compromise drains the entire pool | Deadline hits, both sides refund |
| TVL concentration | Yes. Billions in one contract | No. Each lock is independent, bounded by its own amount |
| Upgrade risk | Multisig can upgrade (new attack path) | Handler deploy is an operator change; address is fixed |
| What's on-chain | A contract that trusts off-chain signers | The full state machine, every branch |
| Total lost since 2020 | $2.8B+ | Worst case is one user losing one lock |

The final row matters most. Bridge failures are *systemic*: one bug drains everything. HTLC failures are *per-swap*: one party can fail to claim or refund in time, and they lose at most what they put into that single lock. There is no "drain the bridge" threat model because there is no bridge.

The precompile design also sidesteps a subtle problem with bridge-based swaps. **A bridge is a smart contract, and smart contracts on a VM are only as safe as their implementation and their upgrade controls**. A precompile is an Elixir module reviewed before it ships; its upgrade path is a node release, not a multisig transaction; its state is in an ETS table whose layout is statically known. The attack surface shifts from "does the contract do what the whitepaper says" to "does the Elixir code match the spec", and the latter is a problem formal methods can actually attack at scale.

## Tradeoffs against EVM

The precompile model is not a free lunch. It gives up real things:

- **No third-party deployment.** You cannot deploy a new precompile by submitting bytecode to a mempool. Adding one is an operator release, same as adding any other feature to the node. That is a feature when you want a curated code set, a bug when you want an open permissionless contract platform.
- **Less expressivity.** A precompile is a single Elixir module with a fixed entry point. You cannot build ad-hoc composability between two untrusted contracts the way you can on EVM. If two precompiles need to interact, that interaction is written in Elixir by the operator.
- **Smaller ecosystem.** The entire dApp stack on EVM-compatible chains assumes Solidity + an EVM. A precompile chain is a different target. Integrations require walking through each precompile's ABI rather than pointing an existing Solidity toolchain at it.

What you get in return:

- **Every on-chain code path is Elixir you can read and check.** Typed, testable, runnable in a REPL, bounded by the module's file size.
- **No gas-metering complexity.** Gas metering exists to stop untrusted code from running forever. Precompile code is trusted and doesn't need a per-opcode meter. The chain's gas model can therefore be dramatically simpler, with no opcode-level accounting, because there are no adversarial opcodes.
- **Zero VM attack surface.** No EVM bugs, no bytecode exploits, no subtle side-channels between opcodes. The attack surface is the handful of precompile modules plus the BEAM itself. A dramatic reduction.

## Safety posture

A closed, auditable precompile set opens doors in code verification that are genuinely difficult when the code set is "anything anyone wants to deploy":

- **Tier 0 (baseline, today).** Dialyzer + Elixir 1.20 set-theoretic types give precompile modules real static guarantees. Function specs on the `@behaviour` callbacks already rule out whole classes of malformed-input bugs.
- **Tier 1 (planned as real precompiles land).** Property-based tests via PropCheck, driving `execute/3` with random selector+args tuples against module-level invariants ("sum of balances preserved", "a lock exists iff it's in the store").
- **Tier 2 (concurrency).** Concuerror walks every possible interleaving of ETS reads and writes across the registry, the handler, and the block producer. It catches races and deadlocks that ordinary tests miss.
- **Tier 3 (protocol).** TLA+ specs (generatable to runnable Erlang via Erla+) for precompiles whose correctness is a multi-step protocol rather than a single function. HTLC's "completed XOR rolled back, never partial" is the canonical target.

Each tier costs more and guards more than the one before. The point is to build the stack gradually, as real precompiles land, rather than up front.

## Where this is going

The first precompile with real state is queued for implementation. The HTLC sketched above. Alongside it, the verification stack will come up in layers. Dialyzer and types in CI today. PropCheck properties the day a stateful handler lands. TLA+ specs for HTLC and any subsequent precompile whose correctness is a protocol rather than a single function.
