---
id: TASK-1
title: Document OperatorVault and bridge operator policy in public docs
status: Done
assignee: []
created_date: '2026-05-08 00:00'
labels:
  - docs
  - bridge
  - security
dependencies:
  - "2d-solidity TASK-7 OperatorVault implementation"
  - "2d-solidity TASK-8 permissionless BridgeHTLC claim"
  - "2d TASK-60 verifier-side claimer allowlist"
references:
  - src/content/docs/architecture/bridge.mdx
  - src/content/docs/ru/architecture/bridge.mdx
  - https://github.com/igor53627/2d-solidity/blob/eb63ea4b6237dde539e9dd656734b8fb64a88b2d/src/BridgeHTLC.sol
  - https://github.com/igor53627/2d-solidity/blob/eb63ea4b6237dde539e9dd656734b8fb64a88b2d/src/OperatorVault.sol
  - https://github.com/igor53627/2d/blob/f7f9472d76d2dad1bfc22c5d52ce02b0a9b189f2/lib/chain/verifier/cross_chain_check.ex
  - https://github.com/igor53627/2d/blob/f7f9472d76d2dad1bfc22c5d52ce02b0a9b189f2/lib/chain/verifier/operator_allowlist.ex
priority: high
---

## Description

Update the public bridge documentation after `OperatorVault` lands in
`2d-solidity` and after `BridgeHTLC.claim` becomes permissionless. The docs
currently describe the EOA/signing-service mitigation and verifier-side claimer
allowlist, but the public release docs still need to explain the on-chain vault
policy, the cutover gate, and the steady-state operator model once bridge flows
emit `claimer = vault`.

## Scope

- English bridge architecture page.
- Russian bridge architecture page.
- Any index/sidebar copy needed to surface the bridge operator policy clearly.

## Acceptance Criteria

- [x] English docs describe `OperatorVault` as the Ethereum-side operator wallet:
      permissionless `claim(sender, hash, preimage)` can be called by any
      watcher and settles USDC to the configured claimer/vault, while
      `bridgeOut(destination, amount)` remains signing-key-gated and bounded by
      destination allowlist, per-transaction cap, and rolling 24h cumulative
      cap.
- [x] Russian docs contain the same public semantics, not a shorter summary.
- [x] Docs explain the two-role model: signing key only has privileged
      `bridgeOut` authority; `claim` finalization is permissionless; governance
      controls signing-key rotation, allowlist, caps, and upgrades.
- [x] Trust-model rows remove the old missed-claim/unbacked-mint outcome:
      once a preimage is public, any watcher can finalize Ethereum settlement
      before deadline and payout cannot be redirected away from `claimer`.
- [x] Docs state the release gate explicitly: the 2D verifier allowlist must
      include the deployed vault address before any dApp, orchestrator, or intent
      service emits `claimer = vault`.
- [x] Docs state that the verifier allowlist is append-only for replay
      determinism: `{oldEOA}` expands to `{oldEOA, vault}` and old locks stop
      being cited operationally, but old addresses are not removed from consensus
      verification as a normal migration step.
- [x] Docs link to pinned source references for `BridgeHTLC`, `OperatorVault`,
      and the relevant verifier-side implementation rather than mutable branch
      links.
- [x] `npm run build` passes.

## Progress Notes

- Updated EN/RU bridge architecture docs for 2d-solidity TASK-8:
  Ethereum-side claim finalization is permissionless, payout is fixed to the
  lock's configured claimer, and the Ethereum signing key only has privileged
  `bridgeOut` authority.
- Linked source references to pinned commits:
  2d-solidity `eb63ea4b6237dde539e9dd656734b8fb64a88b2d` and 2d
  `f7f9472d76d2dad1bfc22c5d52ce02b0a9b189f2`.
- Verification: `npm run build` passed on 2026-05-09.
