---
title: Running a verifier node
description: How to deploy a verifier that independently replays every block, serves verified state to wallets, and rejects anything the producer got wrong.
---

A verifier is a read-only node that replays every block from the producer against its own copy of the state. If the state root or block hash does not match, it refuses the block and halts its services. Users and wallets connect exclusively to the verifier's RPC, never directly to the producer.

This article covers the practical aspects: configuration, the startup sequence, what is verified, and the procedures when a failure occurs. For the cryptographic details concerning state roots and block hashes, refer to [State roots](../state-roots/).

## Configuration

A verifier needs two config changes from a default (producer) node:

```elixir
# config/runtime.exs
config :chain,
  mode: :verifier,
  upstream_node: :"producer@10.0.0.1"
```

`mode: :verifier` changes what starts on boot:

| Component | Producer | Verifier |
|-----------|----------|----------|
| Genesis initialization | Yes | No (fetched from upstream) |
| Block producer | Yes | No |
| Transaction pool | Yes | No |
| Verifier syncer | No | Yes |
| RPC (eth_*, /wallet/*) | Internal only | Public-facing |
| BlockFeed (serves history) | Yes | Yes |
| BlockStage (live broadcast) | Yes | Yes |

The verifier needs its own database. It never shares storage with the producer.

## Startup sequence

On first boot with an empty database:

1. The syncer connects to the upstream node via Erlang distribution.
2. It asks the upstream node for its current tip, then fetches blocks in batches from its own last known block, verifying each one (catch-up).
3. Once caught up, it subscribes to the live block feed and processes blocks as they arrive.
4. For every subsequent block, the verifier replays all transactions, recomputes the state root and block hash, and commits only if both match.
5. Once caught up, the verifier processes live blocks as they arrive. Blocks already committed during catch-up are skipped by number.

If the upstream node is unreachable at boot, the syncer retries every 5 seconds.

## What the verifier checks

For every block (including genesis), the verifier independently verifies:

| Check | What it catches |
|-------|-----------------|
| **state_root** | Producer wrote state that doesn't follow from the transactions. Covers balances, HTLC swaps, precompile registrations, and `bridge_mints`. |
| **transactions_root** | Producer substituted, added, or removed transactions from the block. |
| **block_hash** | Any field in the block header was tampered with after construction. |
| **parent_hash** | Block doesn't chain correctly from the previous one. Fork detection. |
| **block_number** | Gaps in the sequence (skipped blocks). |
| **chain_id** | Cross-chain replay (transaction signed for a different network). |
| **sender recovery** | For Ethereum transactions, the sender is re-derived from the signature. For Tron transactions, the signature is re-verified against the claimed sender. |
| **genesis invariants** | Genesis timestamp and transactions root match the canonical constants. Prevents adversarial genesis forgery. |
| **bridge cross-chain check** | Every `bridge_mints` row is independently verified against finalized Ethereum state via JSON-RPC. For `bridge_lock` rows, the `receiverOn2D` from the Ethereum `Locked` event is compared to the HTLC receiver on 2D. See [Bridge](../bridge/) for the full verification table. |

A mismatch on state_root, transactions_root, or block_hash is a consensus violation. The verifier halts and refuses to serve. Operational errors (upstream temporarily down, gap in block sequence) trigger a catch-up retry.

## Verifier mode and RPC

A verifier rejects state-mutating RPC calls:

- `eth_sendRawTransaction` returns error code `-32601`
- `/wallet/broadcasttransaction` returns Tron error `OTHER_ERROR` (code 20)

All read-only methods work normally: `eth_getBalance`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`, `/wallet/getaccount`, etc. Wallets and explorers can point at a verifier without changes.

## Chained verifiers

Every verifier re-broadcasts verified blocks on its own block feed. A second verifier can subscribe to it instead of the producer:

```elixir
# Verifier B chains off Verifier A, not the producer
config :chain,
  mode: :verifier,
  upstream_node: :"verifier_a@10.0.0.2"
```

Each verifier independently replays every block regardless of where it received it from. The security model is the same: verify, then serve.

```
Producer ──▶ Verifier A ──▶ Verifier C
           ▶ Verifier B ──▶ Verifier D
```

## Network requirements

The producer and verifier connect via Erlang distribution. Two ports, both firewalled:

- **EPMD port** (4369 by default): the Erlang Port Mapper Daemon.
- **Distribution port** (configured via `inet_dist_listen_min` and `inet_dist_listen_max` in `vm.args` or kernel config): the actual data channel, TLS encrypted. The `RELEASE_DISTRIBUTION` environment variable controls the distribution mode (`name`/`sname`/`none`), not the port.

The producer exposes no public HTTP ports. All user traffic goes through the verifier.

```
Users ──▶ Verifier (port 4000, public) ──▶ Producer (Erlang dist only, firewalled)
```

## Failure modes

| Scenario | Verifier behavior |
|----------|-------------------|
| Upstream unreachable at boot | Retry catch-up every 5 seconds until connected |
| Upstream goes down mid-sync | Live events stop arriving; reconnect and catch-up on recovery |
| Block gap (missed blocks) | Automatic catch-up from upstream BlockFeed |
| state_root mismatch | Halt. Log critical warning. Stop serving RPC. |
| block_hash mismatch | Halt. Log critical warning. Stop serving RPC. |
| Nil raw transaction data | Block recorded as failed (status 0), no crash |

A halted verifier requires manual investigation. A mismatch means either the producer is compromised or there is a determinism bug in the executor. Both warrant human review.
