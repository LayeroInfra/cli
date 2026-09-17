// `layero sources …` и `layero projects create --repo` (этап 6 AX-аудита):
// путь (a) «есть репозиторий» без панели.
import { describe, expect, it, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({
  listOrganizations: vi.fn(), listSourceProviders: vi.fn(), listSourceConnections: vi.fn(),
  createSourceConnection: vi.fn(), listSourceRepos: vi.fn(), listImportAccounts: vi.fn(),
  listImportRepos: vi.fn(), createProjectFromAccount: vi.fn(), createCliProject: vi.fn(),
  connectSource: vi.fn(), deleteProject: vi.fn(), listProjects: vi.fn(), getProject: vi.fn(),
  listBranches: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    listOrganizations = M.listOrganizations; listSourceProviders = M.listSourceProviders;
    listSourceConnections = M.listSourceConnections; createSourceConnection = M.createSourceConnection;
    listSourceRepos = M.listSourceRepos; listImportAccounts = M.listImportAccounts;
    listImportRepos = M.listImportRepos; createProjectFromAccount = M.createProjectFromAccount;
    createCliProject = M.createCliProject; connectSource = M.connectSource; deleteProject = M.deleteProject;
    listProjects = M.listProjects; getProject = M.getProject; listBranches = M.listBranches;
    async resolveProject(ref: string) {
      const all = await M.listProjects();
      return all.find((p: any) => p.slug === ref || p.id === ref);
    }
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn(async () => ({ apiUrl: "x", token: "t" })) }));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig: vi.fn(async () => ({ project_id: "p1" })) }));

import { sourcesConnectCmd, sourcesListCmd, sourcesReposCmd } from "../src/commands/sources.js";
import { parseRepoRef, projectsCreateCmd, projectsDeleteCmd } from "../src/commands/projects.js";
import { envsListCmd } from "../src/commands/envs.js";
import { setMode } from "../src/agent.js";

function capture() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { lines.push(String(c)); return true; }) as any);
  return { lines, restore: () => spy.mockRestore(), events: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

const PROJECT = {
  id: "p1", slug: "site", name: "site", apex_hostname: "site.layero.app", source_type: "git",
  repo_full_name: "acme/site", repo_status: "connected", default_branch: "main", production_branch_name: null,
  status: "active", organization: { slug: "valya" },
};

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  M.listOrganizations.mockResolvedValue([{ id: "o1", slug: "valya", kind: "personal", my_role: "admin" }]);
  M.listSourceProviders.mockResolvedValue([
    { id: "gitverse", title: "GitVerse", self_hosted: false, webhook_create: true, webhook_supported: true, token_hint: "Settings → Tokens" },
    { id: "gitlab", title: "GitLab", self_hosted: true, webhook_create: true, webhook_supported: true, token_hint: null },
  ]);
  M.listSourceConnections.mockResolvedValue([
    { id: "c1", provider_id: "gitverse", provider_title: "GitVerse", external_account: "valya", display_name: null, status: "active", last_error: null, last_verified_at: null, token_expiry_state: "ok", projects_count: 1, created_at: "" },
  ]);
  M.createSourceConnection.mockResolvedValue({ id: "c2", provider_id: "gitverse", external_account: "valya", status: "active" });
  M.listSourceRepos.mockResolvedValue([{ external_id: "1", path: "acme/site", name: "site", default_branch: "main", clone_url: "", private: false, updated_at: null, can_admin: true }]);
  M.listImportAccounts.mockResolvedValue([
    { key: "github:42", provider: "github", provider_title: "GitHub", login: "acme", status: "active", can_import: true },
    { key: "connection:c1", provider: "gitverse", provider_title: "GitVerse", login: "valya", status: "active", can_import: true },
  ]);
  M.listImportRepos.mockResolvedValue([
    { account_key: "connection:c1", provider: "gitverse", external_id: "1", path: "acme/site", name: "site", default_branch: "develop", clone_url: "", private: false, imported_project_ids: [] },
  ]);
  M.createProjectFromAccount.mockResolvedValue(PROJECT);
  M.createCliProject.mockResolvedValue({ ...PROJECT, source_type: "cli", repo_full_name: null });
  M.connectSource.mockResolvedValue({ project: PROJECT, webhook_registered: false, webhook_url: "https://api.layero.ru/webhooks/git/xyz", webhook_hint: "токену не хватает прав на вебхуки" });
  M.listProjects.mockResolvedValue([PROJECT]);
  M.listBranches.mockResolvedValue([
    { id: "e1", branch_name: "main", hostname: "site.layero.app", preview_url: "https://site.layero.app", slug: "main", active_deploy_id: "d1", active_deploy_at: "2026-09-17T00:00:00Z" },
    { id: "e2", branch_name: "feature", hostname: "feature-site.layero.app", preview_url: "https://feature-site.layero.app", slug: "feature", active_deploy_id: null, active_deploy_at: null },
  ]);
});

describe("sources", () => {
  it("list → sources: провайдеры и подключения без токенов", async () => {
    const c = capture();
    try { await sourcesListCmd({}); } finally { c.restore(); }
    const [e] = c.events();
    expect(e.event).toBe("sources");
    expect(e.providers.map((p: any) => p.id)).toEqual(["gitverse", "gitlab"]);
    expect(e.connections[0]).toMatchObject({ id: "c1", provider: "gitverse", account: "valya" });
    expect(JSON.stringify(e)).not.toContain("token\":");
  });

  it("connect с --token-stdin: токен читается из stdin и уходит на сервер", async () => {
    const { Readable } = await import("node:stream");
    const fake = Readable.from(["ghp_secret\n"]);
    const orig = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    const c = capture();
    try { await sourcesConnectCmd("gitverse", { tokenStdin: true }); } finally { c.restore(); Object.defineProperty(process, "stdin", orig); }
    expect(M.createSourceConnection).toHaveBeenCalledWith("valya", expect.objectContaining({ provider_id: "gitverse", token: "ghp_secret" }));
    expect(c.events()[0]).toMatchObject({ event: "source_connected", connection_id: "c2", provider: "gitverse" });
    // Токен не попадает в вывод.
    expect(c.lines.join("")).not.toContain("ghp_secret");
  });

  it("неизвестный провайдер — provider_unknown со списком; без токена — token_missing", async () => {
    await expect(sourcesConnectCmd("bitbucket", { token: "x" })).rejects.toMatchObject({ code: "provider_unknown" });
    await expect(sourcesConnectCmd("gitverse", {})).rejects.toMatchObject({ code: "token_missing" });
    expect(M.createSourceConnection).not.toHaveBeenCalled();
  });

  it("--base-url у провайдера без self-hosted — bad_format", async () => {
    await expect(sourcesConnectCmd("gitverse", { token: "x", baseUrl: "https://git.example.com" })).rejects.toMatchObject({ code: "bad_format" });
  });

  it("repos → source_repos; 404 → connection_not_found", async () => {
    const c = capture();
    try { await sourcesReposCmd("c1", {}); } finally { c.restore(); }
    expect(c.events()[0]).toMatchObject({ event: "source_repos", connection_id: "c1", repos: [{ path: "acme/site", default_branch: "main" }] });
    const { ApiError } = await import("../src/api.js");
    M.listSourceRepos.mockRejectedValue(new ApiError("x", 404, ""));
    await expect(sourcesReposCmd("nope", {})).rejects.toMatchObject({ code: "connection_not_found" });
  });
});

describe("projects create --repo", () => {
  it("разбирает provider:owner/repo, включая вложенные пути GitLab", () => {
    expect(parseRepoRef("gitlab:group/sub/project")).toEqual({ provider: "gitlab", path: "group/sub/project" });
    expect(parseRepoRef("GitHub:acme/site/")).toEqual({ provider: "github", path: "acme/site" });
    expect(() => parseRepoRef("acme/site")).toThrow(expect.objectContaining({ code: "repo_format" }));
    expect(() => parseRepoRef("github:site")).toThrow(expect.objectContaining({ code: "repo_format" }));
  });

  it("внешний провайдер: проект + connect-source; вебхук не дали → webhook_unavailable с адресом", async () => {
    const c = capture();
    try { await projectsCreateCmd({ repo: "gitverse:acme/site" }); } finally { c.restore(); }
    const ev = c.events();
    expect(ev.map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_unavailable"]);
    // Ветка — из репозитория, если не задана флагом.
    expect(M.connectSource).toHaveBeenCalledWith("p1", { connection_id: "c1", repo_path: "acme/site", branch: "develop" });
    expect(ev[0]).toMatchObject({ repo: "acme/site", branch: "develop", url: "https://site.layero.app" });
    expect(ev[2]).toMatchObject({ url: "https://api.layero.ru/webhooks/git/xyz", hint: "токену не хватает прав на вебхуки" });
    expect(M.createProjectFromAccount).not.toHaveBeenCalled();
  });

  it("GitHub App: один вызов через ключ аккаунта, вебхук установлен", async () => {
    M.listImportRepos.mockResolvedValue([{ account_key: "github:42", provider: "github", external_id: "9", path: "acme/site", name: "site", default_branch: "main", clone_url: "", private: true, imported_project_ids: [] }]);
    const c = capture();
    try { await projectsCreateCmd({ repo: "github:acme/site", branch: "main", name: "Site" }); } finally { c.restore(); }
    expect(M.createProjectFromAccount).toHaveBeenCalledWith(expect.objectContaining({ source_account_key: "github:42", repo_path: "acme/site", default_branch: "main", name: "Site" }));
    expect(c.events().map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_installed"]);
    expect(M.createCliProject).not.toHaveBeenCalled();
  });

  it("нет подключения к провайдеру — account_not_found; репозиторий не виден — repo_not_found", async () => {
    await expect(projectsCreateCmd({ repo: "gitlab:acme/site" })).rejects.toMatchObject({ code: "account_not_found" });
    await expect(projectsCreateCmd({ repo: "gitverse:acme/other" })).rejects.toMatchObject({ code: "repo_not_found" });
    expect(M.createCliProject).not.toHaveBeenCalled();
  });

  it("привязка не удалась — проект убирается, код source_connect_failed", async () => {
    const { ApiError } = await import("../src/api.js");
    M.connectSource.mockRejectedValue(new ApiError("x", 502, "провайдер не отвечает"));
    M.deleteProject.mockResolvedValue({});
    await expect(projectsCreateCmd({ repo: "gitverse:acme/site" })).rejects.toMatchObject({ code: "source_connect_failed" });
    expect(M.deleteProject).toHaveBeenCalledWith("p1");
  });
});

describe("projects delete", () => {
  it("вне терминала без --yes — confirmation_required, ничего не удалено", async () => {
    await expect(projectsDeleteCmd("site", {})).rejects.toMatchObject({ code: "confirmation_required" });
    expect(M.deleteProject).not.toHaveBeenCalled();
  });
  it("--yes → project_deleted; 403 → forbidden с подсказкой про scope admin", async () => {
    M.deleteProject.mockResolvedValue({});
    const c = capture();
    try { await projectsDeleteCmd("site", { yes: true }); } finally { c.restore(); }
    expect(c.events()[0]).toMatchObject({ event: "project_deleted", slug: "site" });
    const { ApiError } = await import("../src/api.js");
    M.deleteProject.mockRejectedValue(new ApiError("x", 403, ""));
    await expect(projectsDeleteCmd("site", { yes: true })).rejects.toMatchObject({ code: "forbidden", next_action: expect.stringContaining("admin") });
  });
});

describe("envs list", () => {
  it("→ environments с адресами; production помечена", async () => {
    const c = capture();
    try { await envsListCmd({}); } finally { c.restore(); }
    const [e] = c.events();
    expect(e.event).toBe("environments");
    expect(e.project).toBe("site");
    expect(e.environments).toEqual([
      expect.objectContaining({ branch: "main", url: "https://site.layero.app", production: true, active_deploy_id: "d1" }),
      expect.objectContaining({ branch: "feature", url: "https://feature-site.layero.app", production: false }),
    ]);
  });
});
