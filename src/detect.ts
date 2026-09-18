import { promises as fs } from "node:fs";
import path from "node:path";

import * as dc from "layero-detection";

import type { Event } from "./agent.js";

// Runtime apps route through the runtime-builder (container) pipeline, not the
// SPA static path. Mirrors detect_core (the unified spec) — kept in lockstep.
export type RuntimeKind = "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";

/**
 * Откуда взялось значение плана. Строки читает агент, поэтому они словами, а
 * не кодами: `layero.json` и `--type` — объявлено человеком; `package.json`,
 * `framework config` — прочитано из репозитория; `framework default` —
 * умолчание фреймворка, в репозитории его нет; `none` — значения нет вовсе.
 */
export type ValueSource =
  | "layero.json"
  | "--type"
  | ".layero/project.json"
  | "project settings"
  | "package.json"
  | "framework config"
  | "framework default"
  | "detected"
  | "none";

export interface Detected {
  framework_hint: string;
  // null — сборки нет (статика, приложение в контейнере) или команду взять неоткуда.
  build_cmd: string | null;
  // null — каталог станет известен только после сборки.
  output_dir: string | null;
  // True only when the folder itself was recognised: a known framework, a
  // server, or ready-made files with index.html. False means "look at the
  // folder yourself" — `hint` says what the CLI saw instead.
  confident: boolean;
  // Set when the repo is a runtime app — the platform routes it through the
  // runtime-builder instead of the SPA static path. Absent for plain SPAs.
  runtime_kind?: RuntimeKind;
  // Pre-flight warning for repos the platform won't host as-is (Nuxt without a
  // static signal, SvelteKit with a server adapter).
  ssr_warning?: string;
  sources: { framework: ValueSource; build_cmd: ValueSource; output_dir: ValueSource; runtime_kind?: ValueSource };
  // What the CLI saw that the plan alone does not say, in plain words.
  hint?: string;
  // One concrete next step, when there is one.
  next_action?: string;
  // App folders found below the folder (monorepo, frontend/ + backend/).
  candidates?: string[];
}

export interface DetectOptions {
  // Framework named outside the repository: `--type`, `.layero/project.json`
  // or the project settings (dry run of a linked project). The builder hands
  // such a name to detection the same way; `framework` in layero.json still
  // wins over it.
  frameworkHint?: string | null;
  hintSource?: ValueSource;
}

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readJson(p: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const HTML_SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "dist", "build", "out", "public"]);

/**
 * Есть ли в дереве html, который можно отдать КАК ЕСТЬ.
 *
 * 🚨 Папка со своим `package.json` — это чужое приложение, и её `index.html`
 * — исходник, а не статика. Сборщик различает это с 23.08.2026
 * (`detect_core._dir_has_html`), а CLI — нет: у монорепо `apps/web/index.html`
 * поднимал флаг, и корень с одним README уверенно становился «static,
 * confident: true». Эту догадку CLI затем записывал в проект, и сборщик
 * выкладывал исходники Vite-приложения без сборки (симуляция 18.09.2026,
 * T-20260918-7).
 */
async function dirHasHtml(base: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return false;
  }
  if (depth > 0 && entries.some((e) => e.isFile() && e.name === "package.json")) return false;
  for (const e of entries) {
    if (e.isFile() && (e.name.endsWith(".html") || e.name.endsWith(".htm"))) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !HTML_SKIP_DIRS.has(e.name)) {
      if (await dirHasHtml(path.join(base, e.name), depth + 1)) return true;
    }
  }
  return false;
}

async function rootHasIndexHtml(cwd: string): Promise<boolean> {
  try {
    return (await fs.readdir(cwd)).some((n) => n.toLowerCase() === "index.html");
  } catch {
    return false;
  }
}

/** Build a detect_core Snapshot from the local filesystem (the CLI's disk
 * fidelity — the analogue of detect_core.py's snapshot_from_dir). */
async function snapshotFromDir(cwd: string): Promise<dc.Snapshot> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  try {
    for (const e of await fs.readdir(cwd, { withFileTypes: true })) {
      (e.isDirectory() ? dirs : files).add(e.name);
    }
  } catch {
    /* empty / unreadable cwd */
  }
  for (const nested of [
    ".vitepress/config.ts", ".vitepress/config.js", ".vitepress/config.mts", ".vitepress/config.mjs",
    "docs/.vitepress/config.ts", "docs/.vitepress/config.js", "docs/.vitepress/config.mts", "docs/.vitepress/config.mjs",
  ]) {
    if (await exists(path.join(cwd, nested))) files.add(nested);
  }

  const packageJson = (await readJson(path.join(cwd, "package.json"))) as PackageJson | null;
  const requirementsTxt = await readText(path.join(cwd, "requirements.txt"));
  const layeroJson = await readJson(path.join(cwd, "layero.json"));

  const configTexts: Record<string, string> = {};
  const candidates = new Set<string>(dc.CONFIG_TEXT_FILES);
  for (const bn of dc.CONFIG_TEXT_BASENAMES) for (const ext of dc.CONFIG_EXTENSIONS) candidates.add(bn + ext);
  // nuxt.config / svelte.config drive the SSR warning below.
  for (const n of ["nuxt.config.mjs", "nuxt.config.ts", "nuxt.config.js", "svelte.config.js", "svelte.config.ts"]) candidates.add(n);
  for (const name of candidates) {
    const t = await readText(path.join(cwd, name));
    if (t !== null) configTexts[name] = t.slice(0, 64 * 1024);
  }

  return dc.snapshotFromInputs({
    packageJson,
    requirementsTxt,
    files,
    dirs,
    configTexts,
    layeroJson: layeroJson && typeof layeroJson === "object" ? layeroJson : null,
    hasHtml: await dirHasHtml(cwd),
  });
}

const NUXT_STATIC_SSR_RE = /\bssr\s*:\s*false\b/m;
const NUXT_STATIC_PRESET_RE = /preset\s*:\s*['"]static['"]/m;
const JS_COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//gm;

function hasDep(pkg: PackageJson | null, name: string): boolean {
  return Boolean(pkg && ((pkg.dependencies ?? {})[name] ?? (pkg.devDependencies ?? {})[name]));
}

/** Mirror of the builder's static-host pre-flight warning for the two
 * frameworks that build a server by default (Nuxt, SvelteKit). */
function ssrWarning(snap: dc.Snapshot, framework: string): string | undefined {
  const pkg = snap.packageJson;
  if (framework === "nuxt") {
    const scripts = pkg?.scripts ?? {};
    const hasGenerate = Object.values(scripts).some((v) => typeof v === "string" && v.includes("nuxt generate"));
    let declaresStatic = false;
    for (const n of ["nuxt.config.mjs", "nuxt.config.ts", "nuxt.config.js"]) {
      const txt = snap.configTexts[n];
      if (txt !== undefined) {
        const stripped = txt.replace(JS_COMMENT_RE, "");
        declaresStatic = NUXT_STATIC_SSR_RE.test(stripped) || NUXT_STATIC_PRESET_RE.test(stripped);
        break;
      }
    }
    if (!hasGenerate && !declaresStatic) {
      return (
        "Nuxt без `nuxt generate` или `ssr: false` собирается как SSR-сервер; " +
        "Layero хостит только статику Nuxt. Добавьте `\"generate\": \"nuxt generate\"` " +
        "в scripts или поставьте `ssr: false` в nuxt.config."
      );
    }
  }
  if (framework === "sveltekit") {
    const hasStatic = hasDep(pkg, "@sveltejs/adapter-static");
    if (hasStatic) return undefined;
    const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const serverAdapter = Object.keys(allDeps).find(
      (d) => d.startsWith("@sveltejs/adapter-") && d !== "@sveltejs/adapter-static",
    );
    if (serverAdapter) {
      return `SvelteKit использует ${serverAdapter} (серверный адаптер). Layero хостит только статику — поставьте @sveltejs/adapter-static.`;
    }
    return "SvelteKit без явного адаптера — поставьте @sveltejs/adapter-static для статического хостинга.";
  }
  return undefined;
}

// ── Форма папки ─────────────────────────────────────────────────────────────
//
// Детект отвечает, ЧТО лежит в папке. Он не отвечает, почему в ней ничего не
// узнано: приложение в подпапке, две половины рядом, свой скрипт сборки или
// сервер без известного фреймворка. До 18.09.2026 на все эти формы CLI
// отвечал одним `static, confident: true` — и агенту оставалось верить.
// Ниже — подсказки для этих форм. Вердикта они не меняют: решает сборщик.

// Зеркало `_SCAN_SKIP` / `_APP_MANIFESTS` сборщика (`frameworks/base.py`,
// `find_app_subdirs`): кандидатов CLI называет по тому же правилу, по
// которому сборщик сам выбирает единственную папку приложения.
const SCAN_SKIP = new Set([
  "node_modules", ".git", ".github", ".cache", ".turbo", ".vercel",
  "coverage", "__pycache__", ".angular", ".next", ".nuxt", ".svelte-kit",
  "vendor", ".gradle",
]);
const APP_MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "layero.json", "go.mod", "Gemfile"];
const WORKSPACE_FILES = ["pnpm-workspace.yaml", "lerna.json", "rush.json", "turbo.json", "nx.json"];
const MAX_CANDIDATES = 12;

async function hasAppManifest(dir: string): Promise<boolean> {
  for (const m of APP_MANIFESTS) if (await exists(path.join(dir, m))) return true;
  return false;
}

/** Папки с манифестом приложения на глубине 1–2, мельчайшие первыми. */
async function findAppSubdirs(base: string, maxDepth = 2): Promise<string[]> {
  const found: string[] = [];
  async function walk(rel: string, depth: number): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SCAN_SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (await hasAppManifest(path.join(base, child))) {
        found.push(child);
        continue; // вложенные манифесты приложения — не отдельные приложения
      }
      if (depth + 1 < maxDepth) await walk(child, depth + 1);
    }
  }
  await walk("", 0);
  found.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return found;
}

type Role = "server" | "app" | "library" | "workspace" | "unknown";

interface Candidate {
  dir: string;
  role: Role;
  framework: string;
  outputDir: string | null;
  packageName?: string;
  // Импортирует соседний пакет воркспейса: `--root` выгрузил бы его без соседа.
  workspaceDeps: boolean;
}

const LOCAL_DEP_RE = /^(workspace:|file:|link:|portal:)/;

function scriptOf(pkg: PackageJson | null, name: string): string | null {
  const v = pkg?.scripts?.[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isWorkspaceContainer(snap: dc.Snapshot): boolean {
  const pkg = snap.packageJson as PackageJson | null;
  return Boolean(pkg && pkg.workspaces) || WORKSPACE_FILES.some((f) => snap.files.has(f));
}

async function describeCandidate(base: string, dir: string, siblingNames: Set<string>): Promise<Candidate> {
  const abs = path.join(base, dir);
  const snap = await snapshotFromDir(abs);
  const plan = dc.detect(snap);
  const pkg = snap.packageJson as PackageJson | null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const workspaceDeps = Object.entries(deps).some(
    ([name, v]) => (typeof v === "string" && LOCAL_DEP_RE.test(v)) || siblingNames.has(name),
  );
  let role: Role = "unknown";
  if (plan.runtimeKind !== null && plan.projectType !== "ssr_next") role = "server";
  else if (plan.runtimeKind !== null) role = "app";
  else if (plan.framework !== "static" && plan.framework !== "generic") role = "app";
  else if (await rootHasIndexHtml(abs)) role = "app";
  else if (isWorkspaceContainer(snap) && !scriptOf(pkg, "build")) role = "workspace";
  else if (pkg && (pkg.exports || pkg.main || pkg.module || pkg.types) && !scriptOf(pkg, "start")) role = "library";
  else if (scriptOf(pkg, "build") || scriptOf(pkg, "start")) role = "app";
  return {
    dir,
    role,
    framework: plan.framework,
    outputDir: plan.runtimeKind === null ? plan.outputDir : null,
    packageName: typeof pkg?.name === "string" ? pkg.name : undefined,
    workspaceDeps,
  };
}

async function describeCandidates(base: string, dirs: string[]): Promise<Candidate[]> {
  const names = new Set<string>();
  for (const d of dirs) {
    const pkg = (await readJson(path.join(base, d, "package.json"))) as PackageJson | null;
    if (pkg && typeof pkg.name === "string") names.add(pkg.name);
  }
  const out: Candidate[] = [];
  for (const d of dirs.slice(0, MAX_CANDIDATES)) {
    const own = (await readJson(path.join(base, d, "package.json"))) as PackageJson | null;
    const siblings = new Set([...names].filter((n) => n !== own?.name));
    out.push(await describeCandidate(base, d, siblings));
  }
  return out;
}

const FRONT_NAMES = ["frontend", "client", "web", "app", "site", "ui"];
const BACK_NAMES = ["backend", "server", "api"];

function pickByName(list: Candidate[], names: string[]): Candidate {
  return list.find((c) => names.includes(path.basename(c.dir).toLowerCase())) ?? list[0]!;
}

function label(c: Candidate): string {
  return `${c.dir} (${c.framework})`;
}

function fullstackRecipe(front: Candidate, back: Candidate): string {
  const fe: Record<string, string> = { root: front.dir };
  if (front.outputDir && front.outputDir !== "." && front.outputDir !== "dist") fe.output = front.outputDir;
  const be: Record<string, string> = { root: back.dir };
  if (back.framework && back.framework !== "generic") be.framework = back.framework;
  return JSON.stringify({ frontend: fe, backend: be, apiPrefix: "/api" });
}

function workspaceBuildCmd(snap: dc.Snapshot, c: Candidate): string {
  const pnpm = snap.files.has("pnpm-workspace.yaml") || snap.files.has("pnpm-lock.yaml");
  if (pnpm && c.packageName) return `pnpm --filter ${c.packageName}... build`;
  return "npm run build --workspaces --if-present";
}

interface Shape {
  hint: string;
  next_action?: string;
  candidates?: string[];
}

/**
 * Что сказать про папку, которую детект не узнал.
 *
 * Порядок — от самой частой формы в отказах прода (монорепо и не та папка —
 * 14,8 % отказов, серии до 61 подряд) к редким.
 */
async function shapeOf(cwd: string, snap: dc.Snapshot, plan: dc.BuildPlan): Promise<Shape | null> {
  const pkg = snap.packageJson as PackageJson | null;
  const dirs = await findAppSubdirs(cwd);
  const described = await describeCandidates(cwd, dirs);
  const apps = described.filter((c) => c.role === "app" || c.role === "server");
  const candidates = apps.map((c) => c.dir);

  const servers = apps.filter((c) => c.role === "server");
  const fronts = apps.filter((c) => c.role === "app");
  if (servers.length >= 1 && fronts.length >= 1) {
    const front = pickByName(fronts, FRONT_NAMES);
    const back = pickByName(servers, BACK_NAMES);
    return {
      hint:
        `${label(front)} looks like the site and ${label(back)} like its server. ` +
        "Without layero.json the platform builds only one app folder, so the other half would be missing. " +
        "Describe both halves in layero.json at the root of this folder.",
      next_action: `create layero.json here: ${fullstackRecipe(front, back)} — then deploy from this folder`,
      candidates,
    };
  }

  if (apps.length === 1) {
    const c = apps[0]!;
    const workspace = isWorkspaceContainer(snap);
    if (c.workspaceDeps) {
      const out = `${c.dir}/${c.outputDir && c.outputDir !== "." ? c.outputDir : "dist"}`;
      const recipe = { framework: "generic", buildCommand: workspaceBuildCmd(snap, c), outputDirectory: out };
      return {
        hint:
          `The app is ${label(c)}, and it imports a neighbour package of the workspace. ` +
          `--root ${c.dir} would upload the app without that package, so build it from this folder: ` +
          "a buildCommand that builds the neighbours first, and the app's output folder.",
        next_action: `create layero.json here: ${JSON.stringify(recipe)} — then deploy from this folder`,
        candidates,
      };
    }
    return {
      hint:
        `This folder has no app of its own${workspace ? " (it is a workspace root)" : ""}; the app is ${label(c)}. ` +
        "Deploy that folder.",
      next_action: `npx layero@latest deploy --root ${c.dir}`,
      candidates,
    };
  }

  if (apps.length > 1) {
    return {
      hint:
        `Several app folders: ${apps.map(label).join(", ")}. ` +
        "One project deploys one of them — pick it with --root.",
      next_action: `npx layero@latest deploy --root ${apps[0]!.dir}`,
      candidates,
    };
  }

  const build = scriptOf(pkg, "build");
  if (build && plan.framework === "static") {
    return {
      hint:
        `package.json has a build script (\`${build}\`), but no known framework was recognised and there is no index.html at the root. ` +
        "As it stands the platform serves these files as they are and does NOT run the build (framework \"static\").",
      next_action: snap.layeroJson
        ? 'if the site must be built, add "framework": "generic" to layero.json ' +
          "(buildCommand runs your script; outputDirectory is the folder that holds index.html after the build)"
        : "if the site must be built, create layero.json: " +
          '{"framework":"generic","buildCommand":"npm run build","outputDirectory":"<folder that holds index.html after the build>"}',
    };
  }
  if (build) {
    return {
      hint:
        `No known framework: the platform will run the build script (\`${build}\`) and serve the folder where index.html appears after the build. ` +
        "If it lands somewhere unexpected, set outputDirectory in layero.json.",
    };
  }

  const start = scriptOf(pkg, "start");
  const serverEntry = await findServerEntry(cwd, pkg);
  if (start || serverEntry) {
    // Без скрипта `start` сборщик приложений перебирает свой список точек
    // входа (server.js, index.js, …) и `server.mjs` не находит — одного
    // `-t node_web` мало, команду запуска надо назвать (кейс a3).
    return {
      hint:
        `This looks like a Node server (${start ? `start script \`${start}\`` : `${serverEntry} calls listen()`}), ` +
        "but no known server framework was recognised. A server has to be run in a container, not served as files.",
      next_action: start
        ? `npx layero@latest deploy -t node_web  (the start script runs the server)`
        : `create layero.json: {"runtime":"node_web","startCommand":"node ${serverEntry}"}`,
    };
  }
  if (snap.requirementsTxt !== null || snap.files.has("pyproject.toml")) {
    const app = await findPythonApp(cwd);
    if (app) {
      // Детект платформы ищет точку входа только в корне (main.py, app.py…);
      // приложение в пакете (`service/web.py`) он не видит. Кейс b3.
      const cmd = app.kind === "wsgi"
        ? `gunicorn ${app.target} --bind 0.0.0.0:$PORT`
        : `uvicorn ${app.target} --host 0.0.0.0 --port $PORT`;
      return {
        hint:
          `A Python web app (${app.framework}) whose entry is not at the root: \`${app.target}\`. ` +
          "The platform looks for main.py / app.py at the root, so name the app and how to start it.",
        next_action: `create layero.json: {"runtime":"python_web","startCommand":"${cmd}"}`,
      };
    }
    return {
      hint: "A Python project, but no known web framework or entry file was recognised.",
      next_action:
        'npx layero@latest deploy -t python_web  (or layero.json: {"runtime":"python_web","startCommand":"uvicorn <module>:<app> --host 0.0.0.0 --port $PORT"})',
    };
  }
  return {
    hint:
      "Nothing to build or serve was recognised here: no index.html, no build script, no server, no app in a subfolder.",
    next_action:
      "run the command from the app's folder (or pass --root <dir>); ready-made files: npx layero@latest deploy --prebuilt <dir>",
  };
}

/**
 * Каталог результата, заданный ФЛАГОМ в скрипте сборки (`vite build --outDir
 * public_html`). Детект читает конфиги, а не флаги, — сборщик без
 * `outputDirectory` ищет в умолчании фреймворка и может отдать исходный
 * `index.html` из корня вместо собранного. Кейс «слепого» агента b1.
 */
const OUTDIR_FLAG_RE = /(?:^|\s)--(?:outDir|out-dir|outdir|output-dir|dist-dir)(?:=|\s+)(["']?)([^\s"'&|;]+)\1/;

function outDirFlag(pkg: PackageJson | null): string | null {
  const m = OUTDIR_FLAG_RE.exec(scriptOf(pkg, "build") ?? "");
  return m ? m[2]!.replace(/^\.\//, "").replace(/\/+$/, "") || null : null;
}

const SERVER_ENTRY_CANDIDATES = ["server.js", "index.js", "app.js", "main.js", "server.mjs", "index.mjs"];

// `api = FastAPI(`, `app = Flask(__name__)` — объект приложения на верхнем
// уровне модуля. ASGI запускает uvicorn, WSGI — gunicorn.
const PY_APP_RE = /^(\w+)\s*=\s*(FastAPI|Starlette|Flask|Quart|Litestar)\s*\(/m;
const PY_ASGI = new Set(["FastAPI", "Starlette", "Quart", "Litestar"]);
const PY_SKIP = new Set([".venv", "venv", "env", "node_modules", ".git", "__pycache__", "site-packages", "tests", "test"]);

async function findPythonApp(
  cwd: string,
  maxDepth = 3,
): Promise<{ target: string; framework: string; kind: "asgi" | "wsgi" } | null> {
  const found: Array<{ rel: string; name: string; framework: string }> = [];
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length > 3) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && e.name.endsWith(".py")) {
        const text = await readText(path.join(cwd, child));
        const m = text ? PY_APP_RE.exec(text.slice(0, 64 * 1024)) : null;
        if (m) found.push({ rel: child, name: m[1]!, framework: m[2]! });
      } else if (e.isDirectory() && !PY_SKIP.has(e.name) && !e.name.startsWith(".")) {
        await walk(child, depth + 1);
      }
    }
  }
  await walk("", 0);
  // Одно приложение — называем; несколько — гадать, какое главное, не берёмся.
  if (found.length !== 1) return null;
  const f = found[0]!;
  const module = f.rel.replace(/\.py$/, "").replace(/\//g, ".").replace(/\.__init__$/, "");
  return {
    target: `${module}:${f.name}`,
    framework: f.framework,
    kind: PY_ASGI.has(f.framework) ? "asgi" : "wsgi",
  };
}
const LISTEN_RE = /\.listen\s*\(|createServer\s*\(/;

async function findServerEntry(cwd: string, pkg: PackageJson | null): Promise<string | null> {
  const names = [...(typeof pkg?.main === "string" ? [pkg.main] : []), ...SERVER_ENTRY_CANDIDATES];
  for (const n of names) {
    const text = await readText(path.join(cwd, n));
    if (text !== null && LISTEN_RE.test(text.slice(0, 64 * 1024))) return n;
  }
  return null;
}

/** Первая папка с index.html, если в корне его нет, — по правилу сборщика
 * (`discover_served_root`): мельчайшая, затем по алфавиту. */
async function servedSubdir(cwd: string, maxDepth = 3): Promise<string | null> {
  let best: { rel: string; depth: number } | null = null;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((e) => e.isFile() && e.name === "package.json")) return;
    if (depth > 0 && entries.some((e) => e.isFile() && e.name.toLowerCase() === "index.html")) {
      if (!best || depth < best.depth || (depth === best.depth && rel.localeCompare(best.rel) < 0)) {
        best = { rel, depth };
      }
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SCAN_SKIP.has(e.name) && !e.name.startsWith(".")) {
        await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    }
  }
  await walk("", 0);
  return best ? (best as { rel: string }).rel : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const BUILD_SOURCE: Record<string, ValueSource> = {
  detected: "package.json",
  default: "framework default",
  guess: "framework default",
  unknown: "none",
};
const OUTPUT_SOURCE: Record<string, ValueSource> = {
  detected: "framework config",
  default: "framework default",
  guess: "framework default",
  unknown: "none",
};

/**
 * Detect framework / build command / output directory from the project shape.
 * Identity now comes from the unified detect_core (the same spec the builder
 * and backend wizard use); this function adapts the resulting BuildPlan into
 * the CLI's `Detected` shape and says honestly how sure it is.
 *
 * 🚨 ЭТО ПОДСКАЗКА, А НЕ РЕШЕНИЕ. Решает сборщик: он видит архив целиком и на
 * первой сборке применяет правила, которых в TS-ядре нет. До 18.09.2026 CLI
 * отправлял свою догадку в настройки проекта, и она перебивала сборщик на
 * каждой следующей сборке (`(from hint)`, `(from dashboard)` в логе у проекта,
 * который никто не настраивал). Теперь `deploy` отправляет только то, что
 * назвал человек, а этот результат — только показывает.
 */
export async function detectProject(cwd: string, opts: DetectOptions = {}): Promise<Detected> {
  const snap = await snapshotFromDir(cwd);
  const layero = snap.layeroJson;
  const fileFramework = str(layero?.framework);
  const outsideHint = fileFramework ? null : str(opts.frameworkHint);
  const plan = dc.detect(snap, fileFramework ?? outsideHint);
  const frameworkSource: ValueSource = fileFramework
    ? "layero.json"
    : outsideHint
      ? (opts.hintSource ?? "--type")
      : "detected";

  if (plan.runtimeKind !== null) {
    // Файл объявил, КАК запускать (`runtime`, фуллстек-блоки), — это не то же
    // самое, что назвать фреймворк: имя (`fastapi`, `express`) детект берёт из
    // зависимостей. Без этого различия `sources.framework` приписывал файлу
    // ключ, которого в нём нет (прогон evals 19.09, кейс b3).
    const kindFromFile = layero !== null && (str(layero.runtime) !== null || plan.projectKind === "fullstack");
    const nameFromFile =
      fileFramework !== null ||
      (plan.projectKind === "fullstack" && str((layero?.backend as Record<string, unknown> | undefined)?.framework) !== null);
    const sources = {
      framework: (nameFromFile ? "layero.json" : frameworkSource) as ValueSource,
      build_cmd: "none" as ValueSource,
      output_dir: "none" as ValueSource,
      runtime_kind: (kindFromFile ? "layero.json" : "detected") as ValueSource,
    };
    if (plan.projectType === "ssr_next") {
      // SSR Next builds in the runtime-builder; surface the framework + the
      // `.next` dir the CLI has always reported (vestigial but expected).
      const [unit] = dc.detectFramework(snap, "nextjs");
      const script = snap.packageJson?.scripts?.build;
      return {
        framework_hint: "nextjs",
        build_cmd: unit.buildCmd ?? "npx next build",
        output_dir: ".next",
        confident: true,
        runtime_kind: "ssr_next",
        sources: { ...sources, build_cmd: script ? "package.json" : "framework default", output_dir: "framework default" },
      };
    }
    // node_web / python_web / streamlit / gradio / fullstack: the container
    // serves the app, nothing is uploaded as static files from this plan.
    return {
      framework_hint: plan.framework,
      build_cmd: null,
      output_dir: null,
      confident: true,
      runtime_kind: plan.projectType as RuntimeKind,
      sources,
      ...(plan.projectKind === "fullstack"
        ? { hint: "Full-stack layout from layero.json: the frontend is served as files, the backend runs in a container." }
        : {}),
    };
  }

  const framework = plan.framework;
  const fileBuild = str(layero?.build);
  const fileOutput = str(layero?.output);
  let buildCmd: string | null = plan.buildCmd;
  let buildSource: ValueSource = BUILD_SOURCE[plan.fieldSources.build_cmd ?? "unknown"] ?? "none";
  let outputDir: string | null = plan.outputDir;
  let outputSource: ValueSource = OUTPUT_SOURCE[plan.fieldSources.output_dir ?? "unknown"] ?? "none";
  // Фреймворк назван человеком (файл, `--type`, настройки) — это не догадка.
  const declared = Boolean(fileFramework || outsideHint);
  let confident = declared || plan.confident;
  let shape: Shape | null = null;
  const notes: string[] = [];
  let flagNextAction: string | undefined;

  if (framework === "static") {
    // Статика не собирается НИКОГДА: команда сборки у неё не «true», а
    // отсутствует. Заглушка `true` читалась как команда и уезжала в проект.
    buildCmd = null;
    buildSource = "none";
    outputDir = ".";
    outputSource = "detected";
    const pkg = snap.packageJson as PackageJson | null;
    const buildScript = scriptOf(pkg, "build");
    if (await rootHasIndexHtml(cwd)) {
      confident = true;
      if (buildScript && !declared) {
        notes.push(
          `package.json has a build script (\`${buildScript}\`), but a static site is served as it is and the script is not run. ` +
            'If it must run: layero.json {"framework":"generic","buildCommand":"npm run build","outputDirectory":"<folder>"}.',
        );
      }
    } else {
      const sub = buildScript || fileOutput ? null : await servedSubdir(cwd);
      if (sub) {
        confident = true;
        outputDir = sub;
        notes.push(`index.html is not at the root: the platform serves ${sub}/.`);
      } else if (declared) {
        if (!fileOutput) {
          notes.push(
            "There is no index.html at the root of this folder, and a static site is served as it is: " +
              "point outputDirectory at the folder with index.html, or deploy ready-made files with --prebuilt <dir>.",
          );
        }
      } else {
        confident = false;
        shape = await shapeOf(cwd, snap, plan);
      }
    }
    if (fileBuild) {
      notes.push(
        'layero.json sets buildCommand, but the framework is "static", which never builds: the command will NOT run. ' +
          'Set "framework" in layero.json (for a custom build script: "generic").',
      );
    }
  } else {
    if (fileBuild) {
      buildCmd = fileBuild;
      buildSource = "layero.json";
    }
    if (framework === "generic" && !declared) {
      confident = false;
      shape = await shapeOf(cwd, snap, plan);
    }
    const flagDir = fileOutput ? null : outDirFlag(snap.packageJson as PackageJson | null);
    if (flagDir && flagDir !== outputDir) {
      // План платформы положит результат не туда: она не читает флаги скрипта.
      confident = false;
      notes.push(
        `The build script sets the output folder with a flag (\`${flagDir}\`), which detection does not read: ` +
          `without outputDirectory the platform looks in "${outputDir ?? "dist"}" and may serve the source index.html instead of the build.`,
      );
      flagNextAction = snap.layeroJson
        ? `add "outputDirectory": "${flagDir}" to layero.json`
        : `create layero.json: {"outputDirectory":"${flagDir}"}`;
    }
    if (framework === "generic" && buildCmd === null) {
      // Собирать нечем — и каталог результата у такой папки не «dist по
      // умолчанию», а неизвестен: умолчание фреймворка «Other» здесь вымысел.
      outputDir = null;
      outputSource = "none";
    }
  }
  if (fileOutput) {
    outputDir = fileOutput;
    outputSource = "layero.json";
  }

  const warning = ssrWarning(snap, framework);
  const hint = [shape?.hint, ...notes].filter(Boolean).join(" ");
  return {
    framework_hint: framework,
    build_cmd: buildCmd,
    output_dir: outputDir,
    confident,
    sources: { framework: frameworkSource, build_cmd: buildSource, output_dir: outputSource },
    ...(hint ? { hint } : {}),
    ...(shape?.next_action ?? flagNextAction ? { next_action: shape?.next_action ?? flagNextAction } : {}),
    ...(shape?.candidates?.length ? { candidates: shape.candidates } : {}),
    ...(warning ? { ssr_warning: warning } : {}),
  };
}

/** Событие `detected` — одно на `init`, `deploy` и `deploy --dry-run`. */
export function detectedEvent(d: Detected): Extract<Event, { event: "detected" }> {
  return {
    event: "detected",
    framework: d.framework_hint,
    build_cmd: d.build_cmd,
    output_dir: d.output_dir,
    confident: d.confident,
    sources: d.sources,
    ...(d.runtime_kind ? { runtime_kind: d.runtime_kind } : {}),
    ...(d.hint ? { hint: d.hint } : {}),
    ...(d.next_action ? { next_action: d.next_action } : {}),
    ...(d.candidates?.length ? { candidates: d.candidates } : {}),
    ...(d.ssr_warning ? { ssr_warning: d.ssr_warning } : {}),
  };
}
