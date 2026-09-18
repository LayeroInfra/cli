// Песочница (claimable) — только для НОВОГО проекта (T-20260918-5).
//
// До 0.10.5 авто-режим включался по «нет токена + агент + --yes», не глядя на
// то, КУДА выкатывают: `deploy --project <существующий>` брал токен песочницы
// и получал от платформы `username_required` про держателя песочницы. Здесь
// `auth.ts` настоящий — проверяется само событие `auth_required`, а не факт
// вызова подменённой функции.
import { describe, expect, it, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({
  createClaimableProject: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(),
  createDeploySession: vi.fn(), startDeploySession: vi.fn(), getDeploy: vi.fn(), probeEnvironment: vi.fn(),
  startDeviceAuth: vi.fn(), pollDeviceAuth: vi.fn(), me: vi.fn(), tokens: [] as (string | undefined)[],
  loadConfig: vi.fn(), saveConfig: vi.fn(), loadProjectConfig: vi.fn(), persistProjectLinking: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    constructor(cfg: { token?: string }) { M.tokens.push(cfg.token); }
    createClaimableProject = M.createClaimableProject;
    getProject = M.getProject; listProjects = M.listProjects;
    createDeploySession = M.createDeploySession; startDeploySession = M.startDeploySession;
    getDeploy = M.getDeploy; probeEnvironment = M.probeEnvironment;
    startDeviceAuth = M.startDeviceAuth; pollDeviceAuth = M.pollDeviceAuth; me = M.me;
    async resolveProject(ref: string) {
      const all = await M.listProjects();
      return all.find((p: any) => p.slug === ref || p.id === ref) ?? (() => { throw new ApiError("x", 404, ""); })();
    }
  }
  return { ApiClient, ApiError, uploadArchive: vi.fn(async () => undefined) };
});
vi.mock("../src/config.js", () => ({ loadConfig: M.loadConfig, saveConfig: M.saveConfig, configPath: () => "/c" }));
vi.mock("../src/project-config.js", () => ({
  loadProjectConfig: M.loadProjectConfig,
  persistProjectLinking: M.persistProjectLinking,
  projectConfigPath: (cwd: string) => `${cwd}/.layero/project.json`,
}));
vi.mock("../src/pack.js", () => ({
  packCwd: vi.fn(async () => ({ archivePath: "/tmp/x.tgz", fileCount: 1, size: 10, sha256: "deadbeef" })),
  packDirectory: vi.fn(async () => ({ archivePath: "/tmp/x.tgz", fileCount: 1, size: 10, sha256: "deadbeef" })),
}));
vi.mock("../src/logs.js", () => ({ streamDeployLogs: vi.fn(async () => ({ status: "ready" })) }));
vi.mock("../src/detect.js", () => ({
  detectProject: vi.fn(async () => ({ framework_hint: "static", build_cmd: "true", output_dir: ".", confident: true })),
}));
vi.mock("open", () => ({ default: vi.fn() }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, promises: { ...actual.promises, unlink: vi.fn(async () => undefined) } };
});

import { deployCmd } from "../src/commands/deploy.js";
import { setMode } from "../src/agent.js";
import { exitCodeFor } from "../src/exit-codes.js";

const CREATED = {
  project_id: "cp-1", slug: "swift-fox", organization: "claimable",
  claim_url: "https://app.layero.ru/claim?code=ABCD-1234", token: "claim-jwt",
  expires_at: "2026-09-20T18:00:00Z",
};
const CLAIM = { code: "ABCD-1234", claim_url: CREATED.claim_url, expires_at: CREATED.expires_at };
const PROJECT = {
  id: "cp-1", slug: "swift-fox", apex_hostname: "swift-fox.layero.app", source_type: "cli", repo_full_name: null,
  repo_status: "none", default_branch: "cli", organization: { slug: "claimable" }, status: "active", cli_deploys_enabled: true,
};

function capture() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { lines.push(String(c)); return true; }) as any);
  return { restore: () => spy.mockRestore(), events: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

/** Деплой, у которого вход не подтвердили: события + ошибка, которой он кончился. */
async function deployUnapproved(opts: Parameters<typeof deployCmd>[0]) {
  const c = capture();
  let error: any = null;
  try { await deployCmd(opts); } catch (e) { error = e; } finally { c.restore(); }
  return { events: c.events(), error };
}

beforeEach(() => {
  vi.clearAllMocks();
  M.tokens.length = 0;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  // Агентская среда: то, во что CLI переходит при CLAUDECODE / CURSOR_AGENT.
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  M.loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru" });
  M.loadProjectConfig.mockResolvedValue(null);
  M.persistProjectLinking.mockResolvedValue({});
  M.saveConfig.mockResolvedValue(undefined);
  M.createClaimableProject.mockResolvedValue(CREATED);
  // Вход не подтверждают: код истекает на первом же опросе.
  M.startDeviceAuth.mockResolvedValue({
    device_code: "dc", user_code: "WXYZ-1234", verification_url: "https://app.layero.ru/device?code=WXYZ-1234",
    poll_interval: 0, expires_in: 900,
  });
  M.pollDeviceAuth.mockResolvedValue({ status: "expired" });
  M.createDeploySession.mockResolvedValue({
    session_id: "s1", project: PROJECT, created_project: false, upload_url: "https://s3/x", upload_headers: {}, source_archive_key: "k", expires_in: 600,
  });
  M.startDeploySession.mockResolvedValue({ session_id: "s1", status: "started", project_id: "cp-1", deploy_id: "d1", created_project: false, error: null });
  M.getDeploy.mockResolvedValue({ id: "d1", environment_id: "e1", status: "ready", commit_sha: "deadbeef" });
  M.probeEnvironment.mockResolvedValue({ available: true, canonical_url: "https://swift-fox.layero.app/", preview_url: null, cdn_ready: true });
});

describe("песочница (claim) только для нового проекта", () => {
  it("--project без токена в агентской среде → auth_required, не claimable", async () => {
    const r = await deployUnapproved({ project: "layero-install-landing", yes: true, json: true });
    expect(M.createClaimableProject).not.toHaveBeenCalled();
    expect(r.events[0]).toMatchObject({ event: "auth_required", url: expect.stringContaining("/device"), user_code: "WXYZ-1234" });
    expect(r.events.some((e) => e.event === "claimable")).toBe(false);
    // Вход не подтвердили — отказ класса «вход», exit 2.
    expect(r.error).toMatchObject({ code: "auth_expired" });
    expect(exitCodeFor(r.error.code)).toBe(2);
    expect(M.createDeploySession).not.toHaveBeenCalled();
  });

  it("привязанная папка без токена → auth_required, не claimable", async () => {
    M.loadProjectConfig.mockResolvedValue({ project_id: "acc-1", slug: "my-site", organization_slug: "me", apex_hostname: "my-site.layero.app" });
    const r = await deployUnapproved({ yes: true, json: true });
    expect(M.createClaimableProject).not.toHaveBeenCalled();
    expect(r.events[0]).toMatchObject({ event: "auth_required", user_code: "WXYZ-1234" });
    expect(exitCodeFor(r.error.code)).toBe(2);
  });

  it("новая папка без токена + агент + --yes → claimable как раньше", async () => {
    M.loadProjectConfig.mockResolvedValueOnce(null).mockResolvedValue({ project_id: "cp-1", slug: "swift-fox", claim: CLAIM });
    const r = await deployUnapproved({ yes: true, json: true });
    expect(r.error).toBeNull();
    expect(M.createClaimableProject).toHaveBeenCalledTimes(1);
    expect(M.startDeviceAuth).not.toHaveBeenCalled();
    const names = r.events.map((e) => e.event);
    expect(names).toContain("claimable");
    expect(names.indexOf("claimable")).toBeLessThan(names.indexOf("ready"));
  });

  it("--claim + --project → claim_with_project, exit 4, до любых запросов", async () => {
    const r = await deployUnapproved({ claim: true, project: "x", yes: true, json: true });
    expect(r.error).toMatchObject({ code: "claim_with_project", next_action: expect.stringContaining("layero login") });
    expect(exitCodeFor("claim_with_project")).toBe(4);
    expect(M.createClaimableProject).not.toHaveBeenCalled();
    expect(M.startDeviceAuth).not.toHaveBeenCalled();
    // И при выполненном входе — тот же код, а не общий bad_format.
    M.loadConfig.mockResolvedValue({ apiUrl: "x", token: "user-jwt" });
    const again = await deployUnapproved({ claim: true, project: "x", json: true });
    expect(again.error).toMatchObject({ code: "claim_with_project" });
  });

  it("claim-токен ДРУГОГО проекта из конфига не идёт в проект аккаунта", async () => {
    // Папка привязана к песочнице cp-1, её токен лежит в конфиге — а выкатывают
    // в проект аккаунта через --project.
    M.loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru", claim_tokens: { "cp-1": "claim-jwt" } });
    M.loadProjectConfig.mockResolvedValue({ project_id: "cp-1", slug: "swift-fox", claim: CLAIM });
    const r = await deployUnapproved({ project: "layero-install-landing", yes: true, json: true });
    expect(r.events[0]).toMatchObject({ event: "auth_required" });
    expect(M.tokens).not.toContain("claim-jwt");
    expect(M.createClaimableProject).not.toHaveBeenCalled();
    expect(M.createDeploySession).not.toHaveBeenCalled();
  });

  it("--project называет саму песочницу папки → её токен по-прежнему годится", async () => {
    M.loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru", claim_tokens: { "cp-1": "claim-jwt" } });
    M.loadProjectConfig.mockResolvedValue({ project_id: "cp-1", slug: "swift-fox", claim: CLAIM });
    M.listProjects.mockResolvedValue([PROJECT]);
    const r = await deployUnapproved({ project: "swift-fox", yes: true, json: true });
    expect(r.error).toBeNull();
    expect(M.startDeviceAuth).not.toHaveBeenCalled();
    expect(M.tokens).toContain("claim-jwt");
    expect(r.events.some((e) => e.event === "ready")).toBe(true);
  });
});
