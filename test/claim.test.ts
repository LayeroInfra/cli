// Claimable-проекты (этап 13 AX-аудита, CLI-часть) и честный `--branch`.
// Бэкенд `/claimable/*` на момент написания в разработке — здесь контракт,
// по которому он делается: create → {project_id, slug, organization,
// claim_url, token, expires_at}.
import { describe, expect, it, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({
  createClaimableProject: vi.fn(), getClaimStatus: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(),
  createDeploySession: vi.fn(), startDeploySession: vi.fn(), getDeploy: vi.fn(), probeEnvironment: vi.fn(),
  loadConfig: vi.fn(), saveConfig: vi.fn(), loadProjectConfig: vi.fn(), persistProjectLinking: vi.fn(),
  runDeviceLogin: vi.fn(), open: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    createClaimableProject = M.createClaimableProject; getClaimStatus = M.getClaimStatus;
    getProject = M.getProject; listProjects = M.listProjects;
    createDeploySession = M.createDeploySession; startDeploySession = M.startDeploySession;
    getDeploy = M.getDeploy; probeEnvironment = M.probeEnvironment;
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
vi.mock("../src/auth.js", () => ({ runDeviceLogin: M.runDeviceLogin }));
vi.mock("../src/pack.js", () => ({
  packCwd: vi.fn(async () => ({ archivePath: "/tmp/x.tgz", fileCount: 1, size: 10, sha256: "deadbeef" })),
  packDirectory: vi.fn(async () => ({ archivePath: "/tmp/x.tgz", fileCount: 1, size: 10, sha256: "deadbeef" })),
}));
vi.mock("../src/logs.js", () => ({ streamDeployLogs: vi.fn(async () => ({ status: "ready" })) }));
vi.mock("../src/detect.js", () => ({
  detectProject: vi.fn(async () => ({ framework_hint: "static", build_cmd: "true", output_dir: ".", confident: true })),
}));
vi.mock("open", () => ({ default: M.open }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, promises: { ...actual.promises, unlink: vi.fn(async () => undefined) } };
});

import { deployCmd } from "../src/commands/deploy.js";
import { claimAcceptCmd, claimCodeOf, claimStatusCmd, createClaimable } from "../src/commands/claim.js";
import { setMode } from "../src/agent.js";

const CREATED = {
  project_id: "cp-1", slug: "swift-fox", organization: "claimable",
  claim_url: "https://app.layero.ru/claim?code=ABCD-1234", token: "claim-jwt",
  expires_at: "2026-09-20T18:00:00Z",
};
const PROJECT = {
  id: "cp-1", slug: "swift-fox", apex_hostname: "swift-fox.layero.app", source_type: "cli", repo_full_name: null,
  repo_status: "none", default_branch: "cli", organization: { slug: "claimable" }, status: "active", cli_deploys_enabled: true,
};

function capture() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { lines.push(String(c)); return true; }) as any);
  return { lines, restore: () => spy.mockRestore(), events: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  M.loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru" });
  M.loadProjectConfig.mockResolvedValue(null);
  M.persistProjectLinking.mockResolvedValue({});
  M.saveConfig.mockResolvedValue(undefined);
  M.createClaimableProject.mockResolvedValue(CREATED);
  M.createDeploySession.mockResolvedValue({
    session_id: "s1", project: PROJECT, created_project: false, upload_url: "https://s3/x", upload_headers: {}, source_archive_key: "k", expires_in: 600,
  });
  M.startDeploySession.mockResolvedValue({ session_id: "s1", status: "started", project_id: "cp-1", deploy_id: "d1", created_project: false, error: null });
  M.getDeploy.mockResolvedValue({ id: "d1", environment_id: "e1", status: "ready", commit_sha: "deadbeef" });
  M.probeEnvironment.mockResolvedValue({ available: true, canonical_url: "https://swift-fox.layero.app/", preview_url: null, cdn_ready: true });
  M.getClaimStatus.mockResolvedValue({ status: "pending", claimed: false, expires_at: CREATED.expires_at, url: "https://swift-fox.layero.app/", claim_url: CREATED.claim_url });
});

describe("createClaimable", () => {
  it("код — из claim_url, токен — в ~/.layero/config.json по проекту, код и ссылка — в .layero/project.json", async () => {
    const r = await createClaimable({ apiUrl: "x" }, "/cwd", { name: "site" });
    expect(r.code).toBe("ABCD-1234");
    expect(r.cfg.token).toBe("claim-jwt");
    // В файл — только карта токенов заявок, не «вход».
    expect(M.saveConfig).toHaveBeenCalledWith({ apiUrl: "x", claim_tokens: { "cp-1": "claim-jwt" } });
    expect(M.persistProjectLinking).toHaveBeenCalledWith("/cwd", expect.objectContaining({
      project_id: "cp-1", slug: "swift-fox", claim: { code: "ABCD-1234", claim_url: CREATED.claim_url, expires_at: CREATED.expires_at },
    }));
    // Токена в project.json нет.
    expect(JSON.stringify(M.persistProjectLinking.mock.calls[0]![1])).not.toContain("claim-jwt");
  });
  it("claimCodeOf берёт claim_code сервера, иначе последний сегмент пути", () => {
    expect(claimCodeOf({ claim_url: "https://app/claim?code=Q", claim_code: "SRV" })).toBe("SRV");
    expect(claimCodeOf({ claim_url: "https://app.layero.ru/claim/XYZ" })).toBe("XYZ");
  });
  it("бэкенд без /claimable (404), выключено (503), квота (429) — claimable_unavailable с подсказкой войти", async () => {
    const { ApiError } = await import("../src/api.js");
    for (const status of [404, 503, 429]) {
      M.createClaimableProject.mockRejectedValue(new ApiError("x", status, ""));
      await expect(createClaimable({ apiUrl: "x" }, "/cwd", {})).rejects.toMatchObject({ code: "claimable_unavailable", next_action: expect.stringContaining("layero login") });
    }
  });
});

describe("deploy --claim", () => {
  it("без токена: создаёт заявку, деплоит её токеном, claimable идёт ДО ready", async () => {
    M.loadProjectConfig.mockResolvedValueOnce(null).mockResolvedValue({ project_id: "cp-1", slug: "swift-fox" });
    const c = capture();
    try { await deployCmd({ claim: true, yes: true, json: true }); } finally { c.restore(); }
    const ev = c.events();
    const names = ev.map((e) => e.event);
    expect(names.indexOf("claimable")).toBeGreaterThan(-1);
    expect(names.indexOf("claimable")).toBeLessThan(names.indexOf("ready"));
    expect(ev.find((e) => e.event === "claimable")).toMatchObject({
      url: "https://swift-fox.layero.app/", claim_url: CREATED.claim_url, expires_at: CREATED.expires_at, slug: "swift-fox",
    });
    // Сессия открыта уже по project_id заявки, не по имени.
    expect((M.createDeploySession.mock.calls[0]![0] as any).project_id).toBe("cp-1");
    expect(M.runDeviceLogin).not.toHaveBeenCalled();
  });

  it("включается сам: нет токена, агентская среда, --yes", async () => {
    M.loadProjectConfig.mockResolvedValueOnce(null).mockResolvedValue({ project_id: "cp-1", slug: "swift-fox" });
    const c = capture();
    try { await deployCmd({ yes: true, json: true }); } finally { c.restore(); }
    expect(M.createClaimableProject).toHaveBeenCalledTimes(1);
    expect(c.events().some((e) => e.event === "claimable")).toBe(true);
  });

  it("без --yes в агентской среде — обычный device flow, заявки нет", async () => {
    M.runDeviceLogin.mockResolvedValue({ apiUrl: "https://api.layero.ru", token: "user-jwt" });
    const c = capture();
    try { await deployCmd({ json: true }); } finally { c.restore(); }
    expect(M.createClaimableProject).not.toHaveBeenCalled();
    expect(M.runDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it("в CI без токена и без --claim — auth_required, а не временный сайт", async () => {
    process.env.CI = "1";
    await expect(deployCmd({ yes: true, json: true })).rejects.toMatchObject({ code: "auth_required" });
    expect(M.createClaimableProject).not.toHaveBeenCalled();
  });

  it("повторный деплой той же папки — токеном заявки из конфига", async () => {
    M.loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru", claim_tokens: { "cp-1": "claim-jwt" } });
    M.loadProjectConfig.mockResolvedValue({ project_id: "cp-1", slug: "swift-fox", claim: { code: "ABCD-1234", claim_url: CREATED.claim_url, expires_at: CREATED.expires_at } });
    const c = capture();
    try { await deployCmd({ yes: true, json: true }); } finally { c.restore(); }
    expect(M.createClaimableProject).not.toHaveBeenCalled();
    expect(M.runDeviceLogin).not.toHaveBeenCalled();
    expect(c.events().some((e) => e.event === "ready")).toBe(true);
  });

  it("--claim при выполненном входе — bad_format", async () => {
    M.loadConfig.mockResolvedValue({ apiUrl: "x", token: "user-jwt" });
    await expect(deployCmd({ claim: true, json: true })).rejects.toMatchObject({ code: "bad_format" });
  });
});

describe("deploy --branch — честный отказ", () => {
  beforeEach(() => M.loadConfig.mockResolvedValue({ apiUrl: "x", token: "user-jwt" }));

  it("проект без репозитория — branch_unsupported, ничего не пакуется и не грузится", async () => {
    M.loadProjectConfig.mockResolvedValue({ project_id: "cp-1" });
    M.getProject.mockResolvedValue(PROJECT);
    await expect(deployCmd({ branch: "probe", json: true })).rejects.toMatchObject({
      code: "branch_unsupported", next_action: expect.stringContaining("превью-ветки есть только у проектов с репозиторием"),
    });
    expect(M.createDeploySession).not.toHaveBeenCalled();
  });

  it("проект с репозиторием — тоже отказ, но с подсказкой пушить ветку", async () => {
    M.loadProjectConfig.mockResolvedValue({ project_id: "cp-1" });
    M.getProject.mockResolvedValue({ ...PROJECT, source_type: "git", repo_full_name: "acme/site", repo_status: "connected" });
    await expect(deployCmd({ branch: "probe", json: true })).rejects.toMatchObject({
      code: "branch_unsupported", next_action: expect.stringContaining("acme/site"),
    });
    expect(M.createDeploySession).not.toHaveBeenCalled();
  });

  it("новый проект с --branch — отказ до создания проекта", async () => {
    await expect(deployCmd({ branch: "probe", name: "x", json: true })).rejects.toMatchObject({ code: "branch_unsupported" });
    expect(M.createDeploySession).not.toHaveBeenCalled();
  });
});

describe("claim status / accept", () => {
  it("status без кода — из .layero/project.json; без заявки — claim_unknown", async () => {
    M.loadProjectConfig.mockResolvedValue({ project_id: "cp-1", claim: { code: "ABCD-1234", claim_url: CREATED.claim_url, expires_at: CREATED.expires_at } });
    const c = capture();
    try { await claimStatusCmd(undefined, { json: true }); } finally { c.restore(); }
    expect(M.getClaimStatus).toHaveBeenCalledWith("ABCD-1234");
    expect(c.events()[0]).toMatchObject({ event: "claim_status", code: "ABCD-1234", status: "pending", claimed: false, claim_url: CREATED.claim_url });
    M.loadProjectConfig.mockResolvedValue({ project_id: "other" });
    await expect(claimStatusCmd(undefined, { json: true })).rejects.toMatchObject({ code: "claim_unknown" });
  });

  it("accept в агентском режиме печатает ссылку, браузер не открывает; в терминале — открывает", async () => {
    const c = capture();
    try { await claimAcceptCmd("ABCD-1234", { json: true }); } finally { c.restore(); }
    expect(c.events()[0]).toMatchObject({ event: "claim_accept", code: "ABCD-1234", opened: false, claim_url: "https://app.layero.ru/claim?code=ABCD-1234" });
    expect(M.open).not.toHaveBeenCalled();

    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    M.open.mockResolvedValue(undefined);
    const h = capture();
    try { await claimAcceptCmd("ABCD-1234", {}); } finally { h.restore(); }
    expect(M.open).toHaveBeenCalledWith("https://app.layero.ru/claim?code=ABCD-1234");
    expect(h.lines.join("")).toContain("подтвердите в панели");
  });
});
