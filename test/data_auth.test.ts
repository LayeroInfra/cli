// Вход пользователей приложения из терминала (R2-18, 27.10.2026).
//  · секрет провайдера уходит серверу, но не в вывод и не аргументом;
//  · у VK ID секрета нет;
//  · адреса возврата правятся списком, а не затираются;
//  · без --yes ключи не удаляются.
import { describe, expect, it, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  listDatabases: vi.fn(),
  getDataAuthState: vi.fn(),
  setDataAuthProvider: vi.fn(),
  setDataAuthProviderOptions: vi.fn(),
  deleteDataAuthProvider: vi.fn(),
  setDataAuthSettings: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    constructor() { Object.assign(this, api); }
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn(async () => ({ apiUrl: "x", token: "t" })) }));

import {
  dataAuthMethodsCmd, dataAuthProviderRemoveCmd, dataAuthProviderSetCmd,
  dataAuthRedirectsCmd, dataAuthStatusCmd,
} from "../src/commands/data-auth.js";
import { setMode } from "../src/agent.js";

const DB = { id: "db-1", name: "inbox", name_slug: "inbox", api_enabled: true };
const SECRET = "yandex-secret-value";

async function capture(run: () => Promise<unknown>): Promise<{ out: string; error: any }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => {
    lines.push(String(c));
    return true;
  }) as any);
  let error: any = null;
  try {
    await run();
  } catch (e) {
    error = e;
  } finally {
    spy.mockRestore();
  }
  return { out: lines.join(""), error };
}

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  api.listOrganizations.mockResolvedValue([{ slug: "acme", kind: "personal" }]);
  api.listDatabases.mockResolvedValue([DB]);
  api.getDataAuthState.mockResolvedValue({
    callback_url: "https://data.layero.ru/inbox/auth/v1/callback",
    password_enabled: true, magiclink_enabled: false, signup_open: true, confirm_email: true,
    email_return_urls: ["https://inbox.layero.app"],
    providers: [
      { provider: "yandex", configured: true, enabled: true, return_urls: ["https://inbox.layero.app"] },
      { provider: "vkid", configured: false, enabled: false, return_urls: [] },
    ],
  });
});

describe("data auth", () => {
  it("status — провайдеры и способы без ключей", async () => {
    const { out, error } = await capture(() => dataAuthStatusCmd({ json: true }));
    expect(error).toBeNull();
    expect(out).toContain("data_auth_status");
    expect(out).toContain("https://data.layero.ru/inbox/auth/v1/callback");
  });

  it("provider set: секрет из окружения уходит серверу, но не в вывод", async () => {
    process.env.ZG_YA = SECRET;
    const { out, error } = await capture(() =>
      dataAuthProviderSetCmd("yandex", { clientId: "cid", secretFromEnv: "ZG_YA", json: true }));
    delete process.env.ZG_YA;
    expect(error).toBeNull();
    expect(api.setDataAuthProvider).toHaveBeenCalledWith("acme", "db-1",
      { provider: "yandex", client_id: "cid", client_secret: SECRET });
    expect(out).toContain("data_auth_provider_set");
    expect(out).not.toContain(SECRET);
  });

  it("у VK ID секрета нет — и не спрашиваем", async () => {
    const { error } = await capture(() => dataAuthProviderSetCmd("vkid", { clientId: "vk1", json: true }));
    expect(error).toBeNull();
    expect(api.setDataAuthProvider).toHaveBeenCalledWith("acme", "db-1",
      { provider: "vkid", client_id: "vk1", client_secret: "" });
  });

  it("неизвестный провайдер — отказ до сервера", async () => {
    const { error } = await capture(() => dataAuthProviderSetCmd("google", { clientId: "x", json: true }));
    expect(error?.code).toBe("invalid_choice");
    expect(api.setDataAuthProvider).not.toHaveBeenCalled();
  });

  it("redirects add дописывает к списку, а не затирает его", async () => {
    await capture(() => dataAuthRedirectsCmd("add", "yandex", "http://localhost:5173/auth", { json: true }));
    expect(api.setDataAuthProviderOptions).toHaveBeenCalledWith("acme", "db-1", "yandex",
      { return_urls: ["https://inbox.layero.app", "http://localhost:5173/auth"] });
    await capture(() => dataAuthRedirectsCmd("remove", "email", "https://inbox.layero.app", { json: true }));
    expect(api.setDataAuthSettings).toHaveBeenCalledWith("acme", "db-1", { email_return_urls: [] });
  });

  it("remove без --yes ничего не удаляет", async () => {
    const { error } = await capture(() => dataAuthProviderRemoveCmd("yandex", { json: true }));
    expect(error?.code).toBe("confirmation_required");
    expect(api.deleteDataAuthProvider).not.toHaveBeenCalled();
  });

  it("methods: on/off в настройки, мусор — отказ", async () => {
    await capture(() => dataAuthMethodsCmd({ password: "on", link: "off", json: true }));
    expect(api.setDataAuthSettings).toHaveBeenCalledWith("acme", "db-1",
      { password_enabled: true, magiclink_enabled: false });
    const { error } = await capture(() => dataAuthMethodsCmd({ signup: "maybe", json: true }));
    expect(error?.code).toBe("invalid_choice");
  });
});
