// `layero init` не записывает догадку детекта как настройку (T-20260918-7).
//
// До 0.11 `init` клал в `.layero/project.json` framework/build/output из
// детекта, а `deploy` читал их как выбор человека и отправлял в проект:
// `static`, угаданный для монорепо, глушил сборку на всех следующих выкатках.
// И тот же `static` уходил в AGENTS.md как факт о проекте.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCmd } from "../src/commands/init.js";
import { setMode } from "../src/agent.js";

let dir = "";
let prevCwd = "";

beforeEach(() => {
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  dir = mkdtempSync(path.join(os.tmpdir(), "layero-init-"));
  prevCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

async function run(): Promise<any[]> {
  const events: any[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
    events.push(JSON.parse(String(s)));
    return true;
  });
  try {
    await initCmd({ yes: true });
  } finally {
    spy.mockRestore();
  }
  return events;
}

describe("init", () => {
  it("монорепо: в project.json нет догадки, в AGENTS.md нет static", async () => {
    mkdirSync(path.join(dir, "apps/web"), { recursive: true });
    writeFileSync(path.join(dir, "README.md"), "# repo");
    writeFileSync(
      path.join(dir, "apps/web/package.json"),
      JSON.stringify({ name: "web", scripts: { build: "vite build" }, devDependencies: { vite: "^5" } }),
    );
    writeFileSync(path.join(dir, "apps/web/index.html"), "<div id=app></div>");

    const events = await run();
    const det = events.find((e) => e.event === "detected");
    expect(det.confident).toBe(false);
    expect(det.next_action).toBe("npx layero@latest deploy --root apps/web");

    const pj = JSON.parse(readFileSync(path.join(dir, ".layero/project.json"), "utf-8"));
    expect(pj).toEqual({ analytics_enabled: false, env_vars: {} });

    const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).not.toMatch(/\*\*static\*\*/);
    expect(agents).toMatch(/could not recognise the app here/);
    expect(agents).toMatch(/deploy --dry-run --json/);
    expect(agents).not.toMatch(/init first/i);
  });

  it("узнанный фреймворк назван в AGENTS.md", async () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "web", scripts: { build: "vite build" }, devDependencies: { vite: "^5" } }),
    );
    writeFileSync(path.join(dir, "index.html"), "<div id=app></div>");
    const events = await run();
    expect(events.find((e) => e.event === "init_done").confident).toBe(true);
    const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).toMatch(/detected by `init` as \*\*vite\*\*/);
  });
});
