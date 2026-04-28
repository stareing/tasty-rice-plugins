# Tasty Rice Plugins

Standalone repo (`stareing/tasty-rice-plugins`) for self-published browser
extensions, desktop addons, CLIs, and small utilities. Surfaced on the main
site via `my-blog/apps/web` → `/apps`.

This workspace lives at `my-blog/plugins/` for editing convenience but is its
own git repo — no shared history with `my-blog`.

## Layout

```
plugins/
├── package.json            # npm workspace root (workspaces: ["*"])
├── tsconfig.base.json      # shared TS compiler options — extend per-plugin
├── README.md               # you are here
└── <plugin-slug>/          # one directory per plugin (slug = /apps URL slug)
    ├── package.json
    ├── tsconfig.json       # extends ../tsconfig.base.json
    └── src/
```

## Conventions

- **Directory name = `apps.ts` slug.** The `/apps/[slug]` page in the main
  site resolves source links by joining the slug with this repo's GitHub tree
  URL, so they must match exactly.
- **One plugin = one product.** No shared `src/` across plugins — if two need
  to share code, extract a real package instead of cross-importing.
- **Each plugin owns its build output.** `dist/` is gitignored per-plugin; the
  workspace root never produces a build artifact.
- **Each plugin must pass `npm run type-check`.** The root `npm run type-check`
  fans this out across all workspaces.

## Common commands

From this directory:

```bash
npm install                  # installs all plugins via workspaces
npm run build                # build every plugin (skipped if no `build` script)
npm run type-check           # type-check every plugin
npm run clean                # rm -rf dist/ + node_modules/ across plugins
```

From a single plugin:

```bash
cd media-stream-grabber/
npm run dev                  # plugin-specific dev server
npm run build                # plugin-specific production build
```

## Adding a new plugin

1. `mkdir <slug> && cd <slug>` — slug must match the `/apps` entry.
2. `npm init -y`, set `"private": true`, add a `build` and `type-check` script.
3. Create `tsconfig.json` extending `../tsconfig.base.json`.
4. Add an entry to `my-blog/apps/web/lib/apps.ts` so the website knows about
   it (the website lives in a different repo — coordinate the two changes).
5. From this directory, run `npm install` so the workspace links it in.

## Currently shipping

| Slug                     | Kind             | Status |
| ------------------------ | ---------------- | ------ |
| `media-stream-grabber`   | Chrome MV3 ext   | beta   |
