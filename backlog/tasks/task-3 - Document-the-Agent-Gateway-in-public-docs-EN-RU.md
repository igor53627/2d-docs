---
id: TASK-3
title: Document the Agent Gateway in public docs (EN + RU)
status: Done
assignee:
  - "@igor"
created_date: '2026-06-20 13:00'
labels:
  - docs
  - agent-gateway
  - public
dependencies:
  - "2d TASK-132.3 (read-only agent gateway + RPC proxy)"
  - "2d TASK-132.5 / 132.5.2 (2d-hsm signer, transfer-key pool, identity provisioning)"
  - "2d TASK-132.5.2.5 / TASK-179 (live-identity flip + canary gate)"
  - "2d TASK-132.8 (agent gateway operator runbook, doc-13)"
references:
  - src/content/docs/architecture/agent-gateway.mdx
  - src/content/docs/ru/architecture/agent-gateway.mdx
  - https://github.com/igor53627/2d/blob/f646a0be630bd7feaf98263f44a73c3fd04d05c6/lib/chain_web/controllers/agent_gateway_controller.ex
  - https://github.com/igor53627/2d/blob/f646a0be630bd7feaf98263f44a73c3fd04d05c6/backlog/docs/doc-13%20-%20Agent-Gateway-operator-runbook.md
priority: medium
---

## Description

Public architecture article documenting the Agent Gateway: keyless
programmatic access to 2D for autonomous agents. Companion to the bridge
and HSM-topology articles, matching their research tone. The internal
source of truth is `doc-13` in the `2d` repository; this article is its
public reflection, scoped to what is actually shipped.

The design thesis: an agent never holds a signing key. It holds a bearer
capability token over a per-agent assigned wallet whose key lives in a
2d-hsm TEE enclave (distinct from the bridge operator's NetHSM), and
writes are re-checked and signed inside the enclave under operator
policy. A proof-of-possession check pairs the token with the enclave-held
key, so a stolen token cannot impersonate the wallet.

## Scope

- English article at `architecture/agent-gateway.mdx`.
- Russian mirror at `ru/architecture/agent-gateway.mdx` (Habr register,
  technical terms and crypto primitives kept in English).
- Starlight sidebar entry, placed in the Architecture group between
  `pq-signing-tee` and `verifier` (shares the 2d-hsm TEE signer concept).

## Acceptance Criteria

- [x] EN article documents the shipped read-only surface: `GET /agent/v1/network`,
      `GET /agent/v1/balance`, `POST /agent/v1/rpc` (read-only JSON-RPC proxy),
      including the fixed method allowlist and batch/size caps.
- [x] EN article documents the authorization model: bearer token + closed
      `:read` capability enum, fail-closed auth, dual-layer rate limit
      (pre-auth IP brute-force + post-auth per-agent runaway), master switch.
- [x] EN article documents assigned wallets, the 2d-hsm enclave (separate
      from the bridge operator NetHSM), transfer-key pool provisioning
      (`FOR UPDATE SKIP LOCKED`), and the CBOR-over-framing transport.
- [x] EN article documents proof-of-possession (EIP-191-style 0x19 domain
      separation, `2d-hsm/agent-identity-proof/v1`, chain_id + env + pubkey
      + address binding, secp256k1 EIP-2 low-S).
- [x] EN article documents the live-identity flip, the mandatory canary,
      and IdentitySweep failure classification (only `:destructive` disables).
- [x] EN article states explicitly what is NOT shipped: faucet/transfer
      write endpoints and the restore-drill ceremony. Per 2d TASK-132.8
      AC#7, the published doc must not advertise an unimplemented endpoint.
- [x] RU mirror contains the same semantics, not a shorter summary.
- [x] Public-docs style enforced: no internal task numbers, no internal
      slang, no `doc-13` references in the article body. Source references
      pinned to immutable commit `f646a0be…`, not mutable branch links.
- [x] Sidebar / navigation entry added under Architecture in both EN and RU.
- [x] `npm run build` passes; both pages render.

## Progress Notes

- 2026-06-20 review of 50 closed 2d PRs (#156–#205, prior two weeks)
  surfaced ~30 agent-gateway PRs; the subsystem had reached a
  documentable steady state on the read surface. Decision: publish the
  public article now, scoped to shipped surface only.
- Source mapping: `agent_gateway_controller.ex`, `rpc_proxy.ex`,
  `agent_auth.ex`, `agent_rate_limit.ex`, `identity_provisioner.ex`,
  `signer_protocol/identity_proof.ex`, `signer_protocol/capability.ex`,
  plus the operator runbook (`doc-13`). Pinned source links verified
  present at `f646a0be630bd7feaf98263f44a73c3fd04d05c6`.
- Build wiring: bumped `playwright` devDependency `^1.59.1 → 1.60.0`
  so its expected chromium-headless-shell revision (1223) matches the
  browser already cached locally; unblocks `rehype-mermaid` inline-svg
  SSR. Build green: 25 pages, including both agent-gateway routes.
- Deliberate non-goals: faucet write endpoint (`POST /agent/v1/faucet`,
  2d TASK-132.6), transfer write endpoint (`POST /agent/v1/transfer`,
  2d TASK-132.7), and the production restore-drill ceremony
  (2d TASK-132.5.3) are blocked / `To Do` and explicitly excluded from
  the article. When they land, this article gains a write-surface
  section and the "What is not available yet" section shrinks.
