---
id: TASK-1
title: Document OperatorVault and bridge operator policy in public docs
status: To Do
assignee: []
created_date: '2026-05-08 00:00'
labels:
  - docs
  - bridge
  - security
dependencies:
  - "2d-solidity TASK-7 OperatorVault implementation"
  - "2d TASK-60 verifier-side claimer allowlist"
references:
  - src/content/docs/architecture/bridge.mdx
  - src/content/docs/ru/architecture/bridge.mdx
  - https://github.com/igor53627/2d-solidity/blob/main/src/OperatorVault.sol
priority: high
---

## Description

Update the public bridge documentation after `OperatorVault` lands in
`2d-solidity`. The docs currently describe the EOA/signing-service mitigation
and verifier-side claimer allowlist, but the public release docs still need to
explain the on-chain vault policy, the cutover gate, and the steady-state
operator model once bridge flows emit `claimer = vault`.

## Scope

- English bridge architecture page.
- Russian bridge architecture page.
- Any index/sidebar copy needed to surface the bridge operator policy clearly.

## Acceptance Criteria

- [ ] English docs describe `OperatorVault` as the Ethereum-side operator wallet:
      `claim(sender, hash, preimage)` forwards to `BridgeHTLC`, while
      `bridgeOut(destination, amount)` is bounded by destination allowlist,
      per-transaction cap, and rolling 24h cumulative cap.
- [ ] Russian docs contain the same public semantics, not a shorter summary.
- [ ] Docs explain the two-role model: signing key can only execute bounded
      operational actions; governance controls signing-key rotation, allowlist,
      caps, and upgrades.
- [ ] Docs state the release gate explicitly: the 2D verifier allowlist must
      include the deployed vault address before any dApp, orchestrator, or intent
      service emits `claimer = vault`.
- [ ] Docs state that the verifier allowlist is append-only for replay
      determinism: `{oldEOA}` expands to `{oldEOA, vault}` and old locks stop
      being cited operationally, but old addresses are not removed from consensus
      verification as a normal migration step.
- [ ] Docs link to pinned source references for `BridgeHTLC`, `OperatorVault`,
      and the relevant verifier-side implementation rather than mutable branch
      links.
- [ ] `npm run build` passes.
