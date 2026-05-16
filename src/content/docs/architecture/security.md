---
title: Security model
description: How 2D protects against common attack vectors — input validation, replay prevention, anti-spam, and the trust boundaries between producer, verifier, and wallets.
---

2D operates with a single block producer and one or more independent verifiers. While this trust model is simpler than a traditional validator set, it still contains boundaries that require defense. This page documents the considered attack vectors and how each is mitigated.

## Trust boundaries

There are four primary boundaries where untrusted input enters the system:

1. **User to RPC** — Wallets submit signed transactions via `eth_sendRawTransaction` or `/wallet/broadcasttransaction`. The input is untrusted hex; Ethereum raw transactions are size-capped before decoding, and Tron protobuf payloads are decoded and structurally validated before being enqueued.
2. **RPC to executor** — Validated transactions reside in the `pending_transactions` pool until the producer processes them. The executor re-verifies the sender's identity using the signature.
3. **Producer to verifier** — The verifier receives blocks via Erlang distribution. It operates on a zero-trust basis: replaying every transaction and independently recomputing every hash.
4. **User to precompile** — Calldata directed to precompile contracts (such as HTLC or bridge refill/mint) is parsed and validated on a per-contract basis.

## Input validation at the RPC layer

Every transaction goes through several checks before reaching the pending pool:

| Check | What it catches |
|-------|-----------------|
| Hex decode | Malformed input, non-hex characters |
| Ethereum raw size limit (4 KB) | DoS via oversized `eth_sendRawTransaction` payloads. Checked before decoding. |
| RLP / protobuf decode | Structurally invalid transactions |
| Chain ID | Cross-chain replay (tx signed for Ethereum mainnet sent to 2D) |
| Signature recovery | Invalid signatures, malleable signatures (EIP-2 s-value) |
| Nonce validation | Stale nonces rejected (nonce < account nonce). Future nonces capped at +100. |

Malformed addresses and topics in `eth_getLogs` return error responses instead of crashing the handler.

## Replay and nonce protection

Each account maintains a sequential nonce. The executor verifies that the transaction nonce matches the current account nonce exactly. A transaction cannot be executed twice because the nonce increments immediately after execution.

Cross-chain replay attacks are blocked at both the RPC layer and the executor: transactions must include the correct chain ID (11565 for 2D). Pre-EIP-155 transactions (which lack a chain ID) are strictly rejected.

Duplicate transaction hashes are managed using `ON CONFLICT DO NOTHING` during database insertion. Submitting the identical signed transaction multiple times has no additional effect.

## Anti-spam throttle

All transactions are free (fee = 0). Spam is prevented by an exponential delay applied at the block producer level. See [Gasless transactions](../gasless/) for details.

The throttle is a per-sender cooldown, not a hard exclusion. When a sender's count exceeds the threshold inside the sliding window, only that sender's pending rows are skipped during the cooldown window — once the per-sender delay elapses, their next transaction becomes eligible again. Other senders are unaffected (head-of-line blocking prevention), and a throttled sender's queue drains gradually instead of stalling until the sliding window slides.

Tron transactions carry a wallet-set `expiration` (typically 30–60 seconds). If a Tron pending row is held back past its expiration, the producer drops it from the pending pool before block execution rather than persisting a noisy `status=error` record — there is no useful information in "this was throttled past its validity window" beyond the chain-internal scheduling outcome.

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
- **HSM-backed block signing**: the producer's signing key is not yet wired through the chain runtime's HSM path. The pre-mainnet operator topology is documented in [HSM topology](../hsm-topology/).
