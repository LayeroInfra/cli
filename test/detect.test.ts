/**
 * Parity tests for Next.js SSR vs static-export detection.
 *
 * Shared regression set with the builder
 * (`core/builder/tests/test_runtime_detect_parity.py`). Both detectors
 * read the same fixtures and must agree on every case. The canonical set
 * lives in `core/tests/fixtures/framework-detect/`; this repository carries
 * a byte-identical copy under `test/fixtures/framework-detect/` so that
 * `npm test` works on a fresh public clone. `make check` diffs the copy
 * against `../core` whenever that checkout is present (check-fixtures).
 *
 * Drift between the two = the 2026-05-26 cyby.ai incident:
 * builder v72 correctly flagged SSR; CLI hardcoded
 * `output_dir='out'` for any Next.js. First CLI deploy of an SSR repo
 * crashed at detect.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectProject } from "../src/detect.js";

const FIXTURES = path.resolve(__dirname, "fixtures/framework-detect");

describe("Next.js detect parity (CLI side)", () => {
  it("flags SSR when next.config.js has no `output: 'export'`", async () => {
    const r = await detectProject(path.join(FIXTURES, "nextjs-ssr"));
    expect(r.framework_hint).toBe("nextjs");
    expect(r.runtime_kind).toBe("ssr_next");
    expect(r.output_dir).toBe(".next");
  });

  it("treats static-export `.mjs` config as plain SPA (no runtime_kind)", async () => {
    const r = await detectProject(path.join(FIXTURES, "nextjs-static-export"));
    expect(r.framework_hint).toBe("nextjs");
    expect(r.runtime_kind).toBeUndefined();
    expect(r.output_dir).toBe("out");
  });

  it("treats Next.js with no next.config as legacy static (no runtime_kind)", async () => {
    const r = await detectProject(path.join(FIXTURES, "nextjs-no-config"));
    expect(r.framework_hint).toBe("nextjs");
    expect(r.runtime_kind).toBeUndefined();
    expect(r.output_dir).toBe("out");
  });

  it("reads `.ts` config and respects `output: 'export'`", async () => {
    // Pre-v72 the detector only looked at .js/.mjs, so a TS-configured
    // static-export project got incorrectly routed to SSR. This case
    // pins the .ts read in place.
    const r = await detectProject(path.join(FIXTURES, "nextjs-ts-config"));
    expect(r.framework_hint).toBe("nextjs");
    expect(r.runtime_kind).toBeUndefined();
    expect(r.output_dir).toBe("out");
  });

  it("reads `.cjs` config and flags SSR when no export marker", async () => {
    // Symmetric to the .ts case: detector must scan .cjs too.
    const r = await detectProject(path.join(FIXTURES, "nextjs-cjs-config"));
    expect(r.framework_hint).toBe("nextjs");
    expect(r.runtime_kind).toBe("ssr_next");
    expect(r.output_dir).toBe(".next");
  });
});

describe("Nuxt SSR-warning parity (CLI side)", () => {
  it("flags Nuxt without `nuxt generate` or static marker", async () => {
    const r = await detectProject(path.join(FIXTURES, "nuxt-ssr"));
    expect(r.framework_hint).toBe("nuxt");
    expect(r.ssr_warning).toBeDefined();
    expect(r.ssr_warning).toMatch(/nuxt generate|ssr: false/);
  });

  it("does not warn when `generate` script is present", async () => {
    const r = await detectProject(path.join(FIXTURES, "nuxt-static"));
    expect(r.framework_hint).toBe("nuxt");
    expect(r.ssr_warning).toBeUndefined();
  });
});

describe("Remix / React Router v7 parity (CLI side)", () => {
  it("detects RR7 via @react-router/dev + react-router.config.ts → build/client", async () => {
    const r = await detectProject(path.join(FIXTURES, "remix-rr7"));
    expect(r.framework_hint).toBe("remix");
    expect(r.output_dir).toBe("build/client");
    expect(r.build_cmd).toBe("npm run build");
  });
});

describe("Angular output_dir parity (CLI side)", () => {
  it("appends /browser for the Angular 17+ `application` builder (no outputPath)", async () => {
    // angular.json: application builder, no explicit outputPath →
    // dist/{projectName}/browser. Before this branch existed the CLI fell
    // through to static (output_dir='.') and shipped raw sources.
    const r = await detectProject(path.join(FIXTURES, "angular-application-builder"));
    expect(r.framework_hint).toBe("angular");
    expect(r.runtime_kind).toBeUndefined();
    expect(r.build_cmd).toBe("npm run build");
    expect(r.output_dir).toBe("dist/ng-app/browser");
  });

  it("honours an explicit outputPath on the classic browser builder (no /browser suffix)", async () => {
    const r = await detectProject(path.join(FIXTURES, "angular-explicit-output"));
    expect(r.framework_hint).toBe("angular");
    expect(r.output_dir).toBe("dist/web");
  });

  it("falls back to `dist` when @angular/core is present but angular.json is missing", async () => {
    const r = await detectProject(path.join(FIXTURES, "angular-no-config"));
    expect(r.framework_hint).toBe("angular");
    expect(r.output_dir).toBe("dist");
  });
});

describe("SvelteKit SSR-warning parity (CLI side)", () => {
  it("flags SvelteKit with a non-static adapter", async () => {
    const r = await detectProject(path.join(FIXTURES, "sveltekit-ssr"));
    expect(r.framework_hint).toBe("sveltekit");
    expect(r.ssr_warning).toBeDefined();
    expect(r.ssr_warning).toMatch(/adapter-node|серверный адаптер/);
  });

  it("does not warn when adapter-static is present", async () => {
    const r = await detectProject(path.join(FIXTURES, "sveltekit-static"));
    expect(r.framework_hint).toBe("sveltekit");
    expect(r.ssr_warning).toBeUndefined();
  });
});

describe("Python backend (python_web) parity (CLI side)", () => {
  it("detects Flask (app.py + flask in requirements) as python_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "flask-app"));
    expect(r.runtime_kind).toBe("python_web");
  });

  it("detects FastAPI (main.py + fastapi in requirements) as python_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "fastapi-app"));
    expect(r.runtime_kind).toBe("python_web");
  });

  it("detects Starlette (ASGI) as python_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "py-starlette"));
    expect(r.runtime_kind).toBe("python_web");
  });

  it("detects Django (manage.py + django) as python_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "py-django"));
    expect(r.runtime_kind).toBe("python_web");
  });
});

describe("Node backend (node_web) parity (CLI side)", () => {
  it("detects Express as node_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "node-express"));
    expect(r.runtime_kind).toBe("node_web");
  });

  it("detects Fastify as node_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "node-fastify"));
    expect(r.runtime_kind).toBe("node_web");
  });

  it("detects NestJS as node_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "node-nestjs"));
    expect(r.runtime_kind).toBe("node_web");
  });

  it("does NOT flag a Vite frontend with express as node_web", async () => {
    const r = await detectProject(path.join(FIXTURES, "vite-with-express"));
    expect(r.runtime_kind).toBeUndefined();
  });
});
