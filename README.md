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
layero login          # opens browser for OAuth (GitHub / Google / Yandex)
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
| `layero token` | Manage the auth token directly. |

Run `layero <cmd> --help` for full options.

## `layero deploy` flags

- `--type <preset>` — framework override: `vite`, `next`, `astro`, `cra`,
  `sveltekit`, `nuxt`, `gatsby`, `docusaurus`, `static`. **Optional** — auto-detected from `package.json` and config files when omitted.
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
| `vite` dep / `vite.config.*` | vite | `npm run build` | `dist` |
| `react-scripts` dep | cra | `npm run build` | `build` |
| any `.html` at root, no `package.json` | static | `true` (no-op) | `.` |

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
{"event":"ready","url":"…","deploy_id":"…"}
{"event":"error","code":"…","next_action":"…","message":"…"}
```

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
