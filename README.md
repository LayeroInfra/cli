# layero

CLI for [Layero](https://layero.ru) — publish a local site with one command.

## Install

```bash
npm install -g layero
```

Requires Node.js ≥ 20.

## Quick start

```bash
layero login          # opens browser for OAuth (GitHub / Google / Yandex)
cd my-site
layero deploy         # packs the current dir, uploads, builds and publishes
```

The first `layero deploy` in a directory creates a project and links it via
`./.layero/project.json`. Subsequent runs reuse the same project.

## Commands

| Command | Description |
|---|---|
| `layero login` | Authenticate via browser. |
| `layero logout` | Remove the saved auth token. |
| `layero whoami` | Show current account. |
| `layero projects list` | List projects on your account. |
| `layero link <id_or_slug>` | Link cwd to an existing project. |
| `layero deploy` | Pack cwd and deploy. |
| `layero token` | Manage the auth token directly. |

Run `layero <cmd> --help` for full options.

## `layero deploy` flags

- `--type <preset>` — framework preset: `vite`, `next`, `astro`, `cra`,
  `sveltekit`, `nuxt`, `gatsby`, `static`.
- `--name <name>` — project name (only on first deploy).
- `--project <id_or_slug>` — deploy into an existing project, ignoring
  `./.layero/project.json` (useful for CI).
- `--yes` / `-y` — non-interactive mode.

## Ignore rules

`layero deploy` honours `.gitignore` and `.layeroignore`. The following are
always excluded: `node_modules`, `.git`, `dist`, `build`, `.next`, `.env*`,
`.DS_Store`. Maximum archive size is 200 MB.

## Config

- Auth token: `~/.layero/config.json` (chmod 600).
- Per-project link: `./.layero/project.json`.

## Links

- Website: https://layero.ru
- Issues: https://github.com/layero/layero/issues
