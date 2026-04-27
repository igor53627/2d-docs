---
title: Bridge — HTLC settlement and per-event refill
description: How 2D moves USD-stable across chains without a wrapped-bridge custody contract, an operator unlock authority, or a pre-mint trust seed. Preimage-locked settlement plus a verifier that re-checks every refill against finalized Ethereum state.
---

Bridges are the largest single class of crypto theft. **Over $2.8B has been stolen from cross-chain bridges since 2020, roughly 40% of all Web3 theft volume** ([Chainalysis / industry summary](https://www.certik.com/resources/blog/GuBAYoHdhrS1mK9Nyfyto-cross-chain-vulnerabilities-and-bridge-exploits-in-2022)). 2026 alone logged **over $750M in bridge losses in under four months** ([Phemex DeFi hacks 2026](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained)). The pattern in every catastrophic failure is the same: a custody contract holds locked tokens on chain A, a federation of validators observes the lock and signs an unlock-or-mint on chain B, and a single signature compromise drains the entire pool.

2D's bridge is built so that pattern cannot recur. There is no `unlock()` authority anywhere; settlement is preimage-locked HTLC on both sides. There is no pre-mint trust seed; supply on the 2D side starts at zero and grows one event at a time, each one independently re-checked against finalized Ethereum state. The operator's only role is matchmaker: lock something, lock the matching something on the other side, hand the user the preimage when the user shows up.

This article walks through the design choice (why HTLC over lock-mint), the refill-mint mechanics (how supply tracks Ethereum events 1:1), the cross-chain check (what the verifier independently confirms), and the trust model that falls out.

## Why not lock-mint

The default architecture for a bridge is **lock-mint**. Alice sends USDC to a custody contract on chain A. A federation of validators observes the lock event and signs a `mint(Alice, amount)` call on chain B's wrapped-token contract. The wrapped tokens travel; eventually someone redeems them, the bridge does the symmetric `burn`, and a corresponding `unlock()` call on chain A releases the original USDC.

The structural problem: that final `unlock()` is unconditional from the chain's perspective. Whoever holds the right keys (validator threshold, multisig, oracle quorum) can call `unlock()` for any amount up to the bridge's TVL at any time. Phish enough keys, the entire pool walks out.

The catastrophic failures read as a who's-who of unlock-authority compromise:

- **Wormhole** (2022, ~$320M). A misused Solana helper accepted a forged guardian signature, minting wETH out of thin air.
- **Ronin** (2022, ~$620M). Five of nine validator keys were phished; the attacker approved two large withdrawals.
- **Nomad** (2022, ~$190M). An upgrade accidentally bypassed a check, turning the unlock path into a free-for-all.
- **Poly Network** (2021, ~$611M). The cross-chain manager's `lock` function could be tricked into calling unlock on arbitrary amounts.

Different surfaces, same primitive: somebody with keys could unlock.

2D replaces lock-mint with **HTLC settlement on both sides**. Alice locks USDC on the Ethereum HTLC contract under a hash `H` and a deadline. The bridge operator locks the equivalent USD-stable on the 2D HTLC under the same hash. Alice claims on 2D using the preimage `P` such that `sha256(P) = H`. The operator now sees `P` on the 2D side and uses it to claim the original USDC on Ethereum.

The unlock authority is gone. There is no `unlock()` callable by the operator. The only function on either side that releases funds is `claim(preimage)`, which works only if `sha256(preimage) = hash` and only before the deadline. A compromised operator key cannot drain anything because preimages live in users' wallets, not the operator's.

The matching `refund(hash)` returns funds to the original sender once the deadline passes with no claim. Worst case for the user is `refund` firing and money returning where it came from. There is no scenario in which an attacker walks out with TVL.

## Refill-mint and the supply invariant

The HTLC swap on the 2D side requires the operator to have liquidity to lock. Where does that liquidity come from?

The default wrapped-bridge answer is "pre-mint a stockpile, trust the operator not to abscond." 2D refuses that trust. Production day-zero has zero USD-stable in the bridge operator's pool. The operator can only acquire USD-stable by **citing a finalized Ethereum lock**: every USD-stable that exists on the 2D side corresponds 1:1 to a verified Ethereum `Locked` event.

The mechanism is a single state-changing function on the `BridgeRefillMint` precompile at `0x2D00…0003` ([`lib/chain/precompiles/bridge_refill_mint.ex`](https://github.com/igor53627/2d/blob/8b7caf2/lib/chain/precompiles/bridge_refill_mint.ex)):

```solidity
refill_mint(uint64 eth_chain_id, bytes32 eth_tx_hash, uint32 eth_log_index, uint256 amount)
```

Calldata is the source triple identifying a single `Locked` event on Ethereum, plus the amount being claimed. The precompile does three things, in order:

1. Reject the call unless the caller equals the configured `bridge_operator_address`. This is a separate role from the genesis minter; misconfiguration that conflates the two raises at boot.
2. Compute `eth_event_id = keccak256(eth_chain_id ‖ eth_tx_hash ‖ eth_log_index)` and try to insert a row keyed on that id into the `bridge_mints` ledger. The primary key on `eth_event_id` guarantees a duplicate triple cannot mint twice.
3. If the insert succeeds, credit `amount` to the operator pool and emit `BridgeRefillMinted(eth_event_id, operator, amount)`.

There is no batching. One `refill_mint` per finalized `Locked` event, one event per refill. On free 2D transactions there is no economic pressure to amortize, and running the call per event keeps the supply invariant tight at every block.

The shape of the calldata is deliberate. An earlier design carried only the derived `eth_event_id` as a single `bytes32`. That made the id non-reversible at verifier time: the verifier needs the original `(chain_id, tx_hash, log_index)` triple to query Ethereum, and `keccak256` does not run backward. Storing the triple alongside the derived id keeps the verifier self-contained: every fact it needs to re-prove the mint lives in the block.

## What the verifier checks

The chain-side authorization on `BridgeRefillMint` is one check: the caller is the configured operator. That is enough to keep random users from minting, but it is nowhere near enough to guarantee that the cited event actually exists. A compromised operator key could call `refill_mint` with a fabricated triple and a bogus amount; the precompile would happily insert the row and credit the pool.

This is where the verifier earns its keep. After the producer executes a candidate block, but before the verifier accepts it, every new `bridge_mints` row gets an independent cross-chain check ([`lib/chain/verifier/cross_chain_check.ex`](https://github.com/igor53627/2d/blob/8b7caf2/lib/chain/verifier/cross_chain_check.ex)):

```elixir
def verify_block_refills(block_number) do
  block_number
  |> load_rows()
  |> Enum.reduce_while(:ok, &verify_row/2)
end

defp verify_row(row, :ok) do
  case EthereumRpc.verify_locked_event(
         row.eth_chain_id, row.eth_tx_hash,
         row.eth_log_index, Decimal.to_integer(row.amount)
       ) do
    {:ok, :verified} -> {:cont, :ok}
    {:error, reason} -> {:halt, {:error, :unbacked_refill_mint, ...}}
  end
end
```

Each row drives one Ethereum JSON-RPC roundtrip:

- `eth_getTransactionReceipt(tx_hash)` returns the receipt; the log at `log_index` is inspected.
- `eth_getBlockByNumber("finalized")` returns the highest finalized block number; the receipt's block must be at or below it.

The verifier rejects the row if any of these conditions fails:

| Reason | What it catches |
|---|---|
| `:not_found` | Receipt or log doesn't exist on Ethereum. |
| `:wrong_contract` | Log's address isn't the configured Ethereum HTLC contract. |
| `:wrong_event_signature` | Log's `topic[0]` isn't the canonical `Locked` event signature. |
| `:chain_id_mismatch` | RPC's chain id doesn't match the row's `eth_chain_id`. |
| `:amount_mismatch` | Log data's amount doesn't equal the claimed `amount`. |
| `:not_finalized` | Block exists but isn't yet at finality. |
| `:rpc_unreachable` / `:rpc_http_error` / `:malformed_response` | Defensive cases; treated as verification failure rather than success. |

A failure on any row aborts the block as `:unbacked_refill_mint`. The verifier rolls back its execution transaction (no external side effect, since the cross-chain RPC is read-only), refuses to commit, and flags the producer as a consensus violation source.

The ordering is load-bearing. The check runs **after** `BlockExecutor.execute_transactions` (so the new `bridge_mints` rows are visible inside the same SERIALIZABLE transaction) and **before** `Chain.StateRoot.compute`. Producer trust at include-time, verifier authority at finality. A compromised producer that includes an unbacked refill never reaches an honest user; every honest verifier rejects the block.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 180" role="img" aria-labelledby="cco-title cco-desc" style="width:100%;height:auto;max-width:640px;display:block;margin:1.5rem auto">
  <title id="cco-title">Cross-chain check ordering inside the verifier</title>
  <desc id="cco-desc">Three stages run in fixed order inside one SERIALIZABLE block-execution transaction: execute_transactions, then verify_block_refills via helios, then StateRoot.compute. Failure at any stage rolls back the whole block.</desc>
  <style>
    .cco-lbl  { font-family: ui-monospace,'SF Mono','JetBrains Mono',monospace; font-size: 12px; font-weight: 600; fill: currentColor; }
    .cco-ann  { font-family: ui-sans-serif,system-ui,sans-serif; font-size: 10px; fill: currentColor; opacity: 0.75; }
    .cco-frame{ font-family: ui-sans-serif,system-ui,sans-serif; font-size: 10px; fill: currentColor; opacity: 0.6; font-style: italic; }
    .cco-stage rect { stroke: currentColor; stroke-width: 1.5; fill: none; }
    .cco-stage      { opacity: 0.3; }
    .cco-arr        { stroke: currentColor; stroke-width: 1.5; fill: none; opacity: 0.5; }
    .cco-arr-head   { fill: currentColor; opacity: 0.5; }
    @keyframes cco-pop {
      0%, 28% { opacity: 1; }
      28.5%, 100% { opacity: 0.3; }
    }
    .cco-stage-1 { animation: cco-pop 6s infinite 0s; }
    .cco-stage-2 { animation: cco-pop 6s infinite 2s; }
    .cco-stage-3 { animation: cco-pop 6s infinite 4s; }
    @media (prefers-reduced-motion: reduce) {
      .cco-stage { opacity: 1; animation: none; }
    }
  </style>
  <text class="cco-frame" x="320" y="18" text-anchor="middle">inside one SERIALIZABLE block-execution transaction</text>
  <rect x="20" y="30" width="600" height="105" rx="4" stroke="currentColor" stroke-width="1" stroke-dasharray="4 4" fill="none" opacity="0.3"/>
  <g class="cco-stage cco-stage-1">
    <rect x="40" y="55" width="170" height="60" rx="6"/>
    <text class="cco-lbl" x="125" y="80" text-anchor="middle">execute_transactions</text>
    <text class="cco-ann" x="125" y="97" text-anchor="middle">credits, debits, inserts</text>
    <text class="cco-ann" x="125" y="109" text-anchor="middle">new bridge_mints rows</text>
  </g>
  <g class="cco-stage cco-stage-2">
    <rect x="235" y="55" width="170" height="60" rx="6"/>
    <text class="cco-lbl" x="320" y="80" text-anchor="middle">verify_block_refills</text>
    <text class="cco-ann" x="320" y="97" text-anchor="middle">helios → finalized check</text>
    <text class="cco-ann" x="320" y="109" text-anchor="middle">per new mint row</text>
  </g>
  <g class="cco-stage cco-stage-3">
    <rect x="430" y="55" width="170" height="60" rx="6"/>
    <text class="cco-lbl" x="515" y="80" text-anchor="middle">StateRoot.compute</text>
    <text class="cco-ann" x="515" y="97" text-anchor="middle">includes bridge_mints_root</text>
    <text class="cco-ann" x="515" y="109" text-anchor="middle">over all four tables</text>
  </g>
  <line class="cco-arr" x1="210" y1="85" x2="232" y2="85"/>
  <polygon class="cco-arr-head" points="232,85 226,82 226,88"/>
  <line class="cco-arr" x1="405" y1="85" x2="427" y2="85"/>
  <polygon class="cco-arr-head" points="427,85 421,82 421,88"/>
  <text class="cco-ann" x="320" y="160" text-anchor="middle">Failure at any stage rolls back the whole block. No partial state, no external side effect.</text>
</svg>

## Helios — what "Ethereum RPC" actually means

The verifier does not trust an Infura endpoint. `eth_getTransactionReceipt` and `eth_getBlockByNumber` from a remote RPC are RPC-level: the response could be anything the operator of that endpoint wants. A bridge that trusts a remote RPC for finality has, in effect, signed away its security to whoever runs that endpoint.

The production verifier instead points the JSON-RPC URL at a local **helios** sidecar. Helios is a light client for Ethereum: it tracks the beacon chain's sync committee, verifies headers cryptographically, and serves an `eth_*` JSON-RPC API backed by light-client-verified data. The trust assumption reduces to **"≥ 1/3 of the beacon sync committee is honest"**, the same threshold that secures Ethereum's finality itself.

In code, the dependency is a behaviour with two implementations ([`lib/chain/verifier/ethereum_rpc.ex`](https://github.com/igor53627/2d/blob/8b7caf2/lib/chain/verifier/ethereum_rpc.ex)):

```elixir
defmodule Chain.Verifier.EthereumRpc do
  @callback verify_locked_event(
              chain_id :: pos_integer(),
              tx_hash :: <<_::256>>,
              log_index :: non_neg_integer(),
              expected_amount :: pos_integer()
            ) :: {:ok, :verified} | {:error, error_reason()}
end
```

`Chain.Verifier.EthereumRpc.HTTP` makes real JSON-RPC calls against `:chain, :ethereum_rpc_url`, which in production points at a helios process running on the same host. `Chain.Verifier.EthereumRpc.Stub` returns a configurable canned response for tests. Selection is via `:chain, :ethereum_rpc_module` and is **fail-closed**: there is no compile-time default. If the application boots without `ETHEREUM_RPC_URL` set in production or without an explicit Stub configuration in tests, the verifier raises with a descriptive message rather than silently accepting any refill mint.

## Bridge-in / bridge-out walkthrough

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 460" role="img" aria-labelledby="bgi-title bgi-desc" style="width:100%;height:auto;max-width:640px;display:block;margin:1.5rem auto">
  <title id="bgi-title">Bridge-in sequence (Ethereum → 2D)</title>
  <desc id="bgi-desc">Six-step sequence diagram. Alice locks USDC on the Ethereum HTLC contract. The operator observes the event after finality, submits refill_mint on 2D, and locks the equivalent USD-stable on the 2D HTLC for Alice. Alice claims on 2D using the preimage; the operator then uses that preimage to claim the original USDC on Ethereum.</desc>
  <style>
    .bgi-lbl { font-family: ui-monospace,'SF Mono','JetBrains Mono',monospace; font-size: 11px; fill: currentColor; }
    .bgi-num { font-family: ui-sans-serif,system-ui,sans-serif; font-size: 11px; font-weight: 700; fill: currentColor; }
    .bgi-ann { font-family: ui-sans-serif,system-ui,sans-serif; font-size: 9px; fill: currentColor; opacity: 0.7; }
    .bgi-hdr { font-family: ui-sans-serif,system-ui,sans-serif; font-size: 12px; font-weight: 600; fill: currentColor; }
    .bgi-actor { stroke: currentColor; stroke-width: 1.2; fill: none; }
    .bgi-life  { stroke: currentColor; stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.35; }
    .bgi-step          { opacity: 0.25; }
    .bgi-step line     { stroke: currentColor; stroke-width: 2; fill: none; }
    .bgi-step polygon  { fill: currentColor; }
    @keyframes bgi-pop {
      0%, 14% { opacity: 1; }
      15%, 100% { opacity: 0.22; }
    }
    .bgi-step-1 { animation: bgi-pop 12s infinite  0s; }
    .bgi-step-2 { animation: bgi-pop 12s infinite  2s; }
    .bgi-step-3 { animation: bgi-pop 12s infinite  4s; }
    .bgi-step-4 { animation: bgi-pop 12s infinite  6s; }
    .bgi-step-5 { animation: bgi-pop 12s infinite  8s; }
    .bgi-step-6 { animation: bgi-pop 12s infinite 10s; }
    @media (prefers-reduced-motion: reduce) {
      .bgi-step { opacity: 1; animation: none; }
    }
  </style>
  <rect class="bgi-actor" x="20"  y="10" width="120" height="36" rx="4"/>
  <text class="bgi-hdr" x="80"  y="33" text-anchor="middle">Alice</text>
  <rect class="bgi-actor" x="180" y="10" width="120" height="36" rx="4"/>
  <text class="bgi-hdr" x="240" y="27" text-anchor="middle">Ethereum</text>
  <text class="bgi-hdr" x="240" y="41" text-anchor="middle">HTLC</text>
  <rect class="bgi-actor" x="340" y="10" width="120" height="36" rx="4"/>
  <text class="bgi-hdr" x="400" y="33" text-anchor="middle">Operator</text>
  <rect class="bgi-actor" x="500" y="10" width="120" height="36" rx="4"/>
  <text class="bgi-hdr" x="560" y="27" text-anchor="middle">2D</text>
  <text class="bgi-hdr" x="560" y="41" text-anchor="middle">precompiles</text>
  <line class="bgi-life" x1="80"  y1="50" x2="80"  y2="450"/>
  <line class="bgi-life" x1="240" y1="50" x2="240" y2="450"/>
  <line class="bgi-life" x1="400" y1="50" x2="400" y2="450"/>
  <line class="bgi-life" x1="560" y1="50" x2="560" y2="450"/>
  <g class="bgi-step bgi-step-1">
    <text class="bgi-num" x="22" y="98" text-anchor="start">1.</text>
    <line x1="84" y1="95" x2="234" y2="95"/>
    <polygon points="234,95 226,91 226,99"/>
    <text class="bgi-lbl" x="159" y="88" text-anchor="middle">lock(hash, USDC, deadline)</text>
  </g>
  <g class="bgi-step bgi-step-2">
    <text class="bgi-num" x="22" y="155" text-anchor="start">2.</text>
    <line x1="244" y1="148" x2="394" y2="148"/>
    <polygon points="394,148 386,144 386,152"/>
    <text class="bgi-lbl" x="319" y="141" text-anchor="middle">Locked event observed</text>
    <text class="bgi-ann" x="319" y="163" text-anchor="middle">at finalized block, ~12-15 min</text>
  </g>
  <g class="bgi-step bgi-step-3">
    <text class="bgi-num" x="22" y="218" text-anchor="start">3.</text>
    <line x1="404" y1="211" x2="554" y2="211"/>
    <polygon points="554,211 546,207 546,215"/>
    <text class="bgi-lbl" x="479" y="204" text-anchor="middle">refill_mint(triple, amount)</text>
    <text class="bgi-ann" x="479" y="226" text-anchor="middle">verifier rechecks via helios</text>
  </g>
  <g class="bgi-step bgi-step-4">
    <text class="bgi-num" x="22" y="285" text-anchor="start">4.</text>
    <line x1="404" y1="278" x2="554" y2="278"/>
    <polygon points="554,278 546,274 546,282"/>
    <text class="bgi-lbl" x="479" y="266" text-anchor="middle">lock(hash, Alice,</text>
    <text class="bgi-lbl" x="479" y="278" text-anchor="middle">amount, deadline)</text>
    <text class="bgi-ann" x="479" y="296" text-anchor="middle">on the 2D HTLC</text>
  </g>
  <g class="bgi-step bgi-step-5">
    <text class="bgi-num" x="22" y="350" text-anchor="start">5.</text>
    <line x1="84" y1="343" x2="554" y2="343"/>
    <polygon points="554,343 546,339 546,347"/>
    <text class="bgi-lbl" x="319" y="336" text-anchor="middle">claim(preimage)</text>
    <text class="bgi-ann" x="319" y="358" text-anchor="middle">P revealed on 2D chain</text>
  </g>
  <g class="bgi-step bgi-step-6">
    <text class="bgi-num" x="22" y="412" text-anchor="start">6.</text>
    <line x1="396" y1="405" x2="246" y2="405"/>
    <polygon points="246,405 254,401 254,409"/>
    <text class="bgi-lbl" x="321" y="398" text-anchor="middle">claim(preimage)</text>
    <text class="bgi-ann" x="321" y="420" text-anchor="middle">operator recovers original USDC</text>
  </g>
</svg>

Bridge-in (Ethereum → 2D):

1. **User locks on Ethereum.** Alice calls `lock(hash, amount, deadline)` on the Ethereum HTLC contract, escrowing `amount` USDC under `hash`.
2. **Operator waits for finality.** The orchestrator watches for the `Locked` event, polls `eth_getBlockByNumber("finalized")`, and waits until the lock's block number is at or below the finalized one. Roughly 12-15 minutes on Ethereum mainnet.
3. **Operator refills the 2D pool.** Operator submits `refill_mint(chain_id, tx_hash, log_index, amount)` to `0x2D00…0003`. The precompile inserts the row into `bridge_mints` and credits `amount` USD-stable to the operator's account. The verifier independently re-checks the Ethereum event on the next block; on success the block is committed, on failure the block is rejected.
4. **Operator locks on 2D.** Operator calls `lock(hash, Alice, amount, deadline)` on the 2D HTLC at `0x2D00…0001`, escrowing the same `amount` USD-stable under the same `hash`.
5. **Alice claims on 2D.** Alice's wallet calls `claim(preimage)` on the 2D HTLC. Because `sha256(preimage) = hash` and the deadline has not passed, the HTLC credits `amount` USD-stable to Alice.
6. **Operator claims on Ethereum.** The preimage is now visible on the 2D chain in the claim transaction's calldata and `HTLC_Claimed` log. Operator calls `claim(preimage)` on the Ethereum HTLC and recovers the USDC into the operator pool.

Bridge-out (2D → Ethereum) is symmetric, with the same role for the operator and the same preimage-driven settlement on both sides. The operator's accumulated USDC funds bridge-out payouts; if the operator runs out of USDC on Ethereum, bridge-out exits queue until inflows resume. There is no DoS vector that converts to a drain. Exits are delayed, never lost.

## Trust model summary

| Threat | Outcome |
|---|---|
| Operator key compromise | DoS only. The attacker can refuse to lock matching swaps, but cannot drain. There is no `unlock()` authority. |
| Malicious operator submits bogus `refill_mint` | Rejected by verifier. The cross-chain check fails one of `:not_found`, `:wrong_contract`, `:amount_mismatch`, `:not_finalized`. Block dropped. |
| Compromised producer includes an unbacked refill | Same path. Verifier rejects independently. The producer's claim never reaches honest users. |
| User fails to claim before deadline | Per-swap loss bound. `refund(hash)` returns funds to the original sender after the deadline. |
| Helios sidecar lies | Equivalent to ≥ 2/3 of the beacon sync committee being malicious. The whole Ethereum chain is at that point compromised; a bridge cannot do better than its underlying source-of-truth. |
| Remote Ethereum RPC compromise | Not applicable. The verifier never queries an external RPC; it queries the local helios sidecar, which validates against beacon-chain signatures. |
| Duplicate event submitted twice | Rejected at the chain side. `bridge_mints` PK on `eth_event_id` is committed in the [state root](../state-roots/), so a producer that bypassed the PK check would still be caught by the verifier's state-root recomputation. |

The bridge inherits Ethereum's economic security on the source side and 2D's verifier on the chain side. There is no third trust party: no validator federation, no oracle, no custodian.

## Where the bridge sits in the rest of the chain

The bridge composes three pieces documented separately. The verifier's [block-by-block recheck](../verifier/) extends to `bridge_mints` via the cross-chain hook described above. The [state-root layout](../state-roots/) commits the `bridge_mints` dedup invariant so a malicious producer cannot double-mint without breaking the chain hash. The HTLC primitive that does the actual settlement runs as a [precompile](../precompiles/); the bridge is a particular protocol layered on top of that primitive, not a contract deployed into a virtual machine.
