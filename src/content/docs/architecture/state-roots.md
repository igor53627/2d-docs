---
title: State roots — verifying the chain without validators
description: 2D has one block producer, not a validator set. State roots let any client independently verify that the producer computed the correct state.
---

Most blockchains rely on a set of validators to reach consensus on what the current state is. 2D has a single block producer. That makes block creation fast and simple, but it also means there is no built-in second opinion. If the producer is compromised, it could write whatever state it wants.

State roots fix this. After every block, the producer computes a cryptographic fingerprint of all mutable state and commits it into the block hash. Any client that replays the block's transactions against the previous state can independently recompute that fingerprint and compare. A mismatch means the producer lied. No validator set required.

## What goes into the state root

Three tables from the state schema, sorted by primary key, each row hashed with keccak256, then combined:

- **accounts** (address, balance, nonce). Every account that has ever received USDC.
- **htlc_swaps** (hash, sender, receiver, amount, deadline, status, preimage). Every active or terminal atomic-swap lock.
- **precompiles** (address, name, handler, enabled). The set of registered precompile contracts.

`blocks_tip` (the singleton that caches the current head pointer) is deliberately excluded. It is a convenience cache, not consensus state. Including it would create a circular dependency: the state root must be computed before the tip is updated, but the tip update happens in the same transaction.

The root itself:

```
accounts_root  = keccak256( row_hash(account_1) || row_hash(account_2) || ... )
htlc_root      = keccak256( row_hash(swap_1) || row_hash(swap_2) || ... )
precompiles_root = keccak256( row_hash(precompile_1) || ... )

state_root     = keccak256( accounts_root || htlc_root || precompiles_root )
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

Today, the state root is computed and stored. In a future phase, an independent verifier client will use it:

1. Receive the block (header + raw signed transactions) from the producer via an API feed.
2. Replay the transactions against its own copy of the previous state.
3. Compute its own state root.
4. Compare with the producer's claimed root.
5. If they match: serve the block's state to wallets and RPC clients.
6. If they don't: reject the block, alert, refuse to serve.

The verifier runs a separate process with its own database. It has no direct access to the producer's storage. Users connect to the verifier's RPC, not the producer's. Multiple verifiers can run independently. Anyone can run one.

## How blocks and transactions travel between nodes

The producer and verifier are two BEAM (Erlang VM) nodes connected via Erlang distribution. All data flows over a single encrypted channel. No HTTP, no external message queues.

**Blocks (producer to verifiers):** after each block's database transaction commits, the producer emits a block event through a GenStage pipeline. GenStage is an Elixir library for backpressure-aware producer-consumer flows. Every subscribed verifier receives every block (broadcast fan-out, not round-robin). If a verifier falls behind or disconnects, the producer buffers up to 1000 blocks; older ones are dropped, and the verifier catches up from its last known block on reconnect.

The block event carries the header (number, hash, parent hash, timestamp, state root, transactions root) plus the raw signed transactions in execution order. For Ethereum-format transactions, the raw bytes contain the signature, so the verifier can recover the sender independently. For Tron protobuf transactions (where signatures are discarded at ingest and only the unsigned protobuf is stored), the sender address is included explicitly.

**Transactions (users to producer):** users submit transactions to the verifier's RPC (the only public-facing endpoint). The verifier forwards each transaction to the producer via a fire-and-forget message over Erlang distribution. The producer writes it to its mempool and picks it up on the next block.

**The producer has no public ports.** It listens only on Erlang distribution (two ports, firewalled to the verifier's IP, TLS encrypted). All user-facing traffic goes through the verifier.

```
Users/Wallets/Explorer
        │
        ▼
   Verifier node (public RPC)
        │                  ▲
   txs (cast)         blocks (GenStage)
        │                  │
        ▼                  │
   Producer node (no public ports)
```

## Current approach and future scaling

The current implementation is a sorted-hash: it queries every row from each state table, sorts by primary key, hashes, and concatenates. This is O(n) per block over the full state size, which is fine for a chain with fewer than a million accounts.

When the state grows, the plan is to migrate to an incremental Merkle tree that updates only the rows that changed in the current block. That brings the per-block cost down to O(k log n) where k is the number of changed rows. The state root value stays the same (it is a property of the state, not the algorithm), so the migration is transparent to verifiers.

## Why this matters for cross-chain bridges

When 2D adds a bridge minter that creates 2D USD against USDT locked on Tron, the verifier can extend its checks: for every mint event on 2D, query Tron via RPC and verify that a matching HTLC lock exists with the same hash and amount. An unbacked mint (operator mints without real USDT backing) becomes detectable by every verifier, not just by trusting the operator. State roots make this possible by giving every client a verifiable view of what actually happened on-chain.
