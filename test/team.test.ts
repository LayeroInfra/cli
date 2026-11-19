// Команды `layero team …` (alpha, core docs/TEAMS.md).
import { describe, expect, it, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  listOrganizations: vi.fn(), listTeamMembers: vi.fn(), listTeamInvites: vi.fn(), createTeamInvite: vi.fn(),
  revokeTeamInvite: vi.fn(), updateTeamMemberRole: vi.fn(), removeTeamMember: vi.fn(),
  getTeamProjectAccess: vi.fn(), setTeamProjectAccess: vi.fn(), getTeamSeats: vi.fn(), changeTeamSeats: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    listOrganizations = m.listOrganizations; listTeamMembers = m.listTeamMembers;
    listTeamInvites = m.listTeamInvites; createTeamInvite = m.createTeamInvite;
    revokeTeamInvite = m.revokeTeamInvite; updateTeamMemberRole = m.updateTeamMemberRole;
    removeTeamMember = m.removeTeamMember; getTeamProjectAccess = m.getTeamProjectAccess;
    setTeamProjectAccess = m.setTeamProjectAccess; getTeamSeats = m.getTeamSeats;
    changeTeamSeats = m.changeTeamSeats; listProjects = m.listProjects;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn(async () => ({ apiUrl: "x", token: "t" })) }));

import { ApiError } from "../src/api.js";
import { setMode } from "../src/agent.js";
import { teamAccessCmd, teamInviteCmd, teamListCmd, teamRemoveCmd, teamRoleCmd, teamSeatsCmd } from "../src/commands/team.js";

const ILYA = { user_id: "u-ilya", email: "ilya@sever.studio", username: "ilya", role: "editor", added_at: null,
  project_access: { default_level: "edit", exceptions: [] } };
let out: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out.push(String(s)); return true; });
  m.listOrganizations.mockResolvedValue([
    { id: "o1", slug: "me", kind: "personal", my_role: "admin" },
    { id: "o2", slug: "sever", kind: "team", my_role: "admin", team_rights: true },
  ]);
  m.listTeamMembers.mockResolvedValue([ILYA]);
  m.listTeamInvites.mockResolvedValue([]);
});

const events = () => out.map((l) => JSON.parse(l));

describe("invite", () => {
  it("developer — это editor в API; по умолчанию разработчик", async () => {
    m.createTeamInvite.mockResolvedValue({});
    await teamInviteCmd("new@x.ru", { org: "sever" });
    expect(m.createTeamInvite).toHaveBeenCalledWith("sever", "new@x.ru", "editor");
    await teamInviteCmd("g@x.ru", { org: "sever", role: "guest" });
    expect(m.createTeamInvite).toHaveBeenLastCalledWith("sever", "g@x.ru", "viewer");
  });

  it("нет свободного места — понятный код и что делать", async () => {
    m.createTeamInvite.mockRejectedValue(new ApiError("x", 409, '{"detail":{"code":"seat_required","message":"m"}}'));
    await expect(teamInviteCmd("new@x.ru", { org: "sever" })).rejects.toMatchObject({ code: "seat_required" });
  });

  it("незнакомая роль — неверный ввод, до запроса", async () => {
    await expect(teamInviteCmd("new@x.ru", { org: "sever", role: "admin" })).rejects.toMatchObject({ code: "invalid_choice" });
    expect(m.createTeamInvite).not.toHaveBeenCalled();
  });

  it("без --org — личная организация; чужая — org_unknown", async () => {
    m.createTeamInvite.mockResolvedValue({});
    await teamInviteCmd("new@x.ru", {});
    expect(m.createTeamInvite).toHaveBeenCalledWith("me", "new@x.ru", "editor");
    await expect(teamInviteCmd("new@x.ru", { org: "acme" })).rejects.toMatchObject({ code: "org_unknown" });
  });
});

describe("role и remove", () => {
  it("гость — viewer; участника нет — member_not_found", async () => {
    m.updateTeamMemberRole.mockResolvedValue({});
    await teamRoleCmd("ILYA@sever.studio", "guest", { org: "sever" });
    expect(m.updateTeamMemberRole).toHaveBeenCalledWith("sever", "u-ilya", "viewer");
    await expect(teamRoleCmd("nobody@x.ru", "guest", { org: "sever" })).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("remove отзывает приглашение, если такого участника нет", async () => {
    m.listTeamInvites.mockResolvedValue([{ id: "i1", email: "p@x.ru", role: "editor", status: "pending", expires_at: "" }]);
    await teamRemoveCmd("p@x.ru", { org: "sever" });
    expect(m.revokeTeamInvite).toHaveBeenCalledWith("sever", "i1");
    expect(m.removeTeamMember).not.toHaveBeenCalled();
  });
});

describe("access", () => {
  it("исключения добавляются к прежним, проект — по слагу своей команды", async () => {
    m.getTeamProjectAccess.mockResolvedValue({ user_id: "u-ilya", role: "editor", default_level: "edit",
      exceptions: [{ project_id: "p-blog", level: "none" }] });
    m.listProjects.mockResolvedValue([
      { id: "p-shop", slug: "shop", organization: { slug: "sever" } },
      { id: "p-other", slug: "shop2", organization: { slug: "acme" } },
    ]);
    m.setTeamProjectAccess.mockResolvedValue({ user_id: "u-ilya", role: "editor", default_level: "none", exceptions: [] });
    await teamAccessCmd("ilya@sever.studio", { org: "sever", all: "none", project: ["shop=edit"] });
    expect(m.setTeamProjectAccess).toHaveBeenCalledWith("sever", "u-ilya", {
      default_level: "none",
      exceptions: [{ project_id: "p-blog", level: "none" }, { project_id: "p-shop", level: "edit" }],
    });
    await expect(teamAccessCmd("ilya@sever.studio", { org: "sever", project: ["shop2=edit"] }))
      .rejects.toMatchObject({ code: "project_not_found" });
    await expect(teamAccessCmd("ilya@sever.studio", { org: "sever", all: "write" }))
      .rejects.toMatchObject({ code: "invalid_choice" });
  });

  it("без флагов — только показ, ничего не пишет", async () => {
    m.getTeamProjectAccess.mockResolvedValue({ user_id: "u-ilya", role: "editor", default_level: "view", exceptions: [] });
    await teamAccessCmd("ilya@sever.studio", { org: "sever" });
    expect(m.setTeamProjectAccess).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({ event: "team_access", default_level: "view" });
  });
});

describe("seats и list", () => {
  it("не хватает на балансе — balance_short со ссылкой на пополнение", async () => {
    m.getTeamSeats.mockResolvedValue({ paid_seats: 0, occupied: 0, unit_kopecks: 99000, next_date: null, add_one_kopecks: 500 });
    m.changeTeamSeats.mockRejectedValue(new ApiError("x", 402, '{"detail":{"code":"balance_short","message":"m"}}'));
    await expect(teamSeatsCmd({ org: "sever", add: "1" })).rejects.toMatchObject({ code: "balance_short" });
    await expect(teamSeatsCmd({ org: "sever", add: "0" })).rejects.toMatchObject({ code: "invalid_type" });
  });

  it("не владелец: мест и приглашений не видно — список всё равно выводится", async () => {
    m.listTeamInvites.mockRejectedValue(new ApiError("x", 403, "{}"));
    m.getTeamSeats.mockRejectedValue(new ApiError("x", 403, "{}"));
    await teamListCmd({ org: "sever" });
    const e = events()[0];
    expect(e).toMatchObject({ event: "team", organization: "sever", seats: null, invites: [] });
    expect(e.members[0]).toMatchObject({ email: "ilya@sever.studio", role: "developer" });
  });
});
