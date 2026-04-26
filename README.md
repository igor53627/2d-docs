# 2D docs

[![Live](https://img.shields.io/badge/docs-online-blue)](https://igor53627.github.io/2d-docs/) [![Tests](https://img.shields.io/badge/tests-51%20passing-brightgreen)](https://igor53627.github.io/2d-ci/)

Public documentation for [2D](https://github.com/igor53627/2d): a Tron- and Ethereum-compatible L1 with a USD-stable base asset, instant finality, and gasless transactions.

Live site: **<https://igor53627.github.io/2d-docs/>**

Built with [Starlight](https://starlight.astro.build) (Astro). Deployed to GitHub Pages on every push to `main`.

## Local development

```sh
npm install
npm run dev        # http://localhost:4321/2d-docs/
```

## Structure

```
src/content/docs/
├── index.mdx                   # landing page (EN)
├── ru/index.mdx                # landing page (RU)
└── architecture/
    ├── addresses.md            # Tron & Ethereum addresses
    ├── precompiles.md          # custom logic without an EVM
    ├── state-roots.md          # client-side consensus
    ├── gasless.md              # free transactions + anti-spam
    ├── security.md             # trust boundaries
    └── verifier.md             # running an independent verifier
```

Russian translations live under `src/content/docs/ru/architecture/<slug>.md`. New articles go under `src/content/docs/<section>/<slug>.md` and are added to the sidebar in `astro.config.mjs`.

## Related

- [2D source](https://github.com/igor53627/2d) — the chain itself.
- [2D CI test report](https://igor53627.github.io/2d-ci/) — browser-friendly snapshots of the integration suite, with EN/RU explanations.

## Contributing

PRs welcome. The `edit this page` link on every page opens the right file.

Code snippets should link to permalinks on the [2D repo](https://github.com/igor53627/2d) at a pinned commit SHA, not live branches; content shouldn't drift silently when `lib/` is refactored.
