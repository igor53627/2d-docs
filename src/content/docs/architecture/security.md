---
title: Security model
description: How 2D protects against common attack vectors — input validation, replay prevention, anti-spam, and the trust boundaries between producer, verifier, and wallets.
---

2D has one block producer and one or more independent verifiers. This is a simpler trust model than a validator set, but it still has boundaries that need defending. This page documents the attack vectors we considered and how each is handled.

## Trust boundaries

There are four boundaries where untrusted input enters the system:

1. **User to RPC** — wallets submit signed transactions via `eth_sendRawTransaction` or `/wallet/broadcasttransaction`. Input is untrusted hex, any size, any content.
2. **RPC to executor** — validated transactions sit in `pending_transactions` until the producer picks them up. The executor re-verifies sender identity from the signature.
3. **Producer to verifier** — the verifier receives blocks over Erlang distribution. It trusts nothing: replays every transaction, recomputes every hash.
4. **User to precompile** — calldata to precompile contracts (HTLC, future account settings) is parsed and validated per-contract.

## Input validation at the RPC layer

Every transaction goes through several checks before reaching the pending pool:

| Check | What it catches |
|-------|-----------------|
| Hex decode | Malformed input, non-hex characters |
| Size limit (128 KB) | DoS via oversized payloads. Checked before decoding. |
| RLP / protobuf decode | Structurally invalid transactions |
| Chain ID | Cross-chain replay (tx signed for Ethereum mainnet sent to 2D) |
| Signature recovery | Invalid signatures, malleable signatures (EIP-2 s-value) |
| Nonce validation | Stale nonces rejected (nonce < account nonce). Future nonces capped at +100. |

Malformed addresses and topics in `eth_getLogs` return error responses instead of crashing the handler.

## Replay and nonce protection

Each account has a sequential nonce. The executor checks that the transaction nonce matches the current account nonce exactly. A transaction cannot execute twice because the nonce increments after each execution.

Cross-chain replay is blocked at both the RPC layer and the executor: transactions must carry the correct chain ID (11565 for 2D). Pre-EIP-155 transactions (no chain ID) are rejected.

Duplicate transaction hashes are handled with `ON CONFLICT DO NOTHING` at insertion. Submitting the same signed transaction twice has no effect.

## Anti-spam throttle

All transactions are free (fee = 0). Spam is prevented by an exponential delay applied at the block producer level. See [Gasless transactions](../gasless/) for details.

The throttle operates at the SQL level: addresses that exceed the rate threshold are excluded from the pending query entirely, preventing a single spammer from blocking other users' transactions (head-of-line blocking prevention).

Stale pending transactions (older than 10 minutes) are automatically cleaned up.

## Signature verification

Sender identity is verified cryptographically, never trusted from user input:

- **Ethereum transactions**: sender is recovered from the ECDSA signature via `secp256k1` recovery. The recovered address is used for all balance and nonce operations.
- **Tron transactions**: the signature is stored alongside the raw protobuf. At execution time, the sender is re-derived from `sha256(raw_data) + signature` and compared against the stored sender address. Mismatches are rejected.

Signature components (r, s) longer than 32 bytes are rejected before padding. High-s signatures (EIP-2 malleability) are rejected at both the RPC and executor layers.

## Verifier independence

The verifier trusts nothing from the producer. For every block, it independently:

- Derives transaction hashes from raw bytes (does not trust the producer's claimed hashes)
- Recomputes the state root from its own database
- Verifies the transactions root, state root, and block hash
- For genesis: pins canonical timestamp and transactions root to known constants

A mismatch on any of these causes the verifier to halt and refuse to serve. See [Running a verifier](../verifier/) for operational details.

## Database constraints

The append-only history is protected by PostgreSQL rules that silently discard UPDATE and DELETE operations on the blocks and transactions tables. The state schema uses SERIALIZABLE isolation for all block execution, preventing race conditions between concurrent transactions.

## What is not covered yet

- **Privacy**: balances and transfer amounts are visible to anyone running a verifier. See the project roadmap for the privacy layer design.
- **HSM block signing**: the producer's signing key is currently a software key. Hardware security module support is planned.
