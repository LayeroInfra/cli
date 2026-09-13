// Data API из терминала (T-20260911-9): ключи, сайты, уровни доступа.
//
// Главное, что проверяется:
//  · значения ключей не уезжают в вывод списка — даже если сервер их пришлёт;
//  · без `--yes` вне терминала ни уровень, ни отзыв, ни удаление сайта не
//    применяются, и команда завершается ОШИБКОЙ, а не зелёным кодом 0;
//  · ответ «нет» в терминале ничего не применяет;
//  · применение уровней идёт со сверкой: серверу уходят ровно показанные команды.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  listDatabases: vi.fn(),
  listDataKeys: vi.fn(),
  issueDataKey: vi.fn(),
  revokeDataKey: vi.fn(),
  listDataOrigins: vi.fn(),
  addDataOrigin: vi.fn(),
  removeDataOrigin: vi.fn(),
  listDataMethods: vi.fn(),
  setDataLevels: vi.fn(),
  enableDataApi: vi.fn(),
}));
const prompt = vi.hoisted(() => ({ answer: "n", asked: [] as string[] }));

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
vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: () => ({
      question: async (q: string) => { prompt.asked.push(q); return prompt.answer; },
      close: () => {},
    }),
  },
}));

import {
  dataEnableCmd,
  dataGrantCmd,
  dataKeysIssueCmd,
  dataKeysListCmd,
  dataKeysRevokeCmd,
  dataMethodsCmd,
  dataOriginsAddCmd,
  dataOriginsRemoveCmd,
  registerDataApiCommands,
} from "../src/commands/data-api.js";
import { setMode } from "../src/agent.js";

const SECRET = "sk_live_полное_значение_ключа";
const DB = { id: "db-1", name: "Кофейня", name_slug: "kofeinya", api_enabled: true };

const PLAN = {
  object: { kind: "table", schema: "app", name: "products" },
  current: { GET: "closed", POST: "closed", PATCH: "closed", DELETE: "closed" },
  next: { GET: "visitor", POST: "closed", PATCH: "closed", DELETE: "closed" },
  sql: ["GRANT USAGE ON SCHEMA app TO u_anon;", "GRANT SELECT ON app.products TO u_anon;"],
  warnings: ["Защита строк у app.products выключена"],
  applied: false,
};

/** Вывод команды событиями и её исход: ошибка не прячет то, что успело уйти в stdout. */
async function capture(run: () => Promise<unknown>): Promise<{ events: any[]; error: any }> {
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
  return { events: lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)), error };
}

async function events(run: () => Promise<unknown>): Promise<any[]> {
  const out = await capture(run);
  if (out.error) throw out.error;
  return out.events;
}

beforeEach(() => {
  vi.clearAllMocks();
  prompt.answer = "n";
  prompt.asked = [];
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  api.listOrganizations.mockResolvedValue([{ slug: "acme", kind: "personal" }]);
  api.listDatabases.mockResolvedValue([DB, { id: "db-2", name: "Черновик", name_slug: "draft", api_enabled: false }]);
  // 🚨 В ФИКСТУРЕ ЕСТЬ ЗНАЧЕНИЕ, ХОТЯ СЕРВЕР ЕГО НЕ ШЛЁТ: худший случай нарочно.
  // Поле, которого в фикстуре нет, утечь в тесте не может.
  api.listDataKeys.mockResolvedValue([
    { id: "k1", key_prefix: "pk_live_ab12", is_public: true, label: "по умолчанию", in_build: true,
      key: "pk_live_полное", key_value_enc: "enc", created_at: "2026-09-01T10:00:00Z",
      last_used_at: null, expires_at: null },
    { id: "k2", key_prefix: "sk_live_cd34", is_public: false, label: "сервер", key: SECRET,
      is_service: false, expires_at: "2026-12-01T00:00:00Z" },
  ]);
  api.setDataLevels.mockImplementation(async (_o: string, _d: string, body: any) =>
    body.apply ? { ...PLAN, current: PLAN.next, applied: true } : PLAN);
});

describe("ключи", () => {
  it("список не несёт значений ключей", async () => {
    const out = await events(() => dataKeysListCmd({ db: "kofeinya" }));
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("pk_live_полное");
    expect(text).not.toContain("key_value_enc");
    expect(out[0]).toMatchObject({ event: "data_keys", org: "acme", database: "kofeinya" });
    expect(out[0].keys.map((k: any) => [k.kind, k.prefix, k.in_build])).toEqual([
      ["public", "pk_live_ab12", true],
      ["secret", "sk_live_cd34", false],
    ]);
  });

  it("без --db берётся единственная база с Data API", async () => {
    await events(() => dataKeysListCmd({}));
    expect(api.listDataKeys).toHaveBeenCalledWith("acme", "db-1");
  });

  it("база без Data API — отказ с подсказкой, а не пустой список", async () => {
    await expect(dataKeysListCmd({ db: "draft" })).rejects.toMatchObject({ code: "data_api_disabled" });
    expect(api.listDataKeys).not.toHaveBeenCalled();
  });

  it("выпуск передаёт срок и отдаёт значение один раз", async () => {
    api.issueDataKey.mockResolvedValue({ id: "k3", key: SECRET, prefix: "sk_live_ef56", is_public: false });
    const out = await events(() => dataKeysIssueCmd({ db: "kofeinya", kind: "secret", expiresIn: "90", label: "CRM" }));
    expect(api.issueDataKey).toHaveBeenCalledWith("acme", "db-1", { kind: "secret", label: "CRM", expires_in_days: 90 });
    expect(out).toEqual([expect.objectContaining({ event: "data_key_issued", key: SECRET, kind: "secret" })]);
  });

  it("неподдерживаемый срок — отказ до запроса", async () => {
    await expect(dataKeysIssueCmd({ db: "kofeinya", expiresIn: "7" })).rejects.toMatchObject({ code: "data_key_expiry" });
    await expect(dataKeysIssueCmd({ db: "kofeinya", kind: "admin" })).rejects.toMatchObject({ code: "data_key_kind" });
    expect(api.issueDataKey).not.toHaveBeenCalled();
  });

  it("отзыв без --yes вне терминала не выполняется", async () => {
    const err = await dataKeysRevokeCmd("pk_live_ab12", { db: "kofeinya" }).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "confirmation_required" });
    expect(String(err.message)).toContain("в сборке");
    expect(api.revokeDataKey).not.toHaveBeenCalled();
  });

  it("отзыв по префиксу с --yes", async () => {
    const out = await events(() => dataKeysRevokeCmd("sk_live_cd34…", { db: "kofeinya", yes: true }));
    expect(api.revokeDataKey).toHaveBeenCalledWith("acme", "db-1", "k2");
    expect(out[0]).toMatchObject({ event: "data_key_revoked", id: "k2" });
  });

  it("префикс нескольких ключей — отказ, а не первый попавшийся", async () => {
    api.listDataKeys.mockResolvedValue([
      { id: "k1", key_prefix: "pk_live_ab12", is_public: true },
      { id: "k9", key_prefix: "pk_live_ab12", is_public: true },
    ]);
    const err = await dataKeysRevokeCmd("pk_live_ab12", { db: "kofeinya", yes: true }).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "data_key_ambiguous" });
    expect(String(err.next_action)).toContain("k9");
    expect(api.revokeDataKey).not.toHaveBeenCalled();
  });

  it("ответ «нет» в терминале не отзывает", async () => {
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dataKeysRevokeCmd("pk_live_ab12", { db: "kofeinya" });
    } finally {
      log.mockRestore();
    }
    expect(prompt.asked[0]).toContain("pk_live_ab12");
    expect(api.revokeDataKey).not.toHaveBeenCalled();
  });
});

describe("сайты", () => {
  it("добавление передаёт пометку", async () => {
    await events(() => dataOriginsAddCmd("https://shop.example", { db: "kofeinya", note: "витрина" }));
    expect(api.addDataOrigin).toHaveBeenCalledWith("acme", "db-1", "https://shop.example", "витрина");
  });

  it("удаление без --yes не выполняется", async () => {
    await expect(dataOriginsRemoveCmd("https://shop.example", { db: "kofeinya" }))
      .rejects.toMatchObject({ code: "confirmation_required" });
    expect(api.removeDataOrigin).not.toHaveBeenCalled();
    await events(() => dataOriginsRemoveCmd("https://shop.example", { db: "kofeinya", yes: true }));
    expect(api.removeDataOrigin).toHaveBeenCalledWith("acme", "db-1", "https://shop.example");
  });
});

describe("уровни доступа", () => {
  it("без --yes вне терминала — показ, ничего не применено и код ошибки", async () => {
    const { events: out, error } = await capture(() => dataGrantCmd("app.products", { db: "kofeinya", get: "visitor" }));
    expect(error).toMatchObject({ code: "confirmation_required" });
    expect(api.setDataLevels).toHaveBeenCalledTimes(1);
    expect(api.setDataLevels).toHaveBeenCalledWith("acme", "db-1", {
      object: "app.products", levels: { GET: "visitor" }, level: null, apply: false,
    });
    expect(out).toEqual([expect.objectContaining({
      event: "data_grant", applied: false, sql: PLAN.sql, warnings: PLAN.warnings,
      next_action: expect.stringContaining("--yes"),
    })]);
  });

  it("с --yes применяет ровно показанные команды и в --json не пишет человеческий текст", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let out: any[];
    try {
      out = await events(() => dataGrantCmd("app.products", { db: "kofeinya", get: "VISITOR", delete: "closed", yes: true }));
    } finally {
      log.mockRestore();
    }
    expect(log).not.toHaveBeenCalled();
    expect(api.setDataLevels).toHaveBeenCalledTimes(2);
    expect(api.setDataLevels.mock.calls[1]![2]).toEqual({
      object: "app.products", levels: { GET: "visitor", DELETE: "closed" }, level: null,
      apply: true, expected_sql: PLAN.sql,
    });
    expect(out!).toEqual([expect.objectContaining({ event: "data_grant", applied: true })]);
  });

  it("в терминале: «нет» не применяет, «да» применяет показанное", async () => {
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dataGrantCmd("app.products", { db: "kofeinya", get: "visitor" });
      expect(api.setDataLevels).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.flat().join("\n")).toContain("GRANT SELECT ON app.products");
      prompt.answer = "y";
      await dataGrantCmd("app.products", { db: "kofeinya", get: "visitor" });
    } finally {
      log.mockRestore();
    }
    expect(api.setDataLevels).toHaveBeenCalledTimes(3);
    expect(api.setDataLevels.mock.calls[2]![2]).toMatchObject({ apply: true, expected_sql: PLAN.sql });
  });

  it("функция — уровнем вызова", async () => {
    await capture(() => dataGrantCmd("api.order_create", { db: "kofeinya", call: "server" }));
    expect(api.setDataLevels.mock.calls[0]![2]).toMatchObject({ levels: null, level: "server" });
  });

  it("неизвестный уровень и пустой набор — отказ до запроса", async () => {
    await expect(dataGrantCmd("app.products", { db: "kofeinya", get: "everyone" }))
      .rejects.toMatchObject({ code: "data_level_unknown" });
    await expect(dataGrantCmd("app.products", { db: "kofeinya" }))
      .rejects.toMatchObject({ code: "data_levels_missing" });
    expect(api.setDataLevels).not.toHaveBeenCalled();
  });

  it("методы отдаются как есть — и таблицы, и функции", async () => {
    api.listDataMethods.mockResolvedValue({
      roles: {},
      tables: [{ schema: "app", name: "products" }],
      functions: [{ signature: "api.menu()", level: "visitor" }],
    });
    const out = await events(() => dataMethodsCmd({ db: "kofeinya" }));
    expect(out[0]).toMatchObject({
      event: "data_methods",
      tables: [{ schema: "app", name: "products" }],
      functions: [{ signature: "api.menu()", level: "visitor" }],
    });
  });
});

describe("включение", () => {
  it("без --db — единственная база без Data API, с секретным ключом", async () => {
    api.enableDataApi.mockResolvedValue({ slug: "draft", key: { key: "pk_live_new" }, secret_key: { key: SECRET } });
    const out = await events(() => dataEnableCmd({ withSecret: true }));
    expect(api.enableDataApi).toHaveBeenCalledWith("acme", "db-2", true);
    expect(out[0]).toMatchObject({ event: "data_api_enabled", public_key: "pk_live_new", secret_key: SECRET });
  });
});

describe("регистрация команд", () => {
  it("флаги уровней, подтверждения и срока объявлены", () => {
    const program = new Command();
    const data = program.command("data");
    registerDataApiCommands(data, program);
    const find = (path: string[]) => path.reduce<Command | undefined>(
      (cmd, name) => cmd?.commands.find((c) => c.name() === name), data);
    const flags = (path: string[]) => (find(path)?.options ?? []).map((o) => o.long);
    expect(flags(["grant"])).toEqual(expect.arrayContaining(["--get", "--post", "--patch", "--delete", "--call", "--yes", "--db", "--org"]));
    expect(flags(["keys", "issue"])).toEqual(expect.arrayContaining(["--kind", "--label", "--expires-in"]));
    expect(flags(["keys", "revoke"])).toContain("--yes");
    expect(flags(["origins", "remove"])).toContain("--yes");
    expect(flags(["enable"])).toContain("--with-secret");
    expect(find(["methods"])).toBeDefined();
  });
});
