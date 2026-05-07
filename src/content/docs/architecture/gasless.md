---
title: Gasless transactions and anti-spam
description: All transactions on 2D are free. Spam is prevented by an exponential delay that only affects high-frequency senders.
---

Every transaction on 2D is free. There is no gas price, no fee market, no EIP-1559 base fee. The `effectiveGasPrice` field in receipts is always zero (and `gasPrice` on transaction objects is zero too). Wallets show zero cost.

This is possible because 2D is a single-producer chain. There is no block space auction. The producer includes every valid transaction in the next block, subject to one constraint: anti-spam throttling.

## How throttling works

The producer tracks how many transactions each sender address has submitted in a sliding window (default: 10 minutes). If a sender stays under the threshold (default: 10 txs in the window), their transactions are included immediately.

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

The transaction is not rejected. It stays in the pending pool and gets included once the delay expires. The sender sees a "pending" status in their wallet, and the transaction eventually confirms.

Old transactions naturally fall out of the sliding window. If a sender stops submitting for 10 minutes, their count resets to zero and the next transaction goes through instantly.

## What wallets see

From a wallet's perspective, 2D behaves like any EVM chain with a gas price of zero:

- `eth_gasPrice` returns `0x0`
- `eth_estimateGas` returns a constant `0x5208` (21000) for every input — wallets need a non-zero number to render the "estimated fee" field, but no gas is metered or charged
- Transaction receipts show `gasUsed` and `effectiveGasPrice = 0`
- No balance is deducted for gas, only for the transfer value

MetaMask, TronLink, and other wallets work without configuration changes. The gas fields are present (required by the JSON-RPC spec) but always zero-valued.

## Why throttling is not consensus

Throttling is a producer-only concern. It affects when a transaction gets included in a block, not whether the transaction is valid. The verifier does not run any throttle logic. It replays every block as-is and verifies the state root.

This means throttle parameters (window size, threshold, delay curve) can be tuned without a protocol upgrade. Different producers could use different parameters. The chain's consensus is: fee is always zero, every included transaction is valid, the state root is deterministic.

## Revenue model

With no transaction fees, 2D's revenue comes from other sources:

- Float yield on USDC deposits held by the chain
- Business API subscriptions for high-throughput integrations
- Bridge-out fees for withdrawing USDC back to Tron or Ethereum
