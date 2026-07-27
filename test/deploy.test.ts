/**
 * Regression tests for the CLI deploy flow.
 *
 * B1 (blocker): `layero init` scaffolds .layero/project.json WITHOUT a
 * project_id (the project isn't created until the first deploy). Deploy must
 * treat that scaffold as a first-deploy/create, NOT as an existing link — the
 * old code called GET /projects/undefined → 422 and the documented init→deploy
 * path was broken.
 *
 * B3/B4: the `ready` event's `url` must be the live, REACHABLE public site —
 * never the dashboard. Preview-first contract: the off-CDN preview while the
 * apex is still CDN-warming (cdn_ready=false), the canonical apex once it's warm.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// --- module mocks ---------------------------------------------------------
// vi.mock factories are hoisted above the file's top-level statements, so any
// spies they reference must be created via vi.hoisted (which runs first too).
const {
  getProject,
  createCliProject,
  completeSetup,
  initUpload,
  triggerDeploy,
  createDeploySession,
  startDeploySession,
  getDeploy,
  probeEnvironment,
  me,
  listOrganizations,
  listProjects,
  loadProjectConfig,
} = vi.hoisted(() => ({
  getProject: vi.fn(),
  createCliProject: vi.fn(),
  completeSetup: vi.fn(),
  initUpload: vi.fn(),
  triggerDeploy: vi.fn(),
  createDeploySession: vi.fn(),
  startDeploySession: vi.fn(),
  getDeploy: vi.fn(),
  probeEnvironment: vi.fn(),
  me: vi.fn(),
  listOrganizations: vi.fn(),
  listProjects: vi.fn(),
  loadProjectConfig: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) {
      super(message);
    }
  }
  class ApiClient {
    getProject = getProject;
    createCliProject = createCliProject;
    completeSetup = completeSetup;
    initUpload = initUpload;
    triggerDeploy = triggerDeploy;
    createDeploySession = createDeploySession;
    startDeploySession = startDeploySession;
    getDeploy = getDeploy;
    probeEnvironment = probeEnvironment;
    me = me;
    listOrganizations = listOrganizations;
    listProjects = listProjects;
  }
  return { ApiClient, ApiError, uploadArchive: vi.fn(async () => undefined) };
});

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(async () => ({ apiUrl: "https://api.layero.ru", token: "tkn" })),
}));

vi.mock("../src/project-config.js", () => ({
  loadProjectConfig,
  // Return the linking subset back as the "merged" config; deploy only reads
  // analytics_enabled / env_vars off it.
  persistProjectLinking: vi.fn(async () => ({ analytics_enabled: false, env_vars: {} })),
  projectConfigPath: (cwd: string) => `${cwd}/.layero/project.json`,
}));

vi.mock("../src/pack.js", () => ({
  packCwd: vi.fn(async () => ({ archivePath: "/tmp/x.tgz", fileCount: 1, size: 10, sha256: "deadbeef" })),
  packDirectory: vi.fn(async () => ({ archivePath: "/tmp/x.tgz", fileCount: 1, size: 10, sha256: "deadbeef" })),
}));

vi.mock("../src/logs.js", () => ({
  streamDeployLogs: vi.fn(async () => ({ status: "ready" })),
}));

vi.mock("../src/detect.js", () => ({
  detectProject: vi.fn(async () => ({
    framework_hint: "static",
    build_cmd: "true",
    output_dir: ".",
    confident: true,
  })),
}));

// Avoid touching the real filesystem when deploy unlinks the temp archive.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, promises: { ...actual.promises, unlink: vi.fn(async () => undefined) } };
});

import { deployCmd } from "../src/commands/deploy.js";
import { setMode } from "../src/agent.js";

const PROJECT = {
  id: "proj-123",
  name: "smoke",
  slug: "smoke",
  apex_hostname: "valya-smoke.layero.ru",
  source_type: "cli",
  framework_hint: null,
  default_branch: "cli",
  organization: { id: "org-1", github_login: null, slug: "valya", kind: "personal" as const },
  created_at: "2026-06-25T00:00:00Z",
  status: "pending_setup" as const,
  cli_deploys_enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Force non-interactive JSON mode so no prompt is attempted.
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  me.mockResolvedValue({ id: "u1", username: "valya", email: "v@x", github_login: "v", avatar_url: null });
  listOrganizations.mockResolvedValue([{ id: "org-1", slug: "valya", github_login: null, my_role: "admin", kind: "personal" }]);
  createCliProject.mockResolvedValue(PROJECT);
  completeSetup.mockResolvedValue({ ...PROJECT, status: "active" });
  initUpload.mockResolvedValue({ upload_url: "https://s3/x", source_archive_key: "k", headers: {}, expires_in: 60 });
  triggerDeploy.mockResolvedValue({ id: "dep-1", environment_id: "env-1", status: "queued", commit_sha: "deadbeef" });
  // AGENT-04: деплой идёт через сессию — один вызов вместо пяти.
  createDeploySession.mockResolvedValue({
    session_id: "sess-1",
    project: { ...PROJECT, status: "active" },
    created_project: true,
    upload_url: "https://s3/x",
    upload_headers: {},
    source_archive_key: "k",
    expires_in: 600,
  });
  startDeploySession.mockResolvedValue({
    session_id: "sess-1",
    status: "started",
    project_id: "proj-123",
    deploy_id: "dep-1",
    created_project: true,
    error: null,
  });
  getDeploy.mockResolvedValue({ id: "dep-1", environment_id: "env-1", status: "ready", commit_sha: "deadbeef" });
  probeEnvironment.mockResolvedValue({
    available: true,
    canonical_url: "https://valya-smoke.layero.ru/",
    preview_url: "https://valya-smoke-deadbee.preview.layero.ru/",
    cdn_ready: false,
    cdn_eta_seconds: 300,
    reason: "ok",
  });
});

describe("B1: init scaffold without project_id", () => {
  it("falls through to create instead of GET /projects/undefined", async () => {
    // The exact shape `layero init` writes: setup fields, NO project_id.
    loadProjectConfig.mockResolvedValue({
      framework_hint: "static",
      build_cmd: "true",
      output_dir: ".",
      analytics_enabled: false,
      env_vars: {},
    });

    await deployCmd({ name: "smoke", json: true });

    // Не должен ходить за фантомным проектом.
    expect(getProject).not.toHaveBeenCalled();
    // Сессия открывается по имени, без project_id — сервер создаст проект сам.
    expect(createDeploySession).toHaveBeenCalledTimes(1);
    const arg = createDeploySession.mock.calls[0]![0] as any;
    expect(arg.project_id).toBeUndefined();
    expect(arg.name).toBe("smoke");
    expect(startDeploySession).toHaveBeenCalledTimes(1);
    // Хеш архива уходит на СТАРТЕ, а не при открытии сессии (V172):
    // до проверки прав клиент ничего не пакует.
    expect(arg.commit_sha).toBeUndefined();
    expect((startDeploySession.mock.calls[0]![1] as any).commit_sha).toBe("deadbeef");
  });
});

describe("B1: real link (project_id present)", () => {
  it("resolves the existing project, does not create a new one", async () => {
    loadProjectConfig.mockResolvedValue({
      project_id: "proj-123",
      slug: "smoke",
      organization_slug: "valya",
      apex_hostname: "valya-smoke.layero.ru",
    });
    getProject.mockResolvedValue({ ...PROJECT, status: "active" });

    await deployCmd({ json: true });

    // Залинкованный проект уходит в сессию как project_id — никаких
    // listProjects/getProject ради того, что уже записано в .layero.
    const arg = createDeploySession.mock.calls[0]![0] as any;
    expect(arg.project_id).toBe("proj-123");
    expect(arg.name).toBeUndefined();
    expect(createCliProject).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });
});

describe("B3/B4: ready event carries the public URL + preview", () => {
  function readyEventOf(lines: string[]): any {
    return lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.event === "ready");
  }

  it("emits the apex as url even when cdn_ready=false (never the dashboard)", async () => {
    // Contract as of 2026-07-26 (commit 8779f32). It USED to gate on
    // `cdn_ready` and fall back to the off-CDN preview while the fresh apex was
    // still 404-ing through CDN propagation. After EDGE-02 there is no CDN in
    // front of user zones: the apex is valid from project creation (wildcard
    // record + wildcard cert) and the backend now reports `cdn_ready=false`
    // FOREVER — no row ever lands in `cdn_hostnames` for a new project. The old
    // gate therefore never opened and the CLI handed back a dashboard link
    // instead of the site (reproduced live 2026-07-26).
    //
    // So: apex is the default address, and cdn_ready is no longer an input.
    // `edge_ready` now mirrors the probe's `available`, and `edge_eta_seconds`
    // is gone — there is nothing left to propagate.
    loadProjectConfig.mockResolvedValue(null);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    try {
      await deployCmd({ name: "smoke", json: true });
    } finally {
      spy.mockRestore();
    }
    const ready = readyEventOf(lines);
    expect(ready).toBeTruthy();
    expect(ready.url).toBe("https://valya-smoke.layero.ru/");
    // The invariant this test has always been about, and still is.
    expect(ready.url).not.toContain("app.layero.ru");
    expect(ready.preview_url).toBe("https://valya-smoke-deadbee.preview.layero.ru/");
    expect(ready.dashboard_url).toContain("app.layero.ru/projects/");
    expect(ready.edge_ready).toBe(true); // = probe.available, not cdn_ready
    expect(ready.edge_eta_seconds).toBeUndefined();
  });

  it("switches url to the canonical apex once CDN is ready", async () => {
    loadProjectConfig.mockResolvedValue(null);
    probeEnvironment.mockResolvedValue({
      available: true,
      canonical_url: "https://valya-smoke.layero.ru/",
      preview_url: "https://valya-smoke-deadbee.preview.layero.ru/",
      cdn_ready: true,
    });
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
    try {
      await deployCmd({ name: "smoke", json: true });
    } finally {
      spy.mockRestore();
    }
    const ready = readyEventOf(lines);
    expect(ready).toBeTruthy();
    expect(ready.url).toBe("https://valya-smoke.layero.ru/");
    expect(ready.edge_ready).toBe(true);
    expect(ready.edge_eta_seconds).toBeUndefined();
  });
});

describe("AGENT-04: --project переопределяет .layero/project.json", () => {
  it("шлёт слаг из --project и не шлёт project_id залинкованного проекта", async () => {
    // Каталог УЖЕ залинкован на другой проект — ровно та ситуация, в которой
    // легко уехать не туда: если передать оба поля, сервер выберет project_id
    // и молча задеплоит в залинкованный, а не в запрошенный.
    loadProjectConfig.mockResolvedValue({
      project_id: "proj-LINKED",
      slug: "linked",
      organization_slug: "valya",
      apex_hostname: "linked.layero.app",
    });

    await deployCmd({ json: true, project: "other-project" });

    const arg = createDeploySession.mock.calls[0]![0] as any;
    expect(arg.name).toBe("other-project");
    expect(arg.project_id).toBeUndefined();
    // Опечатка в слаге должна давать 404, а не заводить лишний проект.
    expect(arg.create_if_missing).toBe(false);
  });

  it("без --project использует залинкованный project_id", async () => {
    loadProjectConfig.mockResolvedValue({
      project_id: "proj-LINKED",
      slug: "linked",
      organization_slug: "valya",
      apex_hostname: "linked.layero.app",
    });

    await deployCmd({ json: true });

    const arg = createDeploySession.mock.calls[0]![0] as any;
    expect(arg.project_id).toBe("proj-LINKED");
    expect(arg.name).toBeUndefined();
    expect(arg.create_if_missing).toBeUndefined();
  });
});

describe("AGENT-13: --project принимает и id, и слаг", () => {
  it("UUID уходит как project_id, а не как имя", async () => {
    // На сервере это РАЗНЫЕ поля: project_id ищется по идентификатору,
    // name — по слагу. UUID, отправленный как имя, не находится ничем, и
    // деплой падает «no project with id/slug» на существующем проекте.
    // Поймано живым прогоном.
    loadProjectConfig.mockResolvedValue(null);
    await deployCmd({ json: true, project: "947ddd51-419f-4603-8557-2e0178e27d48" });
    const arg = createDeploySession.mock.calls[0]![0] as any;
    expect(arg.project_id).toBe("947ddd51-419f-4603-8557-2e0178e27d48");
    expect(arg.name).toBeUndefined();
  });

  it("слаг по-прежнему уходит как имя с запретом создания", async () => {
    loadProjectConfig.mockResolvedValue(null);
    await deployCmd({ json: true, project: "my-site" });
    const arg = createDeploySession.mock.calls[0]![0] as any;
    expect(arg.name).toBe("my-site");
    expect(arg.create_if_missing).toBe(false);
    expect(arg.project_id).toBeUndefined();
  });
});
