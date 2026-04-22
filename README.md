# 2D docs

Public documentation for [2D](https://github.com/igor53627/2d) — a Tron- and Ethereum-compatible, USDC-native L1 chain.

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
├── index.mdx                   # landing page
└── architecture/
    └── addresses.md            # Tron & Ethereum addresses in 2D
```

New articles go under `src/content/docs/<section>/<slug>.md`. Add them to the sidebar in `astro.config.mjs`.

## Contributing

PRs welcome. The `edit this page` link on every page opens the right file.

Code snippets should link to permalinks on the [2D repo](https://github.com/igor53627/2d) at a pinned commit SHA, not live branches — content shouldn't drift silently when `lib/` is refactored.
