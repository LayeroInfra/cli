// `--json` у команд, которые раньше печатали человеку и молчали агенту
// (этап 6 AX-аудита): whoami, projects list, orgs list, link, hooks *,
// logout. В JSON-режиме — по событию на команду; без токена — `auth_required`,
// а не «not logged in» с exit 1.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { me, listProjects, listOrganizations, getProject, listDeployHooks, createDeployHook, deleteDeployHook, loadConfig, loadProjectConfig, persistProjectLinking, clearConfig } =
  vi.hoisted(() => ({
    me: vi.fn(), listProjects: vi.fn(), listOrganizations: vi.fn(), getProject: vi.fn(),
    listDeployHooks: vi.fn(), createDeployHook: vi.fn(), deleteDeployHook: vi.fn(),
    loadConfig: vi.fn(), loadProjectConfig: vi.fn(), persistProjectLinking: vi.fn(), clearConfig: vi.fn(),
  }));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    me = me; listProjects = listProjects; listOrganizations = listOrganizations; getProject = getProject;
    listDeployHooks = listDeployHooks; createDeployHook = createDeployHook; deleteDeployHook = deleteDeployHook;
    async resolveProject(ref: string) {
      const all = await listProjects();
      const found = all.find((p: any) => p.slug === ref || p.id === ref);
      if (!found) {
        const { LayeroError } = await import("../src/agent.js");
        throw new LayeroError("project_unknown", `проекта «${ref}» нет`, "layero projects list");
      }
      return found;
    }
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig, clearConfig, configPath: () => "/home/u/.layero/config.json" }));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig, persistProjectLinking }));

import { whoamiCmd } from "../src/commands/whoami.js";
import { projectsListCmd } from "../src/commands/projects.js";
import { orgsListCmd } from "../src/commands/orgs.js";
import { linkCmd } from "../src/commands/link.js";
import { logoutCmd } from "../src/commands/logout.js";
import { hooksCreateCmd, hooksDeleteCmd, hooksListCmd } from "../src/commands/hooks.js";
import { LayeroError, setMode } from "../src/agent.js";

const PROJECT = {
  id: "11111111-1111-1111-1111-111111111111", slug: "site", name: "site", apex_hostname: "site.layero.app",
  source_type: "cli", repo_full_name: null, status: "active", framework_hint: "vite",
  organization: { slug: "valya" },
};

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { lines.push(String(c)); return true; }) as any);
  return { lines, restore: () => spy.mockRestore() };
}
function events(lines: string[]): any[] {
  return lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru", token: "t" });
  loadProjectConfig.mockResolvedValue({ project_id: PROJECT.id });
  me.mockResolvedValue({ id: "u1", username: "valya", email: "v@x", github_login: null });
  listProjects.mockResolvedValue([PROJECT]);
  listOrganizations.mockResolvedValue([{ id: "o1", slug: "valya", kind: "personal", my_role: "admin", github_login: null }]);
  listDeployHooks.mockResolvedValue([{ id: "h1", name: "cms", branch: null, target: "preview", url: "https://api.layero.ru/hooks/x", created_at: "", last_triggered_at: null }]);
  createDeployHook.mockResolvedValue({ id: "h2", name: "pub", branch: null, target: "production", url: "https://api.layero.ru/hooks/y", created_at: "", last_triggered_at: null });
  deleteDeployHook.mockResolvedValue(undefined);
  persistProjectLinking.mockResolvedValue({});
});

describe("JSON-события", () => {
  it("whoami → me", async () => {
    const c = capture();
    try { await whoamiCmd(); } finally { c.restore(); }
    const [e] = events(c.lines);
    expect(e).toMatchObject({ event: "me", id: "u1", username: "valya", email: "v@x" });
  });

  it("projects list → projects с адресами и репозиторием", async () => {
    const c = capture();
    try { await projectsListCmd(); } finally { c.restore(); }
    const [e] = events(c.lines);
    expect(e.event).toBe("projects");
    expect(e.projects[0]).toMatchObject({ slug: "site", url: "https://site.layero.app", organization: "valya", repo: null });
  });

  it("orgs list → organizations", async () => {
    const c = capture();
    try { await orgsListCmd(); } finally { c.restore(); }
    expect(events(c.lines)[0]).toMatchObject({ event: "organizations", organizations: [{ slug: "valya", kind: "personal", role: "admin" }] });
  });

  it("link по слагу → project_linked с url и status; UUID не уходит в поиск по слагу", async () => {
    const c = capture();
    try { await linkCmd("site"); } finally { c.restore(); }
    expect(events(c.lines)[0]).toMatchObject({ event: "project_linked", slug: "site", url: "https://site.layero.app", status: "active" });
    expect(persistProjectLinking).toHaveBeenCalledTimes(1);
  });

  it("logout → logged_out", async () => {
    const c = capture();
    try { await logoutCmd(); } finally { c.restore(); }
    expect(events(c.lines)[0]).toMatchObject({ event: "logged_out", config_path: "/home/u/.layero/config.json" });
    expect(clearConfig).toHaveBeenCalled();
  });

  it("hooks list / create / delete → hooks, hook_created, hook_deleted", async () => {
    const c = capture();
    try {
      await hooksListCmd({});
      await hooksCreateCmd("pub", { prod: true });
      await hooksDeleteCmd("h1", {});
    } finally { c.restore(); }
    const ev = events(c.lines);
    expect(ev.map((e) => e.event)).toEqual(["hooks", "hook_created", "hook_deleted"]);
    expect(ev[1]).toMatchObject({ target: "production", url: "https://api.layero.ru/hooks/y" });
    expect(createDeployHook).toHaveBeenCalledWith(PROJECT.id, { name: "pub", branch: null, target: "production" });
  });
});

describe("отказы — кодами, а не текстом", () => {
  it("без токена — auth_required у whoami, projects, orgs, hooks", async () => {
    loadConfig.mockResolvedValue({ apiUrl: "x" });
    for (const fn of [whoamiCmd, projectsListCmd, orgsListCmd, () => hooksListCmd({})]) {
      await expect(fn()).rejects.toMatchObject({ code: "auth_required" });
    }
  });
  it("hooks без проекта — project_unknown", async () => {
    loadProjectConfig.mockResolvedValue(null);
    await expect(hooksListCmd({})).rejects.toMatchObject({ code: "project_unknown" });
  });
  it("удаление несуществующего хука — hook_not_found", async () => {
    const { ApiError } = await import("../src/api.js");
    deleteDeployHook.mockRejectedValue(new ApiError("x", 404, ""));
    await expect(hooksDeleteCmd("nope", {})).rejects.toMatchObject({ code: "hook_not_found" });
  });
  it("link на неизвестный слаг — project_unknown (LayeroError)", async () => {
    await expect(linkCmd("ghost")).rejects.toBeInstanceOf(LayeroError);
  });
});

describe("человеку — как раньше", () => {
  it("whoami печатает строки, а не JSON", async () => {
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const c = capture();
    try { await whoamiCmd(); } finally { c.restore(); }
    const out = c.lines.join("");
    expect(out).toContain("username: valya");
    expect(out).not.toContain('"event"');
  });
});
