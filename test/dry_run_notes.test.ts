// Подсказки сухого прогона по коду, а не по манифесту (T-20260919-9):
// сервер на localhost и проверка типов в скрипте сборки. Слабая модель и
// чистая комната 19.09.2026 тратили на это по сборке — текст отказа
// причину не называет.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { detectProject } from "../src/detect.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "layero-notes-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string | object>): string {
  const base = path.join(ROOT, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return base;
}

describe("dry-run notes", () => {
  it("Express на 127.0.0.1 — предупреждение с названием файла", async () => {
    const cwd = tree("loopback", {
      "package.json": { name: "api", scripts: { start: "node server/index.js" }, dependencies: { express: "^4" } },
      "server/index.js": 'const app = require("express")();\napp.listen(Number(process.env.PORT || 4000), "127.0.0.1");\n',
    });
    const d = await detectProject(cwd);
    expect(d.hint).toMatch(/server\/index\.js binds the server to localhost/);
    expect(d.hint).toMatch(/0\.0\.0\.0 and \$PORT/);
  });

  it("сервер на 0.0.0.0 предупреждения не получает", async () => {
    const cwd = tree("ok-bind", {
      "package.json": { name: "api", scripts: { start: "node index.js" }, dependencies: { express: "^4" } },
      "index.js": 'require("express")().listen(process.env.PORT, "0.0.0.0");\n',
    });
    const d = await detectProject(cwd);
    expect(d.hint ?? "").not.toMatch(/localhost/);
  });

  it("uvicorn --host 127.0.0.1 в скрипте запуска тоже ловится", async () => {
    const cwd = tree("py-loop", {
      "package.json": { name: "x", scripts: { start: "uvicorn main:app --host 127.0.0.1 --port 8000" } },
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    const d = await detectProject(cwd);
    expect(d.hint).toMatch(/start script binds the server to localhost/);
  });

  it("tsc в скрипте сборки — заметка про проверку типов", async () => {
    const cwd = tree("tsc", {
      "package.json": { name: "dash", scripts: { build: "tsc --noEmit && vite build" }, devDependencies: { vite: "^5", typescript: "^5" } },
      "index.html": '<!doctype html><script type="module" src="/src/main.ts"></script>',
      "src/main.ts": "export {};\n",
    });
    const d = await detectProject(cwd);
    expect(d.hint).toMatch(/TypeScript checker/);
    expect(d.confident).toBe(true);
  });
});
