/**
 * Честный детект: `confident` только там, где папку действительно узнали.
 *
 * Симуляция «слепого» агента 18.09.2026 (T-20260918-7): на монорепо, своём
 * скрипте сборки и фронте с бэкендом CLI отвечал `static, build_cmd: "true",
 * output_dir: ".", confident: true` — «ничего не узнал» выглядело как
 * уверенный ответ, а `init` и `deploy` записывали его в проект. Здесь — формы,
 * на которых он врал, и то, что CLI обязан сказать вместо этого.
 *
 * Папки собираются во временном каталоге: канон фикстур детекта живёт в core
 * и копируется сюда байт в байт, заводить вторую копию нельзя.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { detectProject, detectedEvent } from "../src/detect.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "layero-shape-"));
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

const VITE_APP = {
  "package.json": { name: "web", scripts: { build: "vite build" }, devDependencies: { vite: "^5" } },
  "index.html": '<!doctype html><div id="app"></div><script type="module" src="/src/main.ts"></script>',
};

function under(prefix: string, files: Record<string, string | object>): Record<string, string | object> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
}

describe("монорепо", () => {
  it("корень без приложения: не static, а подсказка --root", async () => {
    // До 0.11: `apps/web/index.html` поднимал флаг «в папке есть html», и
    // корень с одним README становился уверенной статикой.
    const dir = tree("mono", { "README.md": "# repo", ...under("apps/web", VITE_APP) });
    const d = await detectProject(dir);
    expect(d.confident).toBe(false);
    expect(d.framework_hint).not.toBe("static");
    expect(d.build_cmd).toBeNull();
    expect(d.candidates).toEqual(["apps/web"]);
    expect(d.next_action).toBe("npx layero@latest deploy --root apps/web");
    expect(d.hint).toMatch(/apps\/web \(vite\)/);
  });

  it("корень воркспейса со скриптом сборки: тоже подсказка --root", async () => {
    const dir = tree("mono-pnpm", {
      "package.json": { name: "root", private: true, scripts: { build: "pnpm -r build" } },
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      ...under("apps/web", VITE_APP),
    });
    const d = await detectProject(dir);
    expect(d.confident).toBe(false);
    expect(d.hint).toMatch(/workspace root/);
    expect(d.next_action).toBe("npx layero@latest deploy --root apps/web");
  });

  it("приложение импортирует соседний пакет: рецепт generic из корня, а не --root", async () => {
    // `--root apps/web` выгрузил бы приложение без `@acme/shared`.
    const dir = tree("mono-ws-deps", {
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      ...under("apps/web", {
        ...VITE_APP,
        "package.json": {
          name: "@acme/web",
          scripts: { build: "vite build" },
          dependencies: { "@acme/shared": "workspace:*" },
          devDependencies: { vite: "^5" },
        },
      }),
      "packages/shared/package.json": { name: "@acme/shared", exports: "./index.js", scripts: { build: "tsc" } },
    });
    const d = await detectProject(dir);
    expect(d.confident).toBe(false);
    expect(d.next_action).toContain('"framework":"generic"');
    expect(d.next_action).toContain("pnpm --filter @acme/web... build");
    expect(d.next_action).toContain('"outputDirectory":"apps/web/dist"');
  });

  it("несколько приложений: список и выбор через --root", async () => {
    const dir = tree("mono-two", { ...under("apps/web", VITE_APP), ...under("apps/admin", VITE_APP) });
    const d = await detectProject(dir);
    expect(d.confident).toBe(false);
    expect(d.candidates).toEqual(["apps/admin", "apps/web"]);
    expect(d.hint).toMatch(/Several app folders/);
  });
});

describe("фронт и бэк рядом", () => {
  it("подсказывает блоки layero.json, а не static", async () => {
    const dir = tree("fullstack", {
      ...under("frontend", VITE_APP),
      "backend/package.json": { name: "api", scripts: { start: "node server.js" }, dependencies: { express: "^4" } },
      "backend/server.js": "require('express')().listen(process.env.PORT)",
    });
    const d = await detectProject(dir);
    expect(d.confident).toBe(false);
    expect(d.hint).toMatch(/frontend \(vite\).*backend \(express\)/);
    expect(d.next_action).toContain('"frontend":{"root":"frontend"}');
    expect(d.next_action).toContain('"backend":{"root":"backend","framework":"express"}');
  });
});

describe("свой скрипт сборки", () => {
  it("html только в src/: говорит, что сборка НЕ запустится", async () => {
    // Кейс симуляции: `node build.js` пишет в public_html. Детект платформы
    // называет это статикой и сборку не запускает — CLI обязан сказать это до
    // выкатки, а не соврать «static, confident».
    const dir = tree("custom", {
      "package.json": { name: "custom", scripts: { build: "node build.js" } },
      "src/index.html": "<h1>hi</h1>",
      "build.js": "",
    });
    const d = await detectProject(dir);
    expect(d.framework_hint).toBe("static");
    expect(d.confident).toBe(false);
    expect(d.build_cmd).toBeNull();
    expect(d.hint).toMatch(/does NOT run the build/);
    expect(d.next_action).toContain('"framework":"generic"');
  });

  it("без html: generic, команда из package.json, каталог — после сборки", async () => {
    const dir = tree("custom-nohtml", { "package.json": { name: "x", scripts: { build: "node build.js" } } });
    const d = await detectProject(dir);
    expect(d.framework_hint).toBe("generic");
    expect(d.confident).toBe(false);
    expect(d.build_cmd).toBe("npm run build");
    expect(d.sources.build_cmd).toBe("package.json");
  });

  it("generic без скрипта сборки не выдумывает `npm run build`", async () => {
    // До 0.11 CLI подставлял `npm run build` и `dist` там, где их нет.
    const dir = tree("server-plain", {
      "package.json": { name: "srv", main: "server.js" },
      "server.js": "require('http').createServer(() => {}).listen(process.env.PORT)",
    });
    const d = await detectProject(dir);
    expect(d.build_cmd).toBeNull();
    expect(d.output_dir).toBeNull();
    expect(d.confident).toBe(false);
    expect(d.next_action).toContain("-t node_web");
  });
});

describe("статика", () => {
  it("index.html в корне — уверенная статика без команды сборки", async () => {
    const d = await detectProject(tree("plain", { "index.html": "<h1>ok</h1>" }));
    expect(d.framework_hint).toBe("static");
    expect(d.confident).toBe(true);
    expect(d.build_cmd).toBeNull();
    expect(d.output_dir).toBe(".");
    expect(d.hint).toBeUndefined();
  });

  it("index.html в подпапке без манифеста — раздаётся эта подпапка", async () => {
    const d = await detectProject(tree("staticsub", { "README.md": "# r", "site/index.html": "<h1>ok</h1>" }));
    expect(d.confident).toBe(true);
    expect(d.output_dir).toBe("site");
  });

  it("статика со скриптом build: предупреждает, что скрипт не запустится", async () => {
    const d = await detectProject(tree("static-tailwind", {
      "index.html": "<h1>ok</h1>",
      "package.json": { name: "t", scripts: { build: "tailwindcss -o out.css" } },
    }));
    expect(d.confident).toBe(true);
    expect(d.hint).toMatch(/script is not run/);
  });

  it("пустая папка — не «уверенная статика»", async () => {
    const d = await detectProject(tree("empty", { "README.md": "# nothing" }));
    expect(d.confident).toBe(false);
    expect(d.hint).toMatch(/Nothing to build or serve/);
  });
});

describe("layero.json в плане", () => {
  it("framework/buildCommand/outputDirectory из файла видны в detected", async () => {
    // До 0.11 `detected` читал из файла только runtime: после правки
    // layero.json агент продолжал видеть static и не верил своему файлу.
    const d = await detectProject(tree("layero-generic", {
      "package.json": { name: "c", scripts: { build: "node build.js" } },
      "src/index.html": "<h1>x</h1>",
      "layero.json": { framework: "generic", buildCommand: "npm run build", outputDirectory: "public_html" },
    }));
    expect(d.framework_hint).toBe("generic");
    expect(d.confident).toBe(true);
    expect(d.build_cmd).toBe("npm run build");
    expect(d.output_dir).toBe("public_html");
    expect(d.sources).toEqual({ framework: "layero.json", build_cmd: "layero.json", output_dir: "layero.json" });
  });

  it("static + buildCommand: предупреждает, что команда не выполнится", async () => {
    const d = await detectProject(tree("layero-static-build", {
      "package.json": { name: "c", scripts: { build: "node build.js" } },
      "src/index.html": "<h1>x</h1>",
      "layero.json": { buildCommand: "npm run build", outputDirectory: "public_html" },
    }));
    expect(d.framework_hint).toBe("static");
    expect(d.build_cmd).toBeNull();
    expect(d.hint).toMatch(/never builds: the command will NOT run/);
  });
});

describe("подсказка извне", () => {
  it("--type называет фреймворк — это не догадка", async () => {
    const d = await detectProject(tree("hinted", { "src/index.html": "<h1>x</h1>" }), {
      frameworkHint: "generic",
      hintSource: "--type",
    });
    expect(d.framework_hint).toBe("generic");
    expect(d.confident).toBe(true);
    expect(d.sources.framework).toBe("--type");
  });

  it("layero.json сильнее подсказки", async () => {
    const d = await detectProject(
      tree("hinted-file", { "index.html": "x", "layero.json": { framework: "static" } }),
      { frameworkHint: "vite", hintSource: "project settings" },
    );
    expect(d.framework_hint).toBe("static");
    expect(d.sources.framework).toBe("layero.json");
  });
});

describe("событие detected", () => {
  it("несёт сырой тип сервера, а не заглушку static/true/.", async () => {
    const d = await detectProject(tree("express", {
      "package.json": { name: "s", dependencies: { express: "^4" } },
      "server.js": "require('express')().listen(3000)",
    }));
    const e = detectedEvent(d);
    expect(e.runtime_kind).toBe("node_web");
    expect(e.framework).toBe("express");
    expect(e.build_cmd).toBeNull();
    expect(e.output_dir).toBeNull();
    expect(e.confident).toBe(true);
  });
});

describe("совет учитывает существующий layero.json", () => {
  it("файл есть — дописать framework, а не создавать заново", async () => {
    const d = await detectProject(tree("custom-with-file", {
      "package.json": { name: "c", scripts: { build: "node build.js" } },
      "src/index.html": "<h1>x</h1>",
      "layero.json": { buildCommand: "npm run build", outputDirectory: "public_html" },
    }));
    expect(d.next_action).toMatch(/^if the site must be built, add "framework": "generic" to layero.json/);
  });
});
