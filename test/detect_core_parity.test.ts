// The TS detection core (vendored detect_core.ts) must agree with the Python
// detect_core / builder oracle. The fixture-based detect.test.ts already
// exercises it end-to-end through detectProject; this pins the BuildPlan-level
// contract (identity + output + build_cmd + runtime + package manager) on the
// same scenarios as core/detection/test_parity.py, so TS↔Python drift fails CI.
import { describe, expect, it } from "vitest";

import * as dc from "../src/_detection/detect_core.js";

function snap(opts: Parameters<typeof dc.snapshotFromInputs>[0]) {
  return dc.snapshotFromInputs(opts);
}
const pkg = (deps: Record<string, string>, scripts?: Record<string, string>) => ({
  dependencies: deps,
  ...(scripts ? { scripts } : {}),
});

describe("detect_core.ts ↔ Python parity (BuildPlan)", () => {
  const cases: Array<[string, Parameters<typeof dc.snapshotFromInputs>[0], Partial<dc.BuildPlan> & { build?: string | null }]> = [
    ["vite", { packageJson: pkg({ vite: "^5" }, { build: "vite build" }), files: ["package.json", "vite.config.ts"] },
      { framework: "vite", outputDir: "dist", projectType: "spa", build: "npm run build" }],
    ["vite_no_script", { packageJson: pkg({ vite: "^5" }), files: ["package.json"] },
      { framework: "vite", outputDir: "dist", build: "npx vite build" }],
    ["vite_custom_out", { packageJson: pkg({ vite: "^5" }, { build: "vite build" }), files: ["package.json", "vite.config.ts"], configTexts: { "vite.config.ts": "export default { build: { outDir: 'bundle' } }" } },
      { framework: "vite", outputDir: "bundle" }],
    ["next_export", { packageJson: pkg({ next: "^14" }, { build: "next build" }), files: ["package.json", "next.config.js"], configTexts: { "next.config.js": "export default { output: 'export' }" } },
      { framework: "nextjs", outputDir: "out", projectType: "spa" }],
    ["next_ssr", { packageJson: pkg({ next: "^14" }, { build: "next build" }), files: ["package.json", "next.config.js"], configTexts: { "next.config.js": "export default {}" } },
      { projectType: "ssr_next", runtimeKind: "ssr_node" }],
    ["nuxt", { packageJson: pkg({ nuxt: "^3" }, { generate: "nuxt generate" }), files: ["package.json"] },
      { framework: "nuxt", outputDir: ".output/public", build: "npm run generate" }],
    ["nuxt_no_gen", { packageJson: pkg({ nuxt: "^3" }), files: ["package.json"] },
      { framework: "nuxt", build: "npx nuxt generate" }],
    ["storybook_dep", { packageJson: pkg({ vite: "^5", "@storybook/react": "^8" }, { "build-storybook": "storybook build" }), files: ["package.json"] },
      { framework: "storybook", outputDir: "storybook-static", build: "npm run build-storybook" }],
    ["vitepress_docs", { packageJson: pkg({ vitepress: "^1" }), files: ["package.json", "docs/.vitepress/config.ts"] },
      { framework: "vitepress", outputDir: "docs/.vitepress/dist", build: "npx vitepress build" }],
    ["angular", { packageJson: pkg({ "@angular/core": "^17" }, { build: "ng build" }), files: ["package.json", "angular.json"], configTexts: { "angular.json": '{"projects":{"app":{"architect":{"build":{"builder":"x:application","options":{"outputPath":"dist/app"}}}}}}' } },
      { framework: "angular", outputDir: "dist/app/browser", build: "npm run build" }],
    ["hugo", { files: ["hugo.toml"] }, { framework: "hugo", outputDir: "public", build: "hugo --gc --minify" }],
    ["static", { files: ["index.html"], hasHtml: true }, { framework: "static", outputDir: ".", build: null }],
    ["generic_no_build", { packageJson: pkg({ "some-lib": "^1" }), files: ["package.json"] },
      { framework: "generic", outputDir: "dist", build: null }],
    ["node_jsonserver", { packageJson: pkg({ "json-server": "^1" }), files: ["package.json"] },
      { projectType: "node_web", runtimeKind: "node_web" }],
    ["express_plus_vite", { packageJson: pkg({ express: "^4", vite: "^5" }, { build: "vite build" }), files: ["package.json", "vite.config.ts"] },
      { framework: "vite", projectType: "spa" }],
    ["flask", { requirementsTxt: "flask\ngunicorn", files: ["requirements.txt", "app.py"] },
      { projectType: "python_web", runtimeKind: "python_web" }],
    ["streamlit", { requirementsTxt: "streamlit", files: ["requirements.txt", "app.py"] },
      { projectType: "streamlit", runtimeKind: "streamlit" }],
    ["pnpm", { packageJson: pkg({ vite: "^5" }, { build: "vite build" }), files: ["package.json", "pnpm-lock.yaml"] },
      { framework: "vite", packageManager: "pnpm", build: "pnpm run build" }],
    ["yarn", { packageJson: pkg({ vite: "^5" }, { build: "vite build" }), files: ["package.json", "yarn.lock"] },
      { framework: "vite", packageManager: "yarn", build: "yarn build" }],
    ["bun", { packageJson: pkg({ vite: "^5" }, { build: "vite build" }), files: ["package.json", "bun.lockb"] },
      { framework: "vite", packageManager: "bun", build: "bun run build" }],
    ["layero_fullstack", { layeroJson: { frontend: { root: "web", framework: "vite" }, backend: { root: "api", runtime: "node_web" }, api_prefix: "/api" } },
      { projectKind: "fullstack", projectType: "node_web" }],
  ];

  for (const [name, inputs, exp] of cases) {
    it(name, () => {
      const plan = dc.detect(snap(inputs));
      if (exp.framework !== undefined) expect(plan.framework, "framework").toBe(exp.framework);
      if (exp.outputDir !== undefined) expect(plan.outputDir, "outputDir").toBe(exp.outputDir);
      if (exp.projectType !== undefined) expect(plan.projectType, "projectType").toBe(exp.projectType);
      if (exp.projectKind !== undefined) expect(plan.projectKind, "projectKind").toBe(exp.projectKind);
      if (exp.runtimeKind !== undefined) expect(plan.runtimeKind, "runtimeKind").toBe(exp.runtimeKind);
      if (exp.packageManager !== undefined) expect(plan.packageManager, "packageManager").toBe(exp.packageManager);
      if ("build" in exp) expect(plan.buildCmd, "buildCmd").toBe(exp.build);
    });
  }

  it("fullstack splits into frontend + backend units", () => {
    const plan = dc.detect(snap({ layeroJson: { frontend: { root: "web", output: "build" }, backend: { root: "api", runtime: "python_web", start: "gunicorn app:app" } } }));
    expect(plan.units).toHaveLength(2);
    const fe = plan.units.find((u) => u.role === "frontend")!;
    const be = plan.units.find((u) => u.role === "backend")!;
    expect(fe.root).toBe("web");
    expect(fe.outputDir).toBe("build");
    expect(be.runtimeKind).toBe("python_web");
    expect(be.startCmd).toBe("gunicorn app:app");
  });
});
