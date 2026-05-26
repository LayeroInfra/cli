/**
 * Parity tests for Next.js SSR vs static-export detection.
 *
 * Shared regression set with the builder
 * (`core/builder/tests/test_runtime_detect_parity.py`). Both detectors
 * read the same fixtures under `core/tests/fixtures/framework-detect/`
 * and must agree on every case.
 *
 * Drift between the two = the 2026-05-26 cyby.ai incident:
 * builder v72 correctly flagged SSR; CLI hardcoded
 * `output_dir='out'` for any Next.js. First CLI deploy of an SSR repo
 * crashed at detect.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectProject } from "../src/detect.js";

const FIXTURES = path.resolve(__dirname, "../../tests/fixtures/framework-detect");

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
