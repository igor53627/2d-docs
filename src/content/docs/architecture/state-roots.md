---
title: State roots — verifying the chain without validators
description: 2D has one block producer, not a validator set. State roots let any client independently verify that the producer computed the correct state.
---

Most blockchains rely on a set of validators to reach consensus on what the current state is. 2D has a single block producer. That makes block creation fast and simple, but it also means there is no built-in second opinion. If the producer is compromised, it could write whatever state it wants.

State roots fix this. After every block, the producer computes a cryptographic fingerprint of all mutable state and commits it into the block hash. Any client that replays the block's transactions against the previous state can independently recompute that fingerprint and compare. A mismatch means the producer lied. No validator set required.

## What goes into the state root

Four tables from the state schema, sorted by primary key, each row hashed with keccak256, then combined:

- **accounts** (address, balance, nonce). Every account that has ever received USD-stable.
- **htlc_swaps** (hash, sender, receiver, amount, deadline, status, preimage). Every active or terminal atomic-swap lock.
- **precompiles** (address, name, handler, enabled). The set of registered precompile contracts.
- **bridge_mints** (eth_event_id, source triple, amount, applied block coordinates). One row per Ethereum `Locked` event the operator has refilled against. Inclusion is load-bearing: without it the dedup invariant would live only inside the table, and a producer could double-mint while still matching an honest verifier's replay. See the [bridge article](../bridge/) for the cross-chain check that re-validates each row.

`blocks_tip` (the singleton that caches the current head pointer) is deliberately excluded. It is a convenience cache, not consensus state. Including it would create a circular dependency: the state root must be computed before the tip is updated, but the tip update happens in the same transaction.

The root itself:

```
accounts_root     = keccak256( row_hash(account_1) || row_hash(account_2) || ... )
htlc_root         = keccak256( row_hash(swap_1) || row_hash(swap_2) || ... )
precompiles_root  = keccak256( row_hash(precompile_1) || ... )
bridge_mints_root = keccak256( row_hash(mint_1) || ... )

state_root        = keccak256( accounts_root || htlc_root || precompiles_root || bridge_mints_root )
```

Each row hash encodes fields in a canonical binary layout (fixed-width integers, length-prefixed strings, normalized Decimals). Two arithmetically-equal balances always produce the same bytes, regardless of how the Decimal was constructed internally.

## How the block hash commits to it

Every block's hash is now:

```
block_hash = keccak256(
    block_number   (8 bytes)
 || parent_hash    (32 bytes)
 || timestamp      (8 bytes)
 || tx_root        (32 bytes, hash of all tx hashes in execution order)
 || state_root     (32 bytes, the Merkle root above)
)
```

This means changing any account balance, any HTLC status, or any precompile registration without a corresponding valid transaction changes the state root, which changes the block hash, which breaks the parent-hash chain for every subsequent block. A single tampered row cascades into a detectable chain break.

## What a verifier does with this

The chain ships an independent verifier client. For every block, it:

1. Receives the block (header + raw signed transactions) from the upstream node.
2. Replays the transactions against its own copy of the previous state.
3. Computes its own state root.
4. Compares with the producer's claimed root.
5. If they match: commits the block and serves the verified state to wallets and RPC clients.
6. If they don't: rolls back, logs a critical alert, refuses to serve.

The verifier runs as a separate BEAM node with its own database. It has no direct access to the producer's storage. Users connect to the verifier's RPC, not the producer's. Multiple verifiers can run independently. Anyone can run one.

A verifier that commits a block re-broadcasts it on its own block feed. Other verifiers can subscribe to it instead of the producer directly. This means verifiers can form a chain or a tree:

```
Producer ──▶ Verifier A ──▶ Verifier C
           ▶ Verifier B ──▶ Verifier D
```

Each verifier independently verifies every block regardless of where it received it from. The trust model is the same whether the upstream is the producer or another verifier: verify, then serve.

## How blocks and transactions travel between nodes

The producer and verifier are two BEAM (Erlang VM) nodes connected via Erlang distribution. All data flows over a single encrypted channel. No HTTP, no external message queues.

**Blocks (producer to verifiers):** after each block's database transaction commits, the producer emits a block event through a GenStage pipeline. GenStage is an Elixir library for backpressure-aware producer-consumer flows. Every subscribed verifier receives every block (broadcast fan-out, not round-robin). If a verifier falls behind or disconnects, the producer buffers up to 1000 blocks; older ones are dropped.

When a verifier starts (or reconnects after a gap), it catches up before subscribing to the live feed. It asks the upstream node for its current tip, then fetches blocks in batches from its own last known block, verifying each one. Once caught up, it switches to the live GenStage subscription. The same mechanism works whether the upstream is the producer or another verifier.

The block event carries the header (number, hash, parent hash, timestamp, state root, transactions root) plus the raw signed transactions in execution order. For Ethereum-format transactions, the raw bytes contain the signature, so the verifier can recover the sender independently. For Tron protobuf transactions (where signatures are discarded at ingest and only the unsigned protobuf is stored), the sender address is included explicitly.

**Transactions (users to producer):** users submit transactions to the verifier's RPC (the only public-facing endpoint). The verifier forwards each transaction to the producer via a fire-and-forget message over Erlang distribution. The producer writes it to its mempool and picks it up on the next block.

**The producer has no public ports.** It listens only on Erlang distribution (two ports, firewalled to the verifier's IP, TLS encrypted). All user-facing traffic goes through the verifier.

```
Users/Wallets/Explorer
        │
        ▼
   Verifier (public RPC)
        │                  ▲
   txs (cast)         blocks (GenStage)
        │                  │
        ▼                  │
   Producer (no public ports)
```

Additional verifiers can chain off the first one instead of connecting to the producer directly. Each verifier re-broadcasts verified blocks, so the topology can be a star, a chain, or a tree depending on the deployment.

## Current approach and future scaling

The current implementation is a sorted-hash: it queries every row from each state table, sorts by primary key, hashes, and concatenates. This is O(n) per block over the full state size, which is fine for a chain with fewer than a million accounts.

When the state grows, the plan is to migrate to an incremental Merkle tree that updates only the rows that changed in the current block. That brings the per-block cost down to O(k log n) where k is the number of changed rows. The state root value stays the same (it is a property of the state, not the algorithm), so the migration is transparent to verifiers.

## Why this matters for cross-chain bridges

The first concrete consumer of this property is the [bridge](../bridge/). For every refill the operator submits, the verifier independently queries the cited Ethereum event through a local helios sidecar and rejects the block if anything fails to match. State roots make this possible by giving every client a verifiable view of what actually landed on-chain: the `bridge_mints` row, with its source triple, dedup id, and amount, is hashed into the chain and cannot be quietly rewritten by a compromised producer.
