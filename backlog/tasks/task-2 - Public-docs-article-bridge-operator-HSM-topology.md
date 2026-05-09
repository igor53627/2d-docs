---
id: TASK-2
title: Public docs article — bridge operator HSM topology and confidential computing posture
status: In Progress
assignee:
  - "@igor"
created_date: '2026-05-09 07:24'
labels:
  - docs
  - bridge
  - hsm
  - public
dependencies:
  - "2d backlog/docs/doc-3 (deployment topology source of truth, merged in 2d#54)"
  - "2d-solidity TASK-7 / PR #14 OperatorVault (shipped)"
  - "2d TASK-59 signing-service allowlist (shipped)"
  - "2d TASK-60 verifier claimer-allowlist binding (shipped)"
references:
  - src/content/docs/architecture/hsm-topology.mdx
  - src/content/docs/ru/architecture/hsm-topology.mdx
  - https://github.com/igor53627/2d/blob/a12b553e48680173d1213a3724d7570a9d473184/backlog/docs/doc-3%20-%20Bridge-operator-deployment-topology-%E2%80%94-three-host-separation.md
  - https://github.com/igor53627/2d-solidity/blob/cb79c71ed5ec6b4d20e8a95fcbb3aaee0afa9a23/src/OperatorVault.sol
priority: medium
---

## Description

Public-facing companion to `architecture/bridge.mdx` that documents the
operational layer above the bridge primitive: how operator keys are held,
three-host topology, AMD SEV-SNP confidential computing for pre-mainnet,
defense-in-depth table, on-chain last line (`OperatorVault` + verifier
claimer-allowlist binding). Research-tone matching `bridge.mdx`. Public
statement of the "forever software-in-TEE pre-mainnet" policy as a
credibility signal — explicit, not aspirational. The internal source of
truth lives in the 2d repository at `backlog/docs/doc-3`; this article is
its public reflection.

## Scope

- English HSM topology page at `architecture/hsm-topology.mdx`.
- Russian HSM topology page at `ru/architecture/hsm-topology.mdx`.
- Astro/Starlight wiring: sidebar entry, mermaid SSR support
  (`rehype-mermaid` + headless chromium for build-time inline SVG).

## Acceptance Criteria

- [x] EN MDX article at `src/content/docs/architecture/hsm-topology.mdx`,
      research-tone matching the existing `bridge.mdx`. Sections in order:
      why operator keys are the weak point (one-paragraph callback to
      `bridge.mdx`); two operator keys plus producer key with namespace
      separation; three logical hosts (orchestrator / signing service /
      HSM root); confidential computing layer (AMD SEV-SNP, attestation,
      what it closes and what it does not); defense-in-depth table;
      what-survives-compromise table (no internal task numbers); on-chain
      last line (`OperatorVault` shipped, claimer-allowlist binding
      shipped); forever-software-in-TEE pre-mainnet policy with explicit
      rationale; trust model summary.
- [x] RU mirror at `src/content/docs/ru/architecture/hsm-topology.mdx` in
      Habr register. Keep `claim` / `lock` / `bridge_lock` / `HSM` /
      `namespace` / `payload` / `nonce` and crypto primitives in English;
      no literal calque. Title and description translated; technical terms
      anchored in English.
- [x] Three mermaid diagrams (text-based, rendered to inline SVG at build
      time): logical three-host topology (`flowchart` with distinct
      compromise-prone vs SEV-SNP styling), signing path (`sequenceDiagram`
      with host-grouped boxes orchestrator → OPA → Vault → NetHSM), and a
      cloud-style deployment diagram (`architecture-beta` with Iconify
      logos for Elixir, Vault, PostgreSQL, Ethereum). No hand-drawn SVG —
      `architecture-beta` replaces what would have been a separate hero
      image and avoids the visual overlap and style mismatch a custom SVG
      produces.
- [x] "Forever software-in-TEE pre-mainnet" policy stated explicitly in a
      dedicated subsection — including rationale (no real value at risk on
      pre-mainnet keys, identical orchestrator path between
      software-NetHSM-in-TEE and a physical appliance, mainnet HSM
      decision deferred to value-at-risk / regulatory / AMD PSP CVE
      landscape).
- [x] Public docs style enforced — no internal task numbers, no internal
      slang, no internal vendor pricing leaks. Em-dashes only where
      grammatically required. Cross-references to existing
      `architecture/bridge.mdx` and `architecture/verifier.md` where
      appropriate.
- [x] Starlight sidebar / navigation updated so the new article appears
      under the Architecture group in both EN and RU; sibling order with
      `bridge.mdx` and `verifier.md`.
- [x] `npm run build` passes; mermaid diagrams render to inline SVG in
      both EN and RU output.

## Progress Notes

- Initial article (EN + RU + sidebar wiring + `rehype-mermaid` setup +
  hand-drawn hero SVG) landed on branch `docs/hsm-topology` in commit
  `db16d04`.
- RU translation reworked to Habr register, EN typo fixed in commit
  `eafc5f3`. Hand-drawn SVG dropped in favour of an `architecture-beta`
  mermaid diagram in the same commit (the custom SVG had label/box
  overlap and a kustarny visual style that did not match the rest of the
  docs site).
- Mermaid diagram styling polish in commit `46c9702` — flowchart
  background/border for compromise-prone vs SEV-SNP, sequence diagram
  participant grouping via `box`, and Iconify-backed tech logos
  (Elixir / Vault / PostgreSQL / Ethereum) for the architecture-beta
  diagram.
- Build wiring: `rehype-mermaid` (SSR strategy `inline-svg` via headless
  chromium from playwright). No client-side JS for mermaid rendering.
- Style compliance: zero internal task references, no vendor pricing
  numbers (YubiHSM described as "small physical token / FIPS 140-2 L3"),
  em-dashes restricted to grammatically required positions.
- Branch `docs/hsm-topology` in this repo holds the work; the 2d
  internal task that originally tracked this work was archived after the
  task was moved here (it was about the public deliverable, which lives
  in this repo).
- Verification: `npm run build` passes; roborev review on the branch
  reports zero issues on the current head.

## Final Summary

(pending — fill in after PR review and merge.)
