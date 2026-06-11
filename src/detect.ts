import { promises as fs } from "node:fs";
import path from "node:path";

// Runtime apps route through the runtime-builder (container) pipeline, not
// the SPA static path. Mirrors detect_runtime() / runtime_detect.py.
export type RuntimeKind = "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";

// package.json deps marking a Node web backend → node_web. Lockstep with
// builder/src/runtime_detect.py NODE_WEB_SIGNALS / NODE_FRONTEND_DEPS.
const NODE_WEB_SIGNALS = [
  "express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hapi",
  "hono", "@adonisjs/core", "restify", "polka", "@feathersjs/feathers",
  "sails", "h3",
];
const NODE_FRONTEND_DEPS = [
  "next", "nuxt", "vite", "react-scripts", "@angular/core", "@sveltejs/kit",
  "gatsby", "astro", "@docusaurus/core", "@11ty/eleventy", "vitepress",
];

// A Node backend: a server framework AND no frontend/SSG framework (which
// would build to static and belong to the SPA pipeline instead).
function detectNodeRuntime(pkg: PackageJson): boolean {
  return (
    NODE_WEB_SIGNALS.some((d) => hasDep(pkg, d)) &&
    !NODE_FRONTEND_DEPS.some((d) => hasDep(pkg, d))
  );
}

export interface Detected {
  framework_hint: string;
  build_cmd: string;
  output_dir: string;
  // True when we matched a known framework signal. False means we fell
  // back to "static" or "generic" because nothing recognisable was found.
  confident: boolean;
  // Set when the repo is a runtime app (SSR Next / Streamlit / Gradio /
  // Flask) and the platform must route it through the runtime-builder
  // pipeline instead of the SPA static path. Mirrors detect_runtime() on the
  // backend + runtime_detect.py on the builder; absent for plain static SPAs.
  runtime_kind?: RuntimeKind;
  // Pre-flight warning for repos the platform won't host as-is. Today
  // covers Nuxt without `nuxt generate`/static config + SvelteKit with
  // a server adapter. Mirrors `frameworks/nuxt.py` + `frameworks/svelte.py`
  // .validate_static on the builder side — the goal is to surface the
  // same diagnostic before upload instead of after a failed build.
  ssr_warning?: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPkg(cwd: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

async function fileExists(cwd: string, ...candidates: string[]): Promise<boolean> {
  for (const c of candidates) {
    try {
      await fs.access(path.join(cwd, c));
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// Python runtime: `app.py`/`main.py` entry + a runtime lib in requirements.txt.
// Lockstep with detect_runtime() (backend) / runtime_detect.py (builder):
// Streamlit/Gradio keep their self-contained runtimes; Flask/FastAPI and any
// WSGI|ASGI server route to the generic python_web runtime.
// Lockstep with builder/src/runtime_detect.py PY_WEB_SIGNALS + framework_detector.py.
const PY_WEB_SIGNALS = [
  "fastapi", "starlette", "litestar", "starlite", "quart", "sanic",
  "blacksheep", "hypercorn", "daphne", "uvicorn",
  "flask", "falcon", "bottle", "pyramid", "cherrypy", "werkzeug", "gunicorn",
  "aiohttp", "tornado", "django",
];

async function detectPythonRuntime(cwd: string): Promise<RuntimeKind | null> {
  const appPy = await fileExists(cwd, "app.py");
  const mainPy = await fileExists(cwd, "main.py");
  // Django's entrypoint is manage.py (no app.py/main.py at the root).
  const managePy = await fileExists(cwd, "manage.py");
  if (!appPy && !mainPy && !managePy) return null;
  let reqs: string;
  try {
    reqs = (await fs.readFile(path.join(cwd, "requirements.txt"), "utf-8")).toLowerCase();
  } catch {
    return null;
  }
  if (reqs.includes("streamlit") && appPy) return "streamlit";
  if (reqs.includes("gradio") && appPy) return "gradio";
  if (PY_WEB_SIGNALS.some((s) => reqs.includes(s))) return "python_web";
  return null;
}

// Mirrors `frameworks/nextjs.py:_NEXT_STATIC_EXPORT_RE` and
// `next_config_static_export()` so CLI and builder can't disagree on
// what counts as a static-export Next.js project. The class-of-bug we
// hit on 2026-05-22 (builder detector v72 fix) and 2026-05-26 (CLI side)
// was exactly this kind of dual detector drift.
const NEXT_STATIC_EXPORT_RE = /output\s*:\s*['"]export['"]/m;

// Strip JS line and block comments before regex matching. Without this,
// a comment like `// see output: 'export'` falsely matches as
// static-export — observed 2026-05-26 on the SSR smoke canary fixture.
// Naive (does not understand strings that contain comment-like tokens),
// but real next.config files don't have that shape.
const JS_COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//gm;
const stripJsComments = (text: string): string => text.replace(JS_COMMENT_RE, "");

async function readNextConfigText(cwd: string): Promise<string | null> {
  for (const name of ["next.config.mjs", "next.config.ts", "next.config.js", "next.config.cjs"]) {
    try {
      return await fs.readFile(path.join(cwd, name), "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return null;
    }
  }
  return null;
}

// True  -> config has `output: 'export'` (static-export SPA).
// False -> config exists but no export marker (SSR Next.js).
// null  -> no next.config file at all; caller treats as static-default.
async function nextConfigStaticExport(cwd: string): Promise<boolean | null> {
  const text = await readNextConfigText(cwd);
  if (text === null) return null;
  return NEXT_STATIC_EXPORT_RE.test(stripJsComments(text));
}

async function hasAnyHtml(cwd: string): Promise<boolean> {
  // Shallow check — only top-level. Recursive walk is too expensive here
  // and the static fallback is already permissive enough.
  try {
    const entries = await fs.readdir(cwd);
    return entries.some((e) => e.endsWith(".html") || e.endsWith(".htm"));
  } catch {
    return false;
  }
}

// Build command preference:
//   1. If `scripts.build` exists in package.json, use `npm run build` —
//      it respects whatever the user set up (custom flags, monorepo
//      filters, etc.). `npm run` works regardless of package manager
//      installed on the build VM, because the builder runs `npm` itself.
//   2. Otherwise, use the framework's CLI directly via `npx`.
function buildCmd(pkg: PackageJson | null, fallback: string): string {
  if (pkg?.scripts?.build) return "npm run build";
  return fallback;
}

/**
 * Detect framework / build command / output directory from the project
 * shape. Mirrors the builder's detector ([core/builder/src/frameworks])
 * so the values we ship to `completeSetup` match what the builder will
 * actually do at build time.
 *
 * Order matters: more specific signals first (Next, Nuxt, SvelteKit,
 * Gatsby, Astro, Docusaurus) before catch-alls (Vite, CRA, static).
 */
export async function detectProject(cwd: string): Promise<Detected> {
  const pkg = await readPkg(cwd);

  if (pkg) {
    if (hasDep(pkg, "next") || (await fileExists(cwd, "next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"))) {
      // A Next.js repo is SSR unless next.config explicitly declares
      // `output: 'export'`. We only flag ssr_next when the config file
      // exists AND lacks the export marker — same rule the builder uses
      // in `runtime_detect.py:46`. Without a next.config file at all we
      // err on the side of static (legacy `next export` workflow).
      const exportFlag = await nextConfigStaticExport(cwd);
      const isSsr = exportFlag === false;
      return {
        framework_hint: "nextjs",
        build_cmd: buildCmd(pkg, "npx next build"),
        output_dir: isSsr ? ".next" : "out",
        confident: true,
        ...(isSsr ? { runtime_kind: "ssr_next" as const } : {}),
      };
    }
    // Node web backend (Express/Fastify/Koa/NestJS/Hapi/Hono/…) → node_web.
    // Build (TypeScript compile) runs inside the container image, so the SPA
    // pipeline is a no-op here.
    if (detectNodeRuntime(pkg)) {
      return {
        framework_hint: "static",
        build_cmd: "true",
        output_dir: ".",
        confident: true,
        runtime_kind: "node_web",
      };
    }
    if (hasDep(pkg, "nuxt") || hasDep(pkg, "nuxt3") || (await fileExists(cwd, "nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"))) {
      const generateScript = pkg.scripts?.generate;
      const buildScript = pkg.scripts?.build;
      const cmd = generateScript
        ? "npm run generate"
        : buildScript
        ? "npm run build"
        : "npx nuxt generate";
      // Nuxt defaults to SSR. Layero hosts only static for Nuxt today,
      // so a project without an explicit static signal (`nuxt generate`
      // script, or `ssr: false` / `nitro.preset='static'` in config)
      // will build but the resulting `.output/server/` is useless to us.
      // Mirrors builder's `frameworks/nuxt.py` SSR hint.
      const nuxtStatic = !!generateScript || (await nuxtConfigDeclaresStatic(cwd));
      return {
        framework_hint: "nuxt",
        build_cmd: cmd,
        output_dir: ".output/public",
        confident: true,
        ...(nuxtStatic ? {} : {
          ssr_warning:
            "Nuxt без `nuxt generate` или `ssr: false` собирается как SSR-сервер; " +
            "Layero хостит только статику Nuxt. Добавьте `\"generate\": \"nuxt generate\"` " +
            "в scripts или поставьте `ssr: false` в nuxt.config.",
        }),
      };
    }
    // Remix / React Router v7 before SvelteKit/Vite — RR7 ships Vite
    // internally, so the Vite-dep check would otherwise win. Mirrors the
    // builder's RemixFramework + backend `remix` table entry (output
    // build/client). Was missing from the CLI entirely — same dual-detector
    // gap class as Angular: a Remix repo deployed via the CLI fell through
    // to the static fallback and shipped raw sources.
    if (
      hasDep(pkg, "@remix-run/dev") ||
      hasDep(pkg, "@remix-run/react") ||
      hasDep(pkg, "@remix-run/node") ||
      hasDep(pkg, "@react-router/dev") ||
      hasDep(pkg, "@react-router/node") ||
      (await fileExists(cwd, "react-router.config.ts", "react-router.config.js"))
    ) {
      return {
        framework_hint: "remix",
        build_cmd: buildCmd(pkg, "npx react-router build"),
        output_dir: "build/client",
        confident: true,
      };
    }
    if (hasDep(pkg, "@sveltejs/kit") || (await fileExists(cwd, "svelte.config.js"))) {
      // SvelteKit needs an adapter. adapter-static = SPA path; anything
      // else (adapter-node, adapter-auto, …) is server-side. Mirrors
      // builder's `frameworks/svelte.py:validate_static`.
      const hasStaticAdapter = hasDep(pkg, "@sveltejs/adapter-static");
      const serverAdapter = !hasStaticAdapter
        ? Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
            .find((d) => d.startsWith("@sveltejs/adapter-") && d !== "@sveltejs/adapter-static")
        : undefined;
      let ssrWarning: string | undefined;
      if (serverAdapter) {
        ssrWarning =
          `SvelteKit использует ${serverAdapter} (серверный адаптер). ` +
          "Layero хостит только статику — поставьте `@sveltejs/adapter-static`.";
      } else if (!hasStaticAdapter) {
        ssrWarning =
          "SvelteKit без явного адаптера — поставьте `@sveltejs/adapter-static` " +
          "для статического хостинга на Layero.";
      }
      return {
        framework_hint: "sveltekit",
        build_cmd: buildCmd(pkg, "npx vite build"),
        output_dir: "build",
        confident: true,
        ...(ssrWarning ? { ssr_warning: ssrWarning } : {}),
      };
    }
    if (hasDep(pkg, "gatsby") || (await fileExists(cwd, "gatsby-config.js", "gatsby-config.ts"))) {
      return {
        framework_hint: "gatsby",
        build_cmd: buildCmd(pkg, "npx gatsby build"),
        output_dir: "public",
        confident: true,
      };
    }
    if (hasDep(pkg, "astro") || (await fileExists(cwd, "astro.config.mjs", "astro.config.ts", "astro.config.js"))) {
      return {
        framework_hint: "astro",
        build_cmd: buildCmd(pkg, "npx astro build"),
        output_dir: "dist",
        confident: true,
      };
    }
    if (hasDep(pkg, "@docusaurus/core") || (await fileExists(cwd, "docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs"))) {
      return {
        framework_hint: "docusaurus",
        build_cmd: buildCmd(pkg, "npx docusaurus build"),
        output_dir: "build",
        confident: true,
      };
    }
    // Storybook before Vite/CRA: Storybook 7+ uses Vite or webpack
    // internally, so `vite` / `react-scripts` is in deps. Without
    // listing it first the SPA Vite path would output_dir=dist, which
    // doesn't exist after `build-storybook`.
    const storybookDeps = [
      "@storybook/cli",
      "@storybook/react",
      "@storybook/react-vite",
      "@storybook/react-webpack5",
      "@storybook/vue",
      "@storybook/vue3",
      "@storybook/vue3-vite",
      "@storybook/svelte",
      "@storybook/svelte-vite",
      "@storybook/web-components",
      "@storybook/web-components-vite",
      "@storybook/preact",
      "@storybook/angular",
      "@storybook/nextjs",
      "@storybook/html",
      "@storybook/html-vite",
      "storybook",
    ];
    const hasStorybookDep = storybookDeps.some((d) => hasDep(pkg, d));
    const hasStorybookScript =
      pkg.scripts?.["build-storybook"] !== undefined
      || Object.values(pkg.scripts ?? {}).some(
        (s) => typeof s === "string" && s.includes("storybook build"),
      );
    const hasStorybookDir = await fileExists(cwd, ".storybook/main.js", ".storybook/main.ts", ".storybook/main.cjs", ".storybook/main.mjs");
    if (hasStorybookDep || hasStorybookScript || hasStorybookDir) {
      const cmd = pkg.scripts?.["build-storybook"]
        ? "npm run build-storybook"
        : (pkg.scripts?.build && pkg.scripts.build.includes("storybook"))
          ? "npm run build"
          : "npx storybook build";
      return {
        framework_hint: "storybook",
        build_cmd: cmd,
        output_dir: "storybook-static",
        confident: true,
      };
    }

    // VitePress before generic Vite: VitePress repos often pull `vite`
    // transitively, and the SPA Vite path would set output_dir=dist —
    // wrong for VitePress, which writes to `.vitepress/dist/` (or
    // `docs/.vitepress/dist/` when the config lives under docs/).
    if (hasDep(pkg, "vitepress") || (await hasVitepressConfig(cwd))) {
      const docsLayout = await hasVitepressConfig(cwd, "docs/.vitepress");
      const outputDir = docsLayout ? "docs/.vitepress/dist" : ".vitepress/dist";
      const cmd = pkg.scripts?.["docs:build"]
        ? "npm run docs:build"
        : buildCmd(pkg, "npx vitepress build");
      return {
        framework_hint: "vitepress",
        build_cmd: cmd,
        output_dir: outputDir,
        confident: true,
      };
    }
    if (hasDep(pkg, "vite") || (await fileExists(cwd, "vite.config.ts", "vite.config.js", "vite.config.mjs"))) {
      return {
        framework_hint: "vite",
        build_cmd: buildCmd(pkg, "npx vite build"),
        output_dir: "dist",
        confident: true,
      };
    }
    // Angular after Vite — mirrors builder ALL order. Angular ships its
    // own CLI (`ng build`) and writes to `dist/{project}/` (Angular <17)
    // or `dist/{project}/browser/` (17+ `application` builder), NOT bare
    // `dist`. Until this branch existed the CLI fell through to the
    // static fallback (`output_dir='.'`), so the first deploy of an
    // Angular repo shipped the raw sources — the dist/<project> S3 404
    // incident. `angularOutputDir` parses angular.json to pin the path
    // (lockstep with `frameworks/angular.py:extract_output_dir`).
    if (hasDep(pkg, "@angular/core") || (await fileExists(cwd, "angular.json"))) {
      return {
        framework_hint: "angular",
        build_cmd: buildCmd(pkg, "npx ng build"),
        output_dir: await angularOutputDir(cwd),
        confident: true,
      };
    }
    if (hasDep(pkg, "react-scripts")) {
      return {
        framework_hint: "cra",
        build_cmd: buildCmd(pkg, "npx react-scripts build"),
        output_dir: "build",
        confident: true,
      };
    }
    // Eleventy late in the package.json branch — `@11ty/eleventy` is
    // unique enough not to collide with other frameworks, but Vite /
    // CRA / etc. should win if both are present (a project that pulls
    // both is probably using Vite as the runtime and 11ty just for one
    // build step).
    if (
      hasDep(pkg, "@11ty/eleventy") ||
      hasDep(pkg, "eleventy") ||
      (await fileExists(cwd, ".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"))
    ) {
      return {
        framework_hint: "eleventy",
        build_cmd: buildCmd(pkg, "npx @11ty/eleventy"),
        output_dir: "_site",
        confident: true,
      };
    }
    // package.json present but no framework matched → a custom Node build,
    // NOT a static site. Mirrors the backend's detect(): `pkg is None →
    // _STATIC`, otherwise `_GENERIC` (npm run build → dist). Falling through
    // to the static fallback here shipped the unbuilt sources — exactly the
    // `diplomtest` case (Express app + custom build script detected as static
    // by the CLI but `generic` by the backend).
    return {
      framework_hint: "generic",
      build_cmd: buildCmd(pkg, "npm run build"),
      output_dir: "dist",
      confident: false,
    };
  }

  // Python runtimes (Streamlit / Gradio / Flask): an `app.py` entry plus a
  // runtime lib in requirements.txt. Mirrors detect_runtime() / runtime_detect.py.
  // No package.json, so without this they fall to the static fallback and ship
  // `app.py` as a static file (never runs) — the `streamlit-hello` case.
  const pyRuntime = await detectPythonRuntime(cwd);
  if (pyRuntime) {
    return {
      framework_hint: "static",
      build_cmd: "true",
      output_dir: ".",
      confident: true,
      runtime_kind: pyRuntime,
    };
  }

  // Non-Node SSGs (Hugo today). Recognise repos without package.json
  // before we fall back to "static" with a no-op build command — Hugo
  // needs `hugo --gc --minify` and writes to `public/`, the static
  // fallback would just upload the raw .md sources.
  if (
    (await fileExists(cwd, "hugo.toml", "hugo.yaml", "hugo.json")) ||
    ((await fileExists(cwd, "config.toml", "config.yaml", "config.json")) &&
      (await hasHugoConfigMarker(cwd)))
  ) {
    return {
      framework_hint: "hugo",
      build_cmd: "hugo --gc --minify",
      output_dir: "public",
      confident: true,
    };
  }

  // No (or unrecognised) package.json. If there's HTML on disk we treat
  // the current directory as a static site. Otherwise we still fall back
  // to static — it's the most permissive option and the builder will
  // ship whatever is on disk verbatim.
  const _staticHtml = await hasAnyHtml(cwd);
  return {
    framework_hint: "static",
    build_cmd: "true",
    output_dir: ".",
    confident: _staticHtml,
  };
}

const HUGO_CONFIG_TOKENS = [
  "baseURL",
  "baseurl",
  "languageCode",
  "languagecode",
  "[params]",
  "[markup]",
  "[menu",
  "[taxonomies]",
  "hugoVersion",
  "minVersion",
  "theme",
];

// Match `ssr: false` or `nitro: { preset: 'static' }` in nuxt.config —
// either marker keeps the project on the SPA pipeline. Mirrors the same
// "string-search before AST" approach used for Next.js.
const NUXT_STATIC_SSR_RE = /\bssr\s*:\s*false\b/m;
const NUXT_STATIC_PRESET_RE = /preset\s*:\s*['"]static['"]/m;

async function nuxtConfigDeclaresStatic(cwd: string): Promise<boolean> {
  for (const name of ["nuxt.config.mjs", "nuxt.config.ts", "nuxt.config.js"]) {
    try {
      const txt = stripJsComments(await fs.readFile(path.join(cwd, name), "utf-8"));
      if (NUXT_STATIC_SSR_RE.test(txt) || NUXT_STATIC_PRESET_RE.test(txt)) return true;
      return false;  // config found, no static marker → SSR
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return false;
    }
  }
  return false;  // no config at all → defaults to SSR
}

async function hasVitepressConfig(cwd: string, prefix = ".vitepress"): Promise<boolean> {
  for (const name of ["config.ts", "config.js", "config.mts", "config.mjs"]) {
    try {
      await fs.access(path.join(cwd, prefix, name));
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function hasHugoConfigMarker(cwd: string): Promise<boolean> {
  for (const fn of ["config.toml", "config.yaml", "config.json"]) {
    try {
      const head = await fs.readFile(path.join(cwd, fn), "utf-8");
      if (HUGO_CONFIG_TOKENS.some((t) => head.includes(t))) return true;
    } catch {
      // try next
    }
  }
  return false;
}

interface AngularBuildCfg {
  builder?: unknown;
  options?: { outputPath?: unknown } | unknown;
}
interface AngularProject {
  architect?: { build?: AngularBuildCfg };
}
interface AngularJson {
  defaultProject?: string;
  projects?: Record<string, AngularProject>;
}

// Resolve Angular's real build output directory from angular.json.
// Lockstep with `core/builder/src/frameworks/angular.py:extract_output_dir`
// — same dual-detector-drift class as Next.js static-export, so the two
// implementations must agree (parity fixtures in
// core/tests/fixtures/framework-detect/angular-*).
//
// Resolution:
//   1. defaultProject if set & present, else first project in `projects`
//   2. project.architect.build.options.outputPath, else the CLI default
//      `dist/{projectName}`
//   3. strip leading `./`
//   4. append `/browser` for the Angular 17+ `application` builder
//      (builder id ends with `:application`) — it writes the served
//      assets one level deeper. We also probe disk in case the repo was
//      built locally before `layero deploy`.
// Returns the framework default `dist` on any parse error — matches
// AngularFramework.default_output_dir, and the builder re-derives the
// exact path at upload time anyway.
async function angularOutputDir(cwd: string): Promise<string> {
  const FALLBACK = "dist";
  let cfg: AngularJson;
  try {
    cfg = JSON.parse(await fs.readFile(path.join(cwd, "angular.json"), "utf-8")) as AngularJson;
  } catch {
    return FALLBACK;
  }
  const projects = cfg?.projects;
  if (!projects || typeof projects !== "object") return FALLBACK;
  const firstName = Object.keys(projects)[0];
  if (!firstName) return FALLBACK;
  const defaultName = cfg.defaultProject;
  const projectName = defaultName && projects[defaultName] ? defaultName : firstName;
  const buildCfg = projects[projectName]?.architect?.build;
  if (!buildCfg || typeof buildCfg !== "object") return FALLBACK;

  const opts = (buildCfg.options ?? {}) as { outputPath?: unknown };
  const rawOut = typeof opts === "object" && opts ? opts.outputPath : undefined;
  let out = typeof rawOut === "string" && rawOut.trim() ? rawOut.trim() : `dist/${projectName}`;
  if (out.startsWith("./")) out = out.slice(2);

  const builderId = typeof buildCfg.builder === "string" ? buildCfg.builder : "";
  const isApplicationBuilder = builderId.endsWith(":application");
  let browserExists = false;
  try {
    browserExists = (await fs.stat(path.join(cwd, out, "browser"))).isDirectory();
  } catch {
    // not built locally — rely on the builder-id signal below
  }
  return browserExists || isApplicationBuilder ? `${out}/browser` : out;
}
