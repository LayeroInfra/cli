import { promises as fs } from "node:fs";
import path from "node:path";

export interface Detected {
  framework_hint: string;
  build_cmd: string;
  output_dir: string;
  // True when we matched a known framework signal. False means we fell
  // back to "static" or "generic" because nothing recognisable was found.
  confident: boolean;
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
    if (hasDep(pkg, "next") || (await fileExists(cwd, "next.config.js", "next.config.mjs", "next.config.ts"))) {
      return {
        framework_hint: "nextjs",
        build_cmd: buildCmd(pkg, "npx next build"),
        output_dir: "out",
        confident: true,
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
      return {
        framework_hint: "nuxt",
        build_cmd: cmd,
        output_dir: ".output/public",
        confident: true,
      };
    }
    if (hasDep(pkg, "@sveltejs/kit") || (await fileExists(cwd, "svelte.config.js"))) {
      return {
        framework_hint: "sveltekit",
        build_cmd: buildCmd(pkg, "npx vite build"),
        output_dir: "build",
        confident: true,
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
    if (hasDep(pkg, "vite") || (await fileExists(cwd, "vite.config.ts", "vite.config.js", "vite.config.mjs"))) {
      return {
        framework_hint: "vite",
        build_cmd: buildCmd(pkg, "npx vite build"),
        output_dir: "dist",
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
