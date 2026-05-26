---
title: Bridge monitoring and auto-halt
description: How 2D exposes bridge safety state via Prometheus, and the four observability layers that an operator scrapes to detect canary failure, verifier rejection, and watchdog liveness loss.
---

A bridge is the single most attractive target in any cross-chain system. The 2D bridge defends with three in-process safety layers — verifier, canary, and watchdog — and exposes their state through a single Prometheus endpoint so an operator can wire automatic halts to Alertmanager.

This article describes what the bridge exposes, how an operator scrapes it, and the safety properties the metrics underwrite.

## The scrape endpoint

```
GET /admin/bridge/metrics
```

Plain-text Prometheus exposition format (`text/plain; version=0.0.4`). Mounted under the operator-internal admin URL prefix; deployments place that prefix behind a load-balancer ACL, k8s NetworkPolicy, or VPC security group. Prometheus scrapes from the same private network.

The endpoint reads from in-process memory only — a single `:persistent_term.get/2` call per scrape. No database query, no GenServer.call to any other process. The scrape completes in microseconds and cannot be blocked by a hung bridge component, which is the property that allows it to safely report on a partly-broken node.

## The four observability layers

### Layer 1 — refill-mint counter

Every successful bridge_lock execution increments `bridge_refill_mints_total`. This is the raw flow signal: how many bridge mints has this node processed since boot.

```
bridge_refill_mints_total 12734
```

A flat counter while user activity is expected is a primary signal that the bridge is halted, the node is partitioned, or the precompile is misconfigured.

### Layer 2 — verifier rejection counter

Every block where the cross-chain verifier rejected a bridge_lock increments `bridge_unbacked_bridge_mints_total{reason="…"}`. The `reason` label carries the specific atom from a bounded enumeration: source event not found, amount mismatch, non-finalized event, wrong contract, wrong event signature, chain-ID mismatch, HTLC binding failure, receiver-binding failure, refunded source-chain lock, claimer-allowlist failure, plus a small set of RPC-side transport errors.

A non-zero increase is unconditionally critical. The verifier rejecting a producer's mint means the producer included a bridge transaction that an honest verifier cannot confirm against the source chain. The recommended response is to halt and investigate per-source attribution before unhalting.

### Layer 3 — canary freshness

The canary is a periodic self-test runner that re-verifies a known-good bridge_lock event against a live Ethereum RPC. If the verification fails, the canary auto-halts the bridge.

The freshness metric exposes how long since the canary last completed a successful verification:

```
bridge_canary_last_success_seconds 47.3
```

When the canary has never published a heartbeat — either because it has not yet booted, or because the supervisor has not yet started it — the gauge reads a large finite sentinel value (≈31 years). This is a deliberate design: emitting an unset metric or a "missing" series would let alerts firing on `metric > threshold` silently fail to trigger when the canary is completely absent. A finite sentinel is always present in the scrape body and always exceeds any realistic threshold an operator picks.

### Layer 4 — watchdog liveness

The watchdog runs in a separate supervisor tree from the rest of the bridge. Its sole job is to confirm the canary is alive. If the canary stops publishing, the watchdog halts the bridge after a configurable number of missed heartbeats.

Four watchdog gauges expose this state:

```
bridge_watchdog_consecutive_failures 0
bridge_watchdog_tripped 0
bridge_watchdog_last_canary_heartbeat_seconds 47.3
bridge_watchdog_last_tick_seconds 12.1
```

The two timestamp metrics are intentionally distinct. `last_watchdog_tick_at` proves the watchdog process itself is alive. `last_canary_heartbeat_at` proves the canary process is alive AND reaching the verifier path. Conflating them into one timestamp would let a fresh watchdog tick mask a dead canary — an operator looking at one timestamp would see "the bridge is monitored" without noticing the verification path was offline. Two distinct fields force the operator dashboard to render both signals.

Same finite-sentinel pattern applies: a never-ticked watchdog or a never-published canary reads a ≈31-year stale value, never missing-data.

### Layer 5 — circuit state

The `bridge_circuit_state{tier}` gauge exposes the current halt state as a one-hot series — exactly one of `tier="none"`, `"yellow"`, `"red"`, `"black"` carries the value `1`, the others carry `0`:

```
bridge_circuit_state{tier="none"} 0
bridge_circuit_state{tier="yellow"} 1
bridge_circuit_state{tier="red"} 0
bridge_circuit_state{tier="black"} 0
```

This shape makes the Alertmanager rule `bridge_circuit_state{tier!="none"} == 1` an unambiguous "the bridge is non-green" predicate.

### Bonus — 24-hour volume

Two gauges aggregate bridge throughput over the last 24 hours: `bridge_inflow_24h_usdc` (sum of bridge mint amounts) and `bridge_outflow_24h_usdc` (sum of successfully-claimed bridge HTLC swaps). The aggregation runs every 30 seconds against the on-chain state tables; it is observational, not consensus-critical.

These gauges support volume-anomaly alerts. The default is an absolute threshold tuned per-deployment; operators with sufficient historical baseline data can substitute a σ-based recording rule.

## Self-observation

Two additional metrics surface the health of the collector itself:

- `bridge_metrics_collector_last_success_unix_seconds` — Unix epoch timestamp of the most recent poll where every collector succeeded. The associated PromQL alert is `time() - metric > threshold`; operators set the threshold to roughly 4× their poll interval.
- `bridge_metrics_collector_failures_total{collector}` — counter per failing sub-collector. Surfaces which specific collector is broken (database SUM, circuit-state read, canary read, watchdog read).

Without these signals, a hung poller would silently serve frozen `last_value` samples forever — the per-collector failure counter catches isolated failures, and the success timestamp catches total poller silence.

## Auto-halt integration

Alertmanager rules fire on each metric crossing its threshold and POST to the bridge's halt endpoint with an operator-supplied HMAC signature. The bridge precompile verifies the HMAC, writes the new circuit-state tier, and either blocks new bridge_locks (yellow tier) or rejects all bridge interactions (red and black tiers).

Each halt fires an audit log row identifying the source: a webhook-driven halt carries `set_by="alertmanager"` and `reason="alert:<RuleName>"`, distinct from a manually-initiated halt. The audit log is consulted during the un-halt process; multiple halt sources are reconciled before lifting the tier.

## Trust model

The metrics endpoint is unauthenticated at the application layer. The operator runbook places the `/admin/*` URL prefix behind a network ACL — a load-balancer rule, a NetworkPolicy, or a VPC security group. Prometheus scrapes from the same private network.

This trade-off ships an endpoint that's cheap to scrape on the default Prometheus 15-second cadence, at the cost of requiring an external network-layer defense. An attacker who reaches the endpoint via a server-side request forgery from elsewhere in the application, or via an internal-network pivot, can read the bridge's 24-hour inflow and outflow gauges — enough information to size a malicious transaction just under the daily cap. Operators concerned with this exposure should run the metrics scrape from a dedicated network namespace and audit the application's outbound HTTP surface for SSRF patterns.

## What the metrics do not expose

By design, the scrape body contains aggregates only. Individual bridge_lock event identifiers, HTLC swap hashes, claimer addresses, transaction hashes, and any other per-transaction data are NOT in the scrape. The bridge's audit log lives in the database (read separately by operator tooling on a different access path) and never crosses into the Prometheus surface.

The verifier rejection counter carries a `reason` label drawn from a bounded vocabulary; no metadata from the rejected event reaches the metric.

## Recommended scrape configuration

```yaml
- job_name: bridge_node
  scrape_interval: 15s
  scrape_timeout: 10s
  metrics_path: /admin/bridge/metrics
  static_configs:
    - targets: ["bridge.internal:4000"]
```

The 15-second cadence matches typical Prometheus defaults; the 30-second poller interval inside the bridge means roughly one fresh sample per two scrapes. Reducing the scrape interval below 15s does not yield fresher data — only more samples of the same value.

For Alertmanager wiring, the receiver targets the bridge node's halt endpoint with a per-deployment HMAC. The receiver template, the recommended threshold values, and the per-alert response runbook live in the operator-internal documentation that ships with the bridge binary.
