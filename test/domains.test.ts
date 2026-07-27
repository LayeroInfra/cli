// Домены в CLI (AGENT-09).
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getProject, listDomains, addDomain, getDomainInstructions, verifyDomain, removeDomain, loadProjectConfig } =
  vi.hoisted(() => ({
    getProject: vi.fn(), listDomains: vi.fn(), addDomain: vi.fn(),
    getDomainInstructions: vi.fn(), verifyDomain: vi.fn(), removeDomain: vi.fn(),
    loadProjectConfig: vi.fn(),
  }));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    getProject = getProject; listDomains = listDomains; addDomain = addDomain;
    getDomainInstructions = getDomainInstructions; verifyDomain = verifyDomain;
    removeDomain = removeDomain;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn(async () => ({ apiUrl: "x", token: "t" })) }));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig }));

import { domainsAddCmd, domainsRemoveCmd, domainsVerifyCmd } from "../src/commands/domains.js";
import { setMode } from "../src/agent.js";

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  loadProjectConfig.mockResolvedValue({ project_id: "p1" });
  getProject.mockResolvedValue({ id: "p1", slug: "site" });
  getDomainInstructions.mockResolvedValue({ checks: {}, records: [{ type: "A", name: "@", values: ["1.2.3.4"] }] });
});

describe("add", () => {
  it("не ждёт готовности — DNS расходится минутами, посередине человек", async () => {
    addDomain.mockResolvedValue({ id: "d1", domain: "example.com", ssl_status: "dns_pending", verified: false });
    await domainsAddCmd("example.com", { json: true });
    // Ключевое: verify НЕ вызывается. Крутиться в ожидании тут — сжигать
    // время впустую, у платформы есть фоновая перепроверка.
    expect(verifyDomain).not.toHaveBeenCalled();
    expect(addDomain).toHaveBeenCalledWith("p1", "example.com");
  });

  it("URL из адресной строки передаётся как есть — нормализует бэкенд", async () => {
    addDomain.mockResolvedValue({ id: "d1", domain: "shop.example.com", ssl_status: "dns_pending", verified: false });
    await domainsAddCmd("https://shop.example.com/page?x=1", { json: true });
    expect(addDomain).toHaveBeenCalledWith("p1", "https://shop.example.com/page?x=1");
  });
});

describe("verify", () => {
  it("находит домен, даже если передали со схемой", async () => {
    listDomains.mockResolvedValue([{ id: "d1", domain: "example.com", verified: false, ssl_status: "dns_pending" }]);
    verifyDomain.mockResolvedValue({ id: "d1", domain: "example.com", verified: true, ssl_status: "active" });
    await domainsVerifyCmd("https://example.com", { json: true });
    expect(verifyDomain).toHaveBeenCalledWith("p1", "d1");
  });

  it("непривязанный домен — понятная ошибка", async () => {
    listDomains.mockResolvedValue([]);
    await expect(domainsVerifyCmd("nope.com", { json: true })).rejects.toThrow(/не привязан/);
  });
});

describe("remove", () => {
  it("403 объясняется через scope, а не сырым HTTP", async () => {
    const { ApiError } = await import("../src/api.js");
    listDomains.mockResolvedValue([{ id: "d1", domain: "example.com", verified: true, ssl_status: "active" }]);
    removeDomain.mockRejectedValue(new (ApiError as any)("forbidden", 403, "{}"));
    // Подсказка живёт в next_action, а не в message: агент читает именно её.
    const err = await domainsRemoveCmd("example.com", { json: true, yes: true }).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(err.next_action).toMatch(/admin/);
    expect(err.message).toMatch(/нет прав/);
  });
});
