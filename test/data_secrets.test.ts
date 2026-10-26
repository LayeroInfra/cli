// Секреты базы из терминала (27.10.2026): для HTTP из SQL и входа.
//
// Главное, что проверяется:
//  · значение секрета не уезжает ни в событие, ни в аргументы — только в тело
//    запроса к серверу;
//  · команд `data hosts` и `data calls` больше нет — «Исходящие» сняты.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  listDatabases: vi.fn(),
  listDataSecrets: vi.fn(),
  setDataSecret: vi.fn(),
  deleteDataSecret: vi.fn(),
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

import { dataSecretsListCmd, dataSecretsSetCmd } from "../src/commands/data-secrets.js";
import { registerDataApiCommands } from "../src/commands/data-api.js";
import { setMode } from "../src/agent.js";

const DB = { id: "db-1", name: "Замечено", name_slug: "zamecheno", api_enabled: true };
const TOKEN = "123456:секретный-токен-бота";

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
  api.listDataSecrets.mockResolvedValue([{ name: "TELEGRAM_BOT_TOKEN", created_at: "x", value: TOKEN }]);
});

describe("секреты", () => {
  it("значение из окружения уходит серверу, но не в вывод", async () => {
    process.env.ZG_TEST_TOKEN = TOKEN;
    const { out, error } = await capture(() =>
      dataSecretsSetCmd("TELEGRAM_BOT_TOKEN", { fromEnv: "ZG_TEST_TOKEN", json: true }));
    delete process.env.ZG_TEST_TOKEN;
    expect(error).toBeNull();
    expect(api.setDataSecret).toHaveBeenCalledWith("acme", "db-1", "TELEGRAM_BOT_TOKEN", TOKEN);
    expect(out).toContain("data_secret_set");
    expect(out).not.toContain(TOKEN);
  });

  it("пустая переменная — отказ, сервер не зовётся", async () => {
    const { error } = await capture(() => dataSecretsSetCmd("X", { fromEnv: "ZG_NOT_SET", json: true }));
    expect(error?.code).toBe("bad_format");
    expect(api.setDataSecret).not.toHaveBeenCalled();
  });

  it("список — только имена, даже если сервер прислал значение", async () => {
    const { out } = await capture(() => dataSecretsListCmd({ json: true }));
    expect(JSON.parse(out.trim()).secrets).toEqual(["TELEGRAM_BOT_TOKEN"]);
    expect(out).not.toContain(TOKEN);
  });
});

describe("регистрация", () => {
  it("secrets висит под data, hosts и calls сняты", () => {
    const program = new Command();
    const data = program.command("data");
    registerDataApiCommands(data, program);
    const find = (path: string[]) => path.reduce<Command | undefined>(
      (cmd, name) => cmd?.commands.find((c) => c.name() === name), data);
    expect(find(["secrets", "set"])?.options.map((o) => o.long)).toContain("--from-env");
    expect(find(["hosts"])).toBeUndefined();
    expect(find(["calls"])).toBeUndefined();
  });
});
