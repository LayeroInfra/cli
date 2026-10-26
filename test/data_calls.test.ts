// Исходящие вызовы из терминала (G-12, 26.10.2026): хосты, секреты, описания.
//
// Главное, что проверяется:
//  · значение секрета не уезжает ни в событие, ни в аргументы — только в тело
//    запроса к серверу;
//  · без `--yes` вне терминала удаление ничего не меняет и завершается ОШИБКОЙ;
//  · описание из файла уходит серверу с теми же полями, что на странице доков.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  listDatabases: vi.fn(),
  listDataSecrets: vi.fn(),
  setDataSecret: vi.fn(),
  deleteDataSecret: vi.fn(),
  listDataHosts: vi.fn(),
  addDataHost: vi.fn(),
  deleteDataHost: vi.fn(),
  listDataCalls: vi.fn(),
  saveDataCall: vi.fn(),
  deleteDataCall: vi.fn(),
  listDataCallLog: vi.fn(),
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
  dataCallsRemoveCmd,
  dataCallsSetCmd,
  dataHostsAddCmd,
  dataSecretsListCmd,
  dataSecretsSetCmd,
  parseCallSpec,
} from "../src/commands/data-calls.js";
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

describe("вызовы", () => {
  it("описание из файла уходит серверу как есть", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zg-"));
    const file = join(dir, "telegram_notify.json");
    writeFileSync(file, JSON.stringify({
      name: "telegram_notify",
      method: "post",
      url_template: "https://api.telegram.org/bot{{secrets.TELEGRAM_BOT_TOKEN}}/sendMessage",
      body_template: { chat_id: "{{args.chat_id}}", text: "{{args.text}}" },
    }));
    const { error } = await capture(() => dataCallsSetCmd({ file, json: true }));
    expect(error).toBeNull();
    expect(api.saveDataCall).toHaveBeenCalledWith("acme", "db-1", expect.objectContaining({
      name: "telegram_notify", method: "POST", allow_anon: false, hourly_limit: 600,
      body_template: { chat_id: "{{args.chat_id}}", text: "{{args.text}}" },
    }));
  });

  it("без name или url_template — понятный отказ", () => {
    expect(() => parseCallSpec('{"name":"x"}', "f.json")).toThrow(/url_template/);
    expect(() => parseCallSpec("не json", "f.json")).toThrow(/не JSON/);
  });

  it("удаление без --yes вне терминала — ошибка, ничего не удалено", async () => {
    const { error } = await capture(() => dataCallsRemoveCmd("telegram_notify", { json: true }));
    expect(error?.code).toBe("confirmation_required");
    expect(api.deleteDataCall).not.toHaveBeenCalled();
  });
});

describe("хосты", () => {
  it("добавление зовёт сервер", async () => {
    await capture(() => dataHostsAddCmd("api.telegram.org", { json: true }));
    expect(api.addDataHost).toHaveBeenCalledWith("acme", "db-1", "api.telegram.org");
  });
});

describe("регистрация", () => {
  it("hosts, secrets и calls висят под data", () => {
    const program = new Command();
    const data = program.command("data");
    registerDataApiCommands(data, program);
    const find = (path: string[]) => path.reduce<Command | undefined>(
      (cmd, name) => cmd?.commands.find((c) => c.name() === name), data);
    expect(find(["hosts", "add"])).toBeDefined();
    expect(find(["secrets", "set"])?.options.map((o) => o.long)).toContain("--from-env");
    expect(find(["calls", "set"])?.options.map((o) => o.long)).toContain("--file");
    expect(find(["calls", "log"])).toBeDefined();
    expect(find(["calls", "remove"])?.options.map((o) => o.long)).toContain("--yes");
  });
});
