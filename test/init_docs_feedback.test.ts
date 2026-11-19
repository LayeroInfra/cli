// Блок AGENTS.md от `layero init` несёт правило про отчёты о доках Layero
// (19.11.2026, core/docs/DOCS-FEEDBACK.md): агент читает этот файл как
// правило проекта, а врезку на странице доков пересказчик Claude Code вырезает.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("layero init → AGENTS.md", () => {
  it("содержит правило про отчёты о проблемах в документации Layero", () => {
    const dir = mkdtempSync(join(tmpdir(), "layero-init-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { vite: "5" } }));
    execFileSync("node", [join(__dirname, "..", "dist", "bin", "layero.js"), "init", "--yes"], {
      cwd: dir,
      env: { ...process.env, LAYERO_NO_UPDATE_CHECK: "1" },
      stdio: "ignore",
    });
    const doc = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(doc).toContain("### Layero docs problems");
    expect(doc).toContain("report_docs_issue");
    expect(doc).toContain("Send it only if they agree");
  });
});
