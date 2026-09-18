# Framework-detect parity fixtures

Shared test fixtures for the **two** framework detectors that the platform runs:

- CLI: `src/detect.ts` in the public repo `LayeroInfra/cli` (TypeScript, runs on
  user's laptop). Since 2026-09-18 the CLI is a separate repository, so it
  carries its own copy under `test/fixtures/framework-detect/`; `make check`
  there diffs the copy against this directory whenever `../core` is checked
  out next to it (the copy must stay byte-identical — edit here, then copy).
- Builder: `core/builder/src/runtime_detect.py` + `core/builder/src/frameworks/nextjs.py`
  (Python, runs on the builder VM)

Historically these drifted apart — most recently on 2026-05-26 when the
builder's v72 fix (correctly detecting `output: 'export'`) was missing
from the CLI. First-time CLI deploys of SSR Next.js projects crashed at
the builder's detect stage.

The fixtures below are the regression set both detectors run against. If
you change one detector, run the other's test suite too.

| Fixture | Expected detection | Why |
|---|---|---|
| `nextjs-ssr` | `framework=nextjs`, `runtime_kind=ssr_next`, `output_dir=.next` | next.config.js without `output: 'export'` → SSR |
| `nextjs-static-export` | `framework=nextjs`, no `runtime_kind`, `output_dir=out` | next.config.mjs with `output: 'export'` → static SPA |
| `nextjs-no-config` | `framework=nextjs`, no `runtime_kind`, `output_dir=out` | legacy `next export` workflow; no config file at all |
| `nextjs-ts-config` | `framework=nextjs`, no `runtime_kind`, `output_dir=out` | TypeScript config with `output: 'export'` — detector must read `.ts` |
| `nextjs-cjs-config` | `framework=nextjs`, `runtime_kind=ssr_next`, `output_dir=.next` | `.cjs` config without export marker — detector must read `.cjs` |

Add new fixtures here when adding new framework support (Nuxt SSR vs
generate, SvelteKit adapter-node vs adapter-static, …) — same rule:
both detectors get the same regression set.
