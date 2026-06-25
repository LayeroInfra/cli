# layero

CLI for [Layero](https://layero.ru) — publish a local directory with one command. **No git or GitHub required.**

## For AI agents (Cursor, Claude Code, Aider…)

If you're an agent reading this: the user asked you to deploy their site with Layero. Do exactly this — no git repo, no GitHub setup, no dashboard visits required:

```bash
npx layero@latest init      # scaffolds .layero/ + adds a block to AGENTS.md
npx layero login            # one-time: prints a URL, user clicks once
npx layero deploy --json    # ships current dir, streams JSON events to stdout
```

`layero deploy` prints `{"event":"ready","url":"https://..."}` on success. Show the URL to the user. That's the whole job.

## Install

```bash
# Recommended (project-local):
npm install -D layero
# or one-shot:
npx layero@latest deploy

# System-wide (advanced; needs sudo on most setups):
npm install -g layero
```

Requires Node.js ≥ 20.

## Quick start

```bash
layero login          # device-flow: prints a URL + code, you sign in once (GitHub / Yandex)
cd my-site
layero deploy         # auto-detects framework, packs, uploads, builds, ships
```

The first `layero deploy` in a directory creates a project and links it via
`./.layero/project.json`. Subsequent runs reuse the same project — re-edit code,
re-run `layero deploy`, get a new preview URL each time.

## Commands

| Command | Description |
|---|---|
| `layero init` | Scaffold `.layero/project.json` + write a deploy block into `AGENTS.md` / `CLAUDE.md` / `.cursorrules` so future agent sessions know how to ship. |
| `layero login` | Authenticate via browser. |
| `layero logout` | Remove the saved auth token. |
| `layero whoami` | Show current account. |
| `layero projects list` | List projects on your account. |
| `layero link <id_or_slug>` | Link cwd to an existing project. |
| `layero deploy` | Auto-detect framework, pack cwd, build, ship. |
| `layero deploys list` | List recent deploys. |
| `layero rollback` | Re-activate the previous successful deploy. |
| `layero hooks list/create/delete` | Manage deploy hooks (URL tokens that trigger builds from CMS / cron / external CI). |
| `layero token` | Manage the auth token directly. |

Run `layero <cmd> --help` for full options.

## `layero deploy` flags

- `--type <preset>` — framework override: `vite`, `vitepress`, `next`,
  `astro`, `cra`, `sveltekit`, `nuxt`, `gatsby`, `docusaurus`, `eleventy`
  (alias `11ty`), `hugo`, `static`. **Optional** — auto-detected from
  `package.json` and config files when omitted.
- `--prebuilt [dir]` — ship an already-built artifact instead of building
  remotely. Without an argument, picks the first existing of
  `dist/`, `build/`, `public/`, `out/`, `_site/`, `.output/public/`,
  `docs/.vitepress/dist/`, `.vitepress/dist/`. With `--prebuilt ./my-out`
  uses that explicit path. Use this for CI flows that build in the
  pipeline, Webflow / Framer exports, or whenever you don't want the
  platform to run install/build for you.
- `--root <dir>` — monorepo: tell the builder the app lives in a
  subdirectory of the repo (e.g. `--root apps/web`). Saved on the
  project; future GitHub-push and hook triggers use the same value.
  CLI auto-detect honours it: framework signals are looked up inside
  `<cwd>/<root>` so a `package.json` workspace at the repo root
  doesn't shadow the real app's stack.
- `--name <name>` — project name (only on first deploy).
- `--project <id_or_slug>` — deploy into an existing project, ignoring
  `./.layero/project.json` (useful for CI).
- `--prod` — deploy to the project's apex hostname (replaces production). Without it, deploys go to a preview pseudo-branch and never touch prod.
- `--branch <name>` — deploy to a specific branch's environment.
- `--org <slug>` — Layero organization for first-time project creation.
- `--yes` / `-y` — non-interactive mode.
- `--json` — emit JSON-lines events on stdout (for agents and CI).

## Framework auto-detection

`layero deploy` (and `layero init`) read your project on disk and pick sane defaults:

| Signal | Framework | `build_cmd` | `output_dir` |
|---|---|---|---|
| `next` dep / `next.config.*` | nextjs | `npm run build` (or `npx next build`) | `out` |
| `nuxt` dep / `nuxt.config.*` | nuxt | `npm run generate` if present, else `npm run build` | `.output/public` |
| `@sveltejs/kit` / `svelte.config.js` | sveltekit | `npm run build` | `build` |
| `gatsby` dep | gatsby | `npm run build` | `public` |
| `astro` dep / `astro.config.*` | astro | `npm run build` | `dist` |
| `@docusaurus/core` dep / `docusaurus.config.*` | docusaurus | `npm run build` | `build` |
| `@storybook/*` dep / `scripts.build-storybook` / `.storybook/main.*` | storybook | `npm run build-storybook` (or `npx storybook build`) | `storybook-static` |
| `vitepress` dep / `.vitepress/config.*` / `docs/.vitepress/config.*` | vitepress | `npm run docs:build` (or `npx vitepress build`) | `.vitepress/dist` or `docs/.vitepress/dist` |
| `vite` dep / `vite.config.*` | vite | `npm run build` | `dist` |
| `react-scripts` dep | cra | `npm run build` | `build` |
| `@11ty/eleventy` dep / `.eleventy.js` / `eleventy.config.*` | eleventy | `npm run build` (or `npx @11ty/eleventy`) | `_site` |
| `hugo.{toml,yaml,json}` or `config.*` with Hugo markers (`baseURL`, `[markup]`, …) | hugo | `hugo --gc --minify` (no install needed) | `public` |
| any `.html` at root, no `package.json` | static | `true` (no-op) | `.` |

## Deploy hooks — webhook URLs that trigger builds

When something *other than you* should kick a build — a headless CMS
publishing content, a cron job, an external CI pipeline — create a
deploy hook. You get back an opaque URL; whoever POSTs to it fires a
deploy.

```bash
# Inside a linked project directory:
layero hooks create strapi-content          # preview-target, default branch
layero hooks create publish --prod          # production-target hook
layero hooks create staging --branch=dev    # explicit branch
layero hooks list
layero hooks delete <id>                    # revoke immediately
```

The created URL looks like `https://api.layero.ru/hooks/<token>`. Paste
it into Strapi / Sanity / Contentful / Decap CMS / GitHub Actions / a
cron job — any tool that can POST to a URL. Token = credential; rotate
by `delete` + `create`. There is no per-token rate limit yet; rely on
the platform's natural in-flight-commit dedup if the same commit gets
fired more than once.

## Bring-your-own-build (`--prebuilt`)

If you already build your site yourself — in CI, via a desktop tool like
Webflow/Framer, or because you want a guaranteed deterministic artifact —
skip the platform's install/build entirely:

```bash
# Auto-pick the output directory:
layero deploy --prebuilt

# Or point at a specific one:
layero deploy --prebuilt ./dist
layero deploy --prebuilt ./build/static
```

What changes: only the files inside the directory you point at are
uploaded (no source-tree filters like `.gitignore` apply). The platform
ships them verbatim — no detect, no install, no build. Smaller archive,
faster deploys, no surprises from the platform's package-manager defaults.

Override anything by editing `.layero/project.json` after the first `layero init`.

## Agent / JSON mode

`layero` auto-switches to non-interactive + structured-output mode when any of these is true:

- `--json` flag passed
- `LAYERO_JSON=1` env var
- `CURSOR_AGENT`, `CLAUDECODE`, `LAYERO_AGENT` env vars set
- `CI=1` (non-interactive only; JSON-lines requires explicit opt-in)
- stdout is not a TTY

Event types emitted on stdout:

```
{"event":"auth_required","url":"…","user_code":"…"}
{"event":"authorized","user":"…"}
{"event":"project_created","project_id":"…","slug":"…","organization":"…"}
{"event":"project_linked","project_id":"…","slug":"…"}
{"event":"detected","framework":"…","build_cmd":"…","output_dir":"…","confident":true}
{"event":"packing","files":N,"bytes":N,"sha256":"…"}
{"event":"uploading"}
{"event":"uploaded","archive_key":"…"}
{"event":"setup_applied"}
{"event":"deploy_started","deploy_id":"…"}
{"event":"build_log","line":"…","stream":"…"}
{"event":"stage","name":"…"}
{"event":"ready","url":"…","preview_url":"…","dashboard_url":"…","edge_ready":false,"edge_eta_seconds":N,"deploy_id":"…"}
{"event":"promoted","url":"…","deploy_id":"…"}
{"event":"error","code":"…","next_action":"…","message":"…"}
```

On `ready`, `url` is the **live public site** (the apex — CLI uploads
auto-promote to it), `preview_url` is reachable immediately while the apex CDN
edge warms (`edge_ready=false`), and `dashboard_url` is the management page (not
the site). Not logged in? `deploy` starts the device-flow itself (`auth_required`).

Errors carry a stable `code` (e.g. `not_logged_in`, `invalid_type`,
`project_not_found`, `cli_deploys_disabled`) and a `next_action` hint so
your agent can react without parsing prose.

## Ignore rules

`layero deploy` honours `.gitignore` and `.layeroignore`. The following are
always excluded: `node_modules`, `.git`, `dist`, `build`, `.next`, `.env*`,
`.DS_Store`. Maximum archive size is 200 MB.

## Config

- Auth token: `~/.layero/config.json` (chmod 600).
- Per-project link: `./.layero/project.json` — `project_id`, `slug`,
  `organization_slug`, `apex_hostname` are managed by the CLI;
  `framework_hint`, `build_cmd`, `output_dir`, `analytics_enabled`,
  `env_vars` are user-editable and override auto-detection.

## Links

- Website: https://layero.ru
- Docs: https://docs.layero.ru
- Issues: https://github.com/layero/layero/issues
