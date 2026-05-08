# AGENTS.md instructions for 2d-docs

<INSTRUCTIONS>
## Documentation Sync

- Treat this repository as the public documentation surface for 2D. When behavior,
  security assumptions, deployment steps, verifier checks, bridge/operator flows,
  public APIs, or runtime configuration change in the `2d` or `2d-solidity`
  repositories, update the matching public docs here in the same task when
  practical.
- If the public docs cannot be updated in the same task, create or update a
  backlog task in `backlog/tasks/` before finalizing the source-repository
  change. The task must name the source repo task or commit and the docs pages
  that need updates.
- Keep English and Russian pages synchronized for public-facing semantics. Do not
  update only one locale unless the matching-locale work is explicitly captured
  in backlog.
- For bridge, verifier, and operator-security changes, document the operational
  release gate and trust boundary, not just the code diff.
</INSTRUCTIONS>
