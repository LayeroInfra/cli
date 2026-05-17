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
