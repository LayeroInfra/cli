// `layero sources …` и `layero projects create --repo` (этап 6 AX-аудита):
// путь (a) «есть репозиторий» без панели.
import { describe, expect, it, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({
  listOrganizations: vi.fn(), listSourceProviders: vi.fn(), listSourceConnections: vi.fn(),
  createSourceConnection: vi.fn(), listSourceRepos: vi.fn(), listImportAccounts: vi.fn(),
  listImportRepos: vi.fn(), createProjectFromAccount: vi.fn(), createCliProject: vi.fn(),
  connectSource: vi.fn(), deleteProject: vi.fn(), listProjects: vi.fn(), getProject: vi.fn(),
  listBranches: vi.fn(), detectProject: vi.fn(), applySetup: vi.fn(), triggerRepoDeploy: vi.fn(), setRuntimeType: vi.fn(),
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
    detectProject = M.detectProject; applySetup = M.applySetup; triggerRepoDeploy = M.triggerRepoDeploy;
    setRuntimeType = M.setRuntimeType;
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
import { parseRepoRef, projectsCreateCmd, projectsDeleteCmd, setupPayloadFromDetect } from "../src/commands/projects.js";
import { envsListCmd } from "../src/commands/envs.js";
import { setMode } from "../src/agent.js";

function capture() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { lines.push(String(c)); return true; }) as any);
  return { lines, restore: () => spy.mockRestore(), events: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

const DETECT = {
  framework: "vite", label: "Vite", build_cmd: "npm run build", build_cmd_source: "package.json-script",
  output_dir: "dist", output_dir_source: "framework-default", package_manager: "pnpm", layero_found: false,
  layero_warnings: [], runtime_warnings: [], scripts: [], candidates_truncated: false, runtime_kind: null,
};

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
  M.detectProject.mockResolvedValue(DETECT);
  M.applySetup.mockResolvedValue({ ...PROJECT, status: "active" });
  M.triggerRepoDeploy.mockResolvedValue({ id: "d42", status: "queued" });
  M.setRuntimeType.mockResolvedValue(PROJECT);
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
    expect(ev.map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_unavailable", "setup_applied", "deploy_started"]);
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
    const ev = c.events();
    expect(ev.map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_installed", "setup_applied", "deploy_started"]);
    // У GitHub App у вебхука нет своего адреса — и пустого `url` быть не должно.
    expect(ev[2]).not.toHaveProperty("url");
    expect(M.createCliProject).not.toHaveBeenCalled();
  });

  it("после привязки — мастер за человека: detect → setup → deploy, как кнопка «Начать деплой»", async () => {
    const c = capture();
    try { await projectsCreateCmd({ repo: "gitverse:acme/site" }); } finally { c.restore(); }
    const ev = c.events();
    expect(M.detectProject).toHaveBeenCalledWith("p1");
    // 🚨 Догадка детекта в проект НЕ уходит (T-20260918-19): настройки проекта
    // сборщик исполняет дословно на каждой сборке, а «не задано» он решает сам
    // по клону. Так же с 25.08 делает панель.
    expect(M.applySetup).toHaveBeenCalledWith("p1", {});
    expect(M.triggerRepoDeploy).toHaveBeenCalledWith("p1");
    expect(M.setRuntimeType).not.toHaveBeenCalled();
    // Событие пересказывает, что увидел детект, — для сведения.
    expect(ev.find((e) => e.event === "setup_applied")).toMatchObject({ project: "site", framework: "vite", build_cmd: "npm run build", output_dir: "dist", layero_found: false });
    expect(ev.find((e) => e.event === "deploy_started")).toMatchObject({ project: "site", deploy_id: "d42", url: "https://site.layero.app" });
  });

  it("--no-deploy: проект остаётся в мастере — setup_pending с адресом панели, ни детекта, ни сборки", async () => {
    const c = capture();
    try { await projectsCreateCmd({ repo: "gitverse:acme/site", deploy: false }); } finally { c.restore(); }
    const ev = c.events();
    expect(ev.map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_unavailable", "setup_pending"]);
    expect(ev[3]).toMatchObject({ project: "site", url: "https://app.layero.ru/projects/p1/setup" });
    expect(M.detectProject).not.toHaveBeenCalled();
    expect(M.applySetup).not.toHaveBeenCalled();
    expect(M.triggerRepoDeploy).not.toHaveBeenCalled();
  });

  it("детект или настройка упали — проект создан, setup_failed с адресом мастера, без исключения", async () => {
    const { ApiError } = await import("../src/api.js");
    M.detectProject.mockRejectedValue(new ApiError("x", 502, "GitHub не отвечает"));
    const c = capture();
    try { await projectsCreateCmd({ repo: "github:acme/site" }); } finally { c.restore(); }
    const ev = c.events();
    expect(ev.map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_installed", "setup_failed"]);
    expect(ev[3]).toMatchObject({ project: "site", reason: "GitHub не отвечает", url: "https://app.layero.ru/projects/p1/setup" });
    expect(ev[3].hint).toContain("https://app.layero.ru/projects/p1/setup");
    expect(M.triggerRepoDeploy).not.toHaveBeenCalled();
  });

  it("настройки применены, а сборка не запустилась — setup_applied, затем setup_failed", async () => {
    const { ApiError } = await import("../src/api.js");
    M.triggerRepoDeploy.mockRejectedValue(new ApiError("x", 409, "repo not connected"));
    const c = capture();
    try { await projectsCreateCmd({ repo: "gitverse:acme/site" }); } finally { c.restore(); }
    const ev = c.events();
    expect(ev.map((e) => e.event)).toEqual(["project_created", "source_connected", "webhook_unavailable", "setup_applied", "setup_failed"]);
    expect(ev[4].hint).toContain("не запустилась");
  });

  it("приложение: тип ставится до первой сборки как вывод платформы, настройки сборки — нет", async () => {
    M.detectProject.mockResolvedValue({ ...DETECT, framework: "fastapi", runtime_kind: "python_web", build_cmd: "", output_dir: "" });
    const c = capture();
    try { await projectsCreateCmd({ repo: "gitverse:acme/site" }); } finally { c.restore(); }
    expect(M.applySetup).toHaveBeenCalledWith("p1", {});
    // `platform`: тип вывел детект, и сборщик вправе уточнить его по клону.
    // С `user` проект заперт на догадке, как было у мастера до 13.09.
    expect(M.setRuntimeType).toHaveBeenCalledWith("p1", "python_web", false, "platform");
    expect(c.events().map((e) => e.event)).toContain("runtime_type_applied");
    expect(setupPayloadFromDetect({ ...DETECT, framework: "next", runtime_kind: "ssr_next" } as any)).toEqual({});
  });

  it("в проект уходит только решение: менеджер пакетов из layero.json и папка приложения в монорепо", () => {
    // Менеджер пакетов по лок-файлу сборщик выведет сам; из layero.json — выбор владельца.
    expect(setupPayloadFromDetect({ ...DETECT } as any)).toEqual({});
    expect(setupPayloadFromDetect({ ...DETECT, layero_found: true } as any)).toEqual({ package_manager: "pnpm" });
    // Без папки сборщик при нескольких приложениях откажет — её закрепляем.
    expect(setupPayloadFromDetect({ ...DETECT, suggested_root_directory: "apps/web" } as any)).toEqual({ root_directory: "apps/web" });
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
