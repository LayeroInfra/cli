import { promises as fs } from "node:fs";
import path from "node:path";

import * as dc from "layero-detection";

// Runtime apps route through the runtime-builder (container) pipeline, not the
// SPA static path. Mirrors detect_core (the unified spec) — kept in lockstep.
export type RuntimeKind = "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web";

export interface Detected {
  framework_hint: string;
  build_cmd: string;
  output_dir: string;
  // True when we matched a known framework signal. False = fell back to
  // "static"/"generic" because nothing recognisable was found.
  confident: boolean;
  // Set when the repo is a runtime app — the platform routes it through the
  // runtime-builder instead of the SPA static path. Absent for plain SPAs.
  runtime_kind?: RuntimeKind;
  // Pre-flight warning for repos the platform won't host as-is (Nuxt without a
  // static signal, SvelteKit with a server adapter).
  ssr_warning?: string;
}

interface PackageJson {
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

const HTML_SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "dist", "build", "out", "public"]);

async function dirHasHtml(base: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return false;
  }
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
    try {
      await fs.access(path.join(cwd, nested));
      files.add(nested);
    } catch {
      /* absent */
    }
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

/**
 * Detect framework / build command / output directory from the project shape.
 * Identity now comes from the unified detect_core (the same spec the builder
 * and backend wizard use); this function only adapts the resulting BuildPlan
 * into the CLI's `Detected` shape and its conventions (SSR Next reports `.next`,
 * runtime apps report a `static` placeholder + runtime_kind).
 */
export async function detectProject(cwd: string): Promise<Detected> {
  const snap = await snapshotFromDir(cwd);
  const plan = dc.detect(snap);

  if (plan.runtimeKind !== null) {
    if (plan.projectType === "ssr_next") {
      // SSR Next builds in the runtime-builder; surface the framework + the
      // `.next` dir the CLI has always reported (vestigial but expected).
      const [unit] = dc.detectFramework(snap, "nextjs");
      return {
        framework_hint: "nextjs",
        build_cmd: unit.buildCmd ?? "npx next build",
        output_dir: ".next",
        confident: true,
        runtime_kind: "ssr_next",
      };
    }
    // node_web / python_web / streamlit / gradio → static placeholder; the
    // container serves the app, the SPA pipeline is a no-op.
    return {
      framework_hint: "static",
      build_cmd: "true",
      output_dir: ".",
      confident: true,
      runtime_kind: plan.projectType as RuntimeKind,
    };
  }

  const framework = plan.framework;
  const build_cmd = plan.buildCmd ?? (framework === "static" ? "true" : "npm run build");
  const warning = ssrWarning(snap, framework);
  return {
    framework_hint: framework,
    build_cmd,
    output_dir: plan.outputDir ?? ".",
    confident: plan.confident,
    ...(warning ? { ssr_warning: warning } : {}),
  };
}
