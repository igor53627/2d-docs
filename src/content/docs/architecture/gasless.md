---
title: Gasless transactions and anti-spam
description: All transactions on the 2D network are free. Spam is prevented by an exponential delay that only affects high-frequency senders.
---

Every transaction on the 2D network is free. There is no gas price, no fee market, no EIP-1559 base fee. The `effectiveGasPrice` field in receipts is always zero (and `gasPrice` on transaction objects is zero too). Wallets show zero cost.

This is possible because 2D operates as a single-producer chain, eliminating the need for a block space auction. The producer includes every valid transaction in the next block, subject to a single constraint: anti-spam throttling.

## How throttling works

The block producer tracks the number of transactions each sender address submits within a sliding window (default: 10 minutes). If a sender remains under the threshold (default: 10 transactions per window), their transactions are included immediately.

If a sender exceeds the threshold, each additional transaction gets an exponential delay before it can be included:

| Txs over threshold | Delay |
|---------------------|-------|
| 1 | 2 seconds |
| 2 | 4 seconds |
| 3 | 8 seconds |
| 4 | 16 seconds |
| 5 | 32 seconds |
| ... | ... |
| max | 1 hour (cap) |

The transaction is not rejected; instead, it remains in the pending pool and is included once the delay expires. The sender observes a "pending" status in their wallet, and the transaction eventually confirms.

Old transactions naturally fall out of the sliding window. If a sender stops submitting transactions for 10 minutes, their count resets to zero, and their next transaction is processed instantly.

## What wallets see

From a wallet's perspective, 2D behaves like any EVM chain with a gas price of zero:

- `eth_gasPrice` returns `0x0`
- `eth_estimateGas` returns a constant `0x5208` (21000) for every input — wallets need a non-zero number to render the "estimated fee" field, but no gas is metered or charged
- Transaction receipts show `gasUsed` and `effectiveGasPrice = 0`
- No balance is deducted for gas, only for the transfer value

MetaMask, TronLink, and other wallets work without configuration changes. The gas fields are present (required by the JSON-RPC spec) but always zero-valued.

## Why throttling is not consensus

Throttling is exclusively a producer-side concern. It determines when a transaction is included in a block, not its validity. The verifier does not execute any throttle logic; it replays every block exactly as received and verifies the state root.

Consequently, throttle parameters (window size, threshold, delay curve) can be adjusted without requiring a protocol upgrade. Different producers could employ different parameters. The chain's consensus remains constant: fees are always zero, every included transaction is valid, and the state root is deterministic.

## Revenue model

With no transaction fees, 2D's revenue comes from other sources:

- Float yield on USDC deposits held by the chain
- Business API subscriptions for high-throughput integrations
- Bridge-out fees for withdrawing USDC back to Tron or Ethereum
