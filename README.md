# layero

CLI for [Layero](https://layero.ru) — hosting with build servers in Russia.
Deploy a directory or connect a repository with one command; every command
speaks JSON for AI agents and CI.

Source: [github.com/LayeroInfra/cli](https://github.com/LayeroInfra/cli)
(the CLI's home; mirrored to [gitverse.ru/layero/cli](https://gitverse.ru/layero/cli)).
Docs: [docs.layero.ru/cli](https://docs.layero.ru/cli/).

## For AI agents (Cursor, Claude Code, Codex, Aider…)

The canonical agent skill lives in
[LayeroInfra/layero-agents](https://github.com/LayeroInfra/layero-agents):
`npx skills add LayeroInfra/layero-agents`, or for Claude Code
`claude plugin marketplace add LayeroInfra/layero-agents && claude plugin install layero@layero`.
Agent docs: [docs.layero.ru/agents](https://docs.layero.ru/agents/).

Three paths — pick by situation:

1. **The user has a repository** (GitHub, GitVerse, GitLab, GitFlic,
   SourceCraft): connect it, then push to a branch = preview, push to `main`
   = production.
   ```bash
   npx layero@latest projects create --repo github:owner/repo --json
   ```
2. **The user has a directory with code**: the CLI packs it, the platform
   builds it. No git repository is needed for this path.
   ```bash
   npx layero@latest deploy --json
   ```
3. **The site is already on Layero**: `diagnose`, `logs`, `rollback`,
   `envs list`, `domains`, `env`, `analytics`, `data` — or the MCP server
   `https://mcp.layero.ru/mcp` (`npx -y add-mcp https://mcp.layero.ru/mcp`).

`layero deploy --json` prints `{"event":"ready","url":"https://…"}` on
success. Show `url` to the user as-is. Not logged in? The command starts the
browser device flow itself and prints `auth_required` with a `url` — render
it as a link and keep waiting. No account at all? `--claim` (see below).

## Install

```bash
npx layero@latest deploy          # one-shot, always the current version
npm install -D layero             # project-local
```

Requires Node.js ≥ 20. Do not `npm install -g layero`: without `@latest` a
bare `npx layero` call then runs the globally installed copy for years.

## Quick start

```bash
layero login          # device flow: prints a URL + code, sign in once (email code or Yandex ID)
cd my-site
layero deploy --dry-run   # how the platform will build this folder; uploads nothing, no login needed
layero deploy         # packs, uploads, the platform builds and ships
```

The first `layero deploy` in a directory creates a project and links it via
`./.layero/project.json`. Later runs reuse the same project.

> **A plain `layero deploy` is not a preview.** For a project created from the
> CLI, direct uploads auto-promote: every run replaces what visitors see at
> `ready.url`. `--branch` is **refused** with `branch_unsupported` (exit 4):
> archive uploads always land in the reserved `cli` environment, so the flag
> cannot give you a preview. Isolated previews come from pushing a branch of
> a connected repository — `layero projects create --repo …`.

## Commands

| Command | Description |
|---|---|
| `layero init` | Write a Layero block into `AGENTS.md` / `CLAUDE.md` / `.cursorrules` (compact index; full skill in `layero-agents`) and scaffold `.layero/project.json`. Optional: `deploy` links the folder by itself. It records no guessed settings. |
| `layero login` / `logout` / `whoami` | Browser device-flow sign-in, sign-out, current account. |
| `layero deploy` | Pack the current directory, build on the platform, publish. `--dry-run` — show the build plan only. `--claim` — without an account. |
| `layero projects list` | Projects on your account with addresses. |
| `layero projects create --repo <provider>:<owner/repo>` | Create a project from a repository of a connected provider, apply the detected settings and start the first build (what the dashboard's "Start deploy" button does); `--no-deploy` leaves it in the wizard. Events: `project_created`, `source_connected`, `webhook_installed` \| `webhook_unavailable`, then `setup_applied` + `deploy_started` \| `setup_pending` \| `setup_failed`. |
| `layero projects delete <slug> --yes` | Delete a project. Irreversible; needs a token with scope `admin`. |
| `layero sources list` | Git providers the platform supports and the organization's connections. |
| `layero sources connect <provider> --token-stdin` | Connect a provider by personal access token (read from stdin so it never lands in shell history). |
| `layero sources repos <connection_id>` | Repositories visible to a connection. |
| `layero envs list` | Environments (branches) of a project with their addresses. |
| `layero deploys list` / `rollback` / `promote` | Deploy history, roll back, pin the apex. |
| `layero diagnose` / `logs` | Why a deploy is in its state; build and runtime logs. |
| `layero claim status` / `claim accept <code>` | Claimable project: status of the claim, open the claim page. |
| `layero domains …` / `env …` / `analytics …` / `perf …` | Custom domains, environment variables, Yandex Metrika, performance checks. |
| `layero db …` / `data …` | Postgres databases and the Data API. |
| `layero hooks list/create/delete` | Deploy hooks — URL tokens that trigger builds from CMS / cron / external CI. |
| `layero token create <name>` | Long-lived token for CI and agents (`--scope read,deploy,admin`). |
| `layero link <id_or_slug>` | Link the current directory to an existing project. |

Run `layero <cmd> --help` for full options.

## `layero deploy` flags

- `--dry-run` — print how the platform will build this folder and exit:
  framework, build command, output folder, where each value comes from
  (`layero.json`, project settings, `package.json`, a framework default), and
  a `hint` / `next_action` when the folder is a monorepo, a frontend +
  backend pair, a custom build script or a server. Uploads nothing, needs no
  login (with a login it also reads the settings of a linked project).
- `--type <preset>` — framework override: `vite`, `vitepress`, `next`,
  `astro`, `cra`, `sveltekit`, `nuxt`, `gatsby`, `docusaurus`, `eleventy`
  (alias `11ty`), `hugo`, `static`, `generic`; runtime kinds `node_web`,
  `python_web`, `flask`, `streamlit`, `gradio`, `ssr_next` (aliases
  `express`, `fastapi`, `django`, …). **Optional** — detected by the
  platform when omitted. `static` serves the files as they are and never runs
  a build; `generic` runs your own build command (`layero.json`
  `buildCommand` or the `build` script) and serves the folder with
  `index.html`.
- `--prebuilt [dir]` — ship an already-built artifact instead of building
  remotely. Without an argument, picks the first existing of `dist/`,
  `build/`, `public/`, `out/`, `_site/`, `.output/public/`,
  `docs/.vitepress/dist/`, `.vitepress/dist/`.
- `--root <dir>` — monorepo: the app lives in a subdirectory (`--root apps/web`).
- `--name <name>` — project name (only on first deploy).
- `--project <id_or_slug>` — deploy into an existing project, ignoring
  `./.layero/project.json` (use this in CI, not `--name`).
- `--prod` — only for a project **with a connected repository**: publish this
  upload at the live address (without it the upload lands in the project's
  separate `cli` environment). A project without a repository is always
  published live.
- `--branch <name>` — **refused** (`branch_unsupported`, exit 4), see above.
- `--claim` — deploy without an account: a temporary site for 1 hour
  plus a `claim_url` for a human to take it over. Static sites and SPAs only:
  a server app (SSR, fullstack, container) is refused before anything is
  uploaded (`claim_static_only`, exit 4). Turns on by itself when
  there is no token, the run is non-interactive (an agent, not CI), `--yes`
  is passed and the project is new: no `--project`, and the folder is not
  linked to an account project. An existing project without a token means
  signing in (`auth_required`). With `--project` it is refused
  (`claim_with_project`, exit 4). In CI a missing `LAYERO_TOKEN` stays an error.
- `--org <slug>` — organization for first-time project creation.
- `--yes` / `-y` — non-interactive mode.
- `--json` — JSON-lines events on stdout (for agents and CI).

## Deploy without an account (`--claim`)

```bash
npx layero@latest deploy --claim --json
```

The platform creates a temporary project and a token for it; the CLI deploys
with that token and prints, before `ready`:

```
{"event":"claimable","url":"https://k3v9q2m8x7w1c4r6t0y5u2ze.layero.app","claim_url":"https://app.layero.ru/claim?code=…","expires_at":"…"}
```

The site lives for 1 hour, then stops answering and is deleted. Only static
sites and SPAs are accepted: a server app needs an account. The address is
random (the folder name and `--name` do not go into it), and the site is
closed to search engines: `robots.txt` with `Disallow: /` and
`X-Robots-Tag: noindex, nofollow`. A human opens `claim_url`, signs in and
takes the project into their account — the CLI cannot accept a claim by
itself.
The claim code is saved in `.layero/project.json`; the temporary token stays
in `~/.layero/config.json`, so `layero deploy` in the same directory keeps
updating the same site until the claim expires or is accepted.
`layero claim status` shows where things stand; `layero claim accept` opens
the page in a browser (in agent mode it prints the link).

## Framework auto-detection

`layero deploy --dry-run` (and `layero init`, and the `detected` event of every
deploy) read your project on disk with the same rules the platform uses. This
is **advice, not a decision**: the platform detects again on the uploaded
files, and nothing the CLI guesses is saved to the project — only what you name
(`--type`, `--root`, fields you write into `.layero/project.json` or
`layero.json`). `confident: false` means the folder was not recognised; read
`hint` and `next_action` (an app in a subfolder → `--root <dir>`, frontend +
backend → `layero.json` with both halves, a custom build script →
`"framework": "generic"`).

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
| `index.html` at the root, no framework | static | none — served as is | `.` |
| `package.json` with a `build` script, no known framework | generic | `npm run build` | the folder with `index.html` after the build |

## `layero.json` — pin the settings in the repository

Auto-detection above is a default, not a decision. Drop a `layero.json` at the
root of the repository and Layero uses what you set there instead — for the
CLI, the dashboard and pushes alike. It beats any dashboard setting.

```json title="layero.json"
{
  "$schema": "https://layero.ru/schema/layero-v2.json",
  "framework": "vite",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "nodeVersion": "22"
}
```

Every field is optional; `{}` is valid. An error in the file never fails a
build: unreadable values become warnings in the build log.
Full reference: https://docs.layero.ru/deploys/layero-json

## Repositories: `sources` and `projects create`

```bash
layero sources list                                          # providers + connections
echo "$GITVERSE_TOKEN" | layero sources connect gitverse --token-stdin
layero sources repos <connection_id>
layero projects create --repo gitverse:acme/site --branch main --json
```

GitHub is connected by installing the Layero GitHub App in the dashboard; the
other providers take a personal access token. `projects create` validates the
repository against the connection, creates the project and installs the
webhook. If the provider refuses the webhook (token permissions, or
SourceCraft, which has no outgoing webhooks), the CLI says so with
`webhook_unavailable` and the URL to register by hand — the repository is
connected either way, only push-triggered builds wait for the webhook.

Once linked, the command finishes the setup wizard itself: it takes the
detection hint (framework, build command, output directory), applies it and
starts the first build — exactly what the dashboard's "Start deploy" button
does (`setup_applied`, `deploy_started`). `--no-deploy` leaves the project in
the wizard (`setup_pending` with the dashboard URL). If detection or setup
fails, the project is still created and the exit code is 0: `setup_failed`
carries the reason and the wizard URL.

## Deploy hooks — webhook URLs that trigger builds

```bash
layero hooks create strapi-content          # preview-target, default branch
layero hooks create publish --prod          # production-target hook
layero hooks create staging --branch=dev    # explicit branch
layero hooks list
layero hooks delete <id>                    # revoke immediately
```

The URL (`https://api.layero.ru/hooks/<token>`) is a credential: anyone who
has it can start a build. Rotate with `delete` + `create`.

## Bring-your-own-build (`--prebuilt`)

```bash
layero deploy --prebuilt            # auto-pick the output directory
layero deploy --prebuilt ./dist     # or point at a specific one
```

Only the files inside that directory are uploaded and shipped verbatim — no
detect, no install, no build. `.gitignore` is **not** applied on this path
(`.env*`, `.git`, `node_modules` and the rule files are still excluded), so
name the directory explicitly rather than using `.`.

## In CI

`layero login` opens a browser — there isn't one on a runner, so a pipeline
authenticates with a long-lived token. Create it with `layero token create ci`
or at [app.layero.ru/settings/cli](https://app.layero.ru/settings/cli):

```bash
LAYERO_TOKEN=... npx layero@latest deploy --project <slug> --json --yes
```

`LAYERO_TOKEN` is read **before** `~/.layero/config.json`. `--yes` skips the
confirmation that would otherwise wait forever. `--project`, not `--name`:
`--name` only names a project on creation, and a clean checkout without
`.layero/project.json` would create a new project on every run.

On GitHub Actions there is an official action:

```yaml
      - uses: LayeroInfra/deploy-action@v1
        with:
          token: ${{ secrets.LAYERO_TOKEN }}
          prod: true
```

If the repository is already connected to a Layero project, a push builds it
automatically — reach for CI only when the build itself needs secrets the
platform does not have, then ship the result with `--prebuilt`.
Full guide: <https://docs.layero.ru/cli/github-actions>

## Agent / JSON mode

`layero` switches to non-interactive, structured output when any of these holds:

- `--json` flag or `LAYERO_JSON=1`
- `CURSOR_AGENT`, `CLAUDECODE`, `LAYERO_AGENT` env vars
- `CI=1` (non-interactive only; JSON-lines requires explicit opt-in)
- stdout is not a TTY

Every command emits events — one JSON object per line on stdout:

```
{"event":"auth_required","url":"…","user_code":"…"}
{"event":"authorized","user":"…"}
{"event":"me","id":"…","username":"…","email":"…"}
{"event":"projects","projects":[{"slug":"…","url":"https://…","repo":null,…}]}
{"event":"organizations","organizations":[{"slug":"…","kind":"personal","role":"admin"}]}
{"event":"project_created","project_id":"…","slug":"…","organization":"…","url":"…","repo":"…","branch":"…"}
{"event":"project_linked","project_id":"…","slug":"…","url":"…"}
{"event":"source_connected","org":"…","connection_id":"…","provider":"…","account":"…"}
{"event":"webhook_installed","project":"…"}   |   {"event":"webhook_unavailable","project":"…","url":"…","hint":"…"}
{"event":"setup_applied","project":"…","framework":"…","build_cmd":"…","output_dir":"…","layero_found":false}
{"event":"setup_pending","project":"…","url":"https://app.layero.ru/projects/…/setup","hint":"…"}   |   {"event":"setup_failed","project":"…","reason":"…","url":"…","hint":"…"}
{"event":"sources","org":"…","providers":[…],"connections":[…]}
{"event":"source_repos","org":"…","connection_id":"…","repos":[…]}
{"event":"environments","project":"…","environments":[{"branch":"main","url":"https://…","production":true,…}]}
{"event":"detected","framework":"…","build_cmd":"…"|null,"output_dir":"…"|null,"confident":true,"sources":{…},"hint":"…","next_action":"…"}
{"event":"plan","framework":"…","build_cmd":"…"|null,"output_dir":"…"|null,"sources":{…},"creates_project":true,"replaces_live_site":true,…}   (--dry-run)
{"event":"packing","files":N,"bytes":N,"sha256":"…"}
{"event":"uploading"}  {"event":"uploaded","archive_key":"…"}
{"event":"deploy_started","deploy_id":"…"}
{"event":"build_log","line":"…","stream":"…"}
{"event":"stage","name":"…"}
{"event":"claimable","project_id":"…","slug":"…","url":"…","claim_url":"…","expires_at":"…"}
{"event":"ready","url":"…","dashboard_url":"…","deploy_id":"…"}
{"event":"hooks","project":"…","hooks":[…]}  {"event":"hook_created",…}  {"event":"hook_deleted",…}
{"event":"project_deleted","project_id":"…","slug":"…"}
{"event":"claim_status","code":"…","status":"…","claimed":false,"expires_at":"…","url":"…","claim_url":"…"}
{"event":"claim_accept","code":"…","claim_url":"…","opened":false}
{"event":"logged_out","config_path":"…"}
{"event":"error","code":"…","next_action":"…","message":"…"}
```

On `ready`, `url` is the **live public site** — show it as-is and never
rebuild the hostname from a template. `ready` comes once the address answers
with the site itself (`edge_ready: true`); `edge_ready: false` with `screen`
means the platform's own page still answered after the wait — the app did not
come up, read `layero logs --runtime`. `dashboard_url` is the management page,
not the site. `preview_url` and `edge_eta_seconds` are legacy fields.

Errors carry a stable `code` (`auth_required`, `auth_expired`, `auth_timeout`,
`project_unknown`, `project_not_found`, `cli_deploys_disabled`, `invalid_type`,
`prebuilt_no_dir`, `prebuilt_no_index`, `branch_unsupported`,
`deploy_not_started`, `deploy_failed`, `internal`, and command-specific ones)
plus a `next_action` hint. The failure code is assembled as `deploy_<status>`
and a deploy only has `ready`, `building`, `failed` and `cancelled` — so
`deploy_error`, `deploy_timed_out` and `not_logged_in` do not exist.
Full reference: <https://docs.layero.ru/cli/json-events>

### Exit codes

| Code | Class | Error codes |
|---|---|---|
| 0 | success | |
| 1 | other | `plan_limit`, `forbidden`, `confirmation_required`, `repeated_failure`, … |
| 2 | sign-in needed | `auth_required`, `auth_expired`, `auth_timeout` |
| 3 | not found | `project_unknown`, `project_not_found`, `org_unknown`, `hook_not_found`, `connection_not_found`, `claim_unknown`, … |
| 4 | invalid input | `invalid_type`, `prebuilt_no_dir`, `prebuilt_no_index`, `branch_unsupported`, `repo_format`, `token_missing`, `bad_format`, … |
| 5 | remote failure | `deploy_failed`, `deploy_cancelled`, `deploy_not_started`, `deploy_watch_lost`, `internal`, 5xx from the platform |

## Ignore rules

`layero deploy` honours `.gitignore` and `.layeroignore`. Always excluded:
`node_modules`, `.git`, `dist`, `build`, `.next`, `.env*`, `.DS_Store`, and
the rule files themselves. Maximum archive size is 500 MB.

## Config

- Auth token: `~/.layero/config.json` (chmod 600). Claim tokens of temporary
  projects live there too, keyed by project.
- Per-project link: `./.layero/project.json` — `project_id`, `slug`,
  `organization_slug`, `apex_hostname`, `claim` are managed by the CLI;
  `framework_hint`, `build_cmd`, `output_dir`, `analytics_enabled`,
  `env_vars` are yours: the CLI never writes guesses there, and what you put
  there is applied to a new project as your choice.

## Contributing

This repository is the CLI's home (since 2026-09-18; before that it was the
`cli/` directory of the platform monorepo and this repo was a read-only
mirror). Issues and pull requests are welcome here. `make check` runs the
build, the unit tests and the consistency gates; `npm test` alone runs the
tests, `npm run build` compiles with `tsc`. Releases are published to npm by
`.github/workflows/publish.yml` on a `vX.Y.Z` tag. Contributor rules for
humans and agents: `AGENTS.md`; how the package is put together: `ARCH.md`.

## Links

- Docs: https://docs.layero.ru/cli/
- For agents: https://docs.layero.ru/agents/ · skill: https://github.com/LayeroInfra/layero-agents
- Source: https://github.com/LayeroInfra/cli · issues: https://github.com/LayeroInfra/cli/issues
- Support: https://docs.layero.ru/contacts/
