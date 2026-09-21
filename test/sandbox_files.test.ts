// Файлы песочницы на диске (T-20260921, T-20260919-3): код забора — в
// ~/.layero/config.json, не в .layero/project.json; мёртвая песочница
// забывается и отвязывается, не задевая остального.
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const home = mkdtempSync(path.join(os.tmpdir(), "layero-home-"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

describe("claim_hygiene: файлы песочницы", () => {
  it("saveClaim и forgetSandbox правят только своё и держат права 0600", async () => {
    const { saveClaim, forgetSandbox } = await import("../src/config.js");
    mkdirSync(path.join(home, ".layero"), { recursive: true });
    const file = path.join(home, ".layero", "config.json");
    writeFileSync(file, JSON.stringify({ apiUrl: "https://api.layero.ru", token: "user", claim_tokens: { a: "ta", b: "tb" } }));
    await saveClaim("a", { code: "CODE-A", claim_url: "https://x/claim?code=CODE-A", expires_at: "t" });
    let cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.claims.a.code).toBe("CODE-A");
    expect(cfg.token).toBe("user");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await forgetSandbox("a");
    cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.claim_tokens).toEqual({ b: "tb" });
    expect(cfg.claims).toEqual({});
    expect(cfg.token).toBe("user");
  });

  it("sandbox_lifecycle: unlinkProject снимает привязку и оставляет поля человека", async () => {
    const { unlinkProject } = await import("../src/project-config.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "layero-unlink-"));
    mkdirSync(path.join(dir, ".layero"));
    const file = path.join(dir, ".layero", "project.json");
    writeFileSync(file, JSON.stringify({
      project_id: "cp-1", slug: "s", organization_slug: "claim-1", apex_hostname: "s.layero.app",
      claim: { code: "X" }, framework_hint: "vite",
    }));
    await unlinkProject(dir);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ framework_hint: "vite" });
    writeFileSync(file, JSON.stringify({ project_id: "cp-1", slug: "s" }));
    await unlinkProject(dir);
    expect(existsSync(file)).toBe(false);
  });

  it("claim_hygiene: persistProjectLinking убирает код забора старого CLI из файла", async () => {
    const { persistProjectLinking } = await import("../src/project-config.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "layero-link-"));
    mkdirSync(path.join(dir, ".layero"));
    const file = path.join(dir, ".layero", "project.json");
    writeFileSync(file, JSON.stringify({ project_id: "cp-1", claim: { code: "SECRET-CODE" }, env_vars: {} }));
    await persistProjectLinking(dir, { project_id: "cp-1", slug: "s", organization_slug: "o", apex_hostname: "s.layero.app" });
    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain("SECRET-CODE");
    expect(JSON.parse(text)).toMatchObject({ project_id: "cp-1", env_vars: {} });
  });
});
