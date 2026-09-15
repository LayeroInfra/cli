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
import { readFileSync } from "node:fs";

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
  shellArg,
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
  api.listDatabases.mockResolvedValue([
    DB,
    { id: "db-2", name: "Черновик", name_slug: "draft", api_enabled: false, status: "active", placement: "sandbox", provider: "layero" },
    { id: "db-3", name: "Своя", name_slug: "own", api_enabled: false, status: "active", placement: "external", provider: "external" },
    { id: "db-4", name: "Спит", name_slug: "sleep", api_enabled: false, status: "suspended", placement: "sandbox", provider: "layero" },
  ]);
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
      next_action: expect.stringContaining("layero data grant app.products --db kofeinya --get visitor --yes"),
    })]);
    expect(String(error.next_action)).not.toContain("…");
  });

  it("с --yes применяет ровно показанные команды и в --json не пишет человеческий текст", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let out: any[];
    let printed = -1;
    try {
      out = await events(() => dataGrantCmd("app.products", { db: "kofeinya", get: "VISITOR", delete: "closed", yes: true }));
      printed = log.mock.calls.length;
    } finally {
      log.mockRestore();
    }
    expect(printed).toBe(0);
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

  it("подсказка повтора функции несёт --call и кавычки для shell", async () => {
    const { error } = await capture(() => dataGrantCmd("api.pick(integer)", { db: "kofeinya", call: "server" }));
    expect(error).toMatchObject({ code: "confirmation_required" });
    expect(String(error.next_action)).toContain(
      "layero data grant 'api.pick(integer)' --db kofeinya --call server --yes",
    );
  });

  it("экранирование аргумента подсказки", () => {
    expect(shellArg("app.products")).toBe("app.products");
    expect(shellArg('app."Order"')).toBe(`'app."Order"'`);
    expect(shellArg("it's")).toBe(`'it'\\''s'`);
  });

  it("блокировка — отказ без вопроса и без применения, даже с --yes", async () => {
    const reason = "Схема app принадлежит другой роли";
    api.setDataLevels.mockResolvedValue({ ...PLAN, warnings: [reason], blocked: [reason] });
    const { events: out, error } = await capture(() =>
      dataGrantCmd("app.products", { db: "kofeinya", get: "visitor", yes: true }));
    expect(error).toMatchObject({ code: "data_levels_blocked" });
    expect(String(error.message)).toContain(reason);
    expect(api.setDataLevels).toHaveBeenCalledTimes(1);
    expect(out).toEqual([expect.objectContaining({ event: "data_grant", applied: false, blocked: [reason] })]);

    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    prompt.answer = "y";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let err: any;
    try {
      err = await dataGrantCmd("app.products", { db: "kofeinya", get: "visitor" }).then(() => null, (e) => e);
    } finally {
      log.mockRestore();
    }
    expect(err).toMatchObject({ code: "data_levels_blocked" });
    expect(prompt.asked).toEqual([]);
    expect(api.setDataLevels).toHaveBeenCalledTimes(2);
  });

  it("блокировка в терминале: план печатается и с --yes, причина — только в отказе", async () => {
    const reason = "Метод не заработает: у посетителей не работает ни одна таблица по API";
    api.setDataLevels.mockResolvedValue({ ...PLAN, warnings: [reason, "обычное предупреждение"], blocked: [reason] });
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let err: any;
    let printed = "";
    try {
      err = await dataGrantCmd("app.products", { db: "kofeinya", get: "visitor", yes: true }).then(() => null, (e) => e);
      printed = log.mock.calls.flat().join("\n");
    } finally {
      log.mockRestore();
    }
    expect(err).toMatchObject({ code: "data_levels_blocked" });
    expect(String(err.message)).toContain(reason);
    expect(printed).toContain("GRANT SELECT ON app.products");
    expect(printed).toContain("обычное предупреждение");
    expect(printed).not.toContain(reason);
    expect(api.setDataLevels).toHaveBeenCalledTimes(1);
  });

  it("опись: предупреждения о каталоге и причина «не метод» по виду функции", async () => {
    const warning = "У посетителей не работает ни одна таблица по API";
    api.listDataMethods.mockResolvedValue({
      roles: {},
      warnings: [warning],
      tables: [],
      functions: [
        { signature: "api.pr(x integer)", kind: "procedure", level: "server", path: null, public_only: false },
        { signature: "app.helper()", kind: "function", level: "user", path: null, public_only: false },
      ],
    });
    const out = await events(() => dataMethodsCmd({ db: "kofeinya" }));
    expect(out[0]).toMatchObject({ event: "data_methods", warnings: [warning] });

    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[] = [];
    try {
      await dataMethodsCmd({ db: "kofeinya" });
      lines = log.mock.calls.flat().join("\n").split("\n");
    } finally {
      log.mockRestore();
    }
    expect(lines.join("\n")).toContain(warning);
    expect(lines.find((l) => l.includes("api.pr(x integer)"))).toContain("процедуру шлюз не вызывает");
    expect(lines.find((l) => l.includes("app.helper()"))).toContain("только из схемы api");
  });

  it("затенённая функция называет ту, что вызывает шлюз (T-20260915-6)", async () => {
    api.listDataMethods.mockResolvedValue({
      roles: {},
      tables: [],
      functions: [
        { signature: "api.pr(x integer)", kind: "function", level: "server", path: null,
          public_only: false, shadowed_by: "shop.pr" },
      ],
    });
    const out = await events(() => dataMethodsCmd({ db: "kofeinya" }));
    expect(out[0].functions[0]).toMatchObject({ shadowed_by: "shop.pr" });

    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[] = [];
    try {
      await dataMethodsCmd({ db: "kofeinya" });
      lines = log.mock.calls.flat().join("\n").split("\n");
    } finally {
      log.mockRestore();
    }
    const line = lines.find((l) => l.includes("api.pr(x integer)"));
    expect(line).toContain("шлюз зовёт shop.pr");
    expect(line).not.toContain("только из схемы api");
  });

  it("одноимённая функция помечена в описи методов", async () => {
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    api.listDataMethods.mockResolvedValue({
      roles: {},
      tables: [],
      functions: [{ signature: "api.pr(x text)", level: "server", path: "/rest/v1/rpc/pr", public_only: false, overloaded: true }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dataMethodsCmd({ db: "kofeinya" });
      expect(log.mock.calls.flat().join("\n")).toContain("одноимённая функция или процедура");
    } finally {
      log.mockRestore();
    }
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
      warnings: [],
      tables: [{ schema: "app", name: "products" }],
      functions: [{ signature: "api.menu()", level: "visitor" }],
    });
  });
});

describe("связка команд", () => {
  it("действие grant зовёт команду, а глобальный --json доезжает до неё", async () => {
    const program = new Command();
    program.option("--json");
    program.exitOverride();
    registerDataApiCommands(program.command("data"), program);
    // Терминал и режим «не JSON»: единственный источник --json — глобальный флаг.
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const refused = await capture(() => program.parseAsync(
        ["node", "layero", "--json", "data", "grant", "app.products", "--db", "kofeinya", "--get", "visitor"],
      ));
      // Флаг дошёл: вопроса не было, отказ вместо него.
      expect(refused.error).toMatchObject({ code: "confirmation_required" });
      expect(prompt.asked).toEqual([]);
      expect(api.setDataLevels).toHaveBeenCalledTimes(1);

      const applied = await capture(() => program.parseAsync(
        ["node", "layero", "--json", "data", "grant", "app.products", "--db", "kofeinya", "--get", "visitor", "--yes"],
      ));
      expect(applied.error).toBeNull();
      expect(api.setDataLevels).toHaveBeenCalledTimes(3);
      expect(api.setDataLevels.mock.calls[2]![2]).toMatchObject({
        object: "app.products", levels: { GET: "visitor" }, apply: true, expected_sql: PLAN.sql,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("--json в терминале не задаёт вопрос и требует --yes", async () => {
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const { error } = await capture(() => dataGrantCmd("app.products", { db: "kofeinya", get: "visitor", json: true }));
    expect(error).toMatchObject({ code: "confirmation_required" });
    expect(prompt.asked).toEqual([]);
    expect(api.setDataLevels).toHaveBeenCalledTimes(1);
  });

  it("bin регистрирует команды Data API", () => {
    const bin = readFileSync(new URL("../src/bin/layero.ts", import.meta.url), "utf8");
    expect(bin).toContain("registerDataApiCommands(data, program)");
  });
});

describe("включение", () => {
  it("без --db — единственная база без Data API, с секретным ключом", async () => {
    api.enableDataApi.mockResolvedValue({ slug: "draft", key: { key: "pk_live_new" }, secret_key: { key: SECRET } });
    const out = await events(() => dataEnableCmd({ withSecret: true }));
    expect(api.enableDataApi).toHaveBeenCalledWith("acme", "db-2", true);
    expect(out[0]).toMatchObject({ event: "data_api_enabled", public_key: "pk_live_new", secret_key: SECRET, reapplied: false });
  });

  it("у базы с включённым Data API — отказ без вызова включения", async () => {
    const err = await dataEnableCmd({ db: "kofeinya" }).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "data_api_already_enabled" });
    expect(String(err.message)).toContain("схему public");
    expect(String(err.next_action)).toContain("layero data keys list --db kofeinya");
    expect(String(err.next_action)).toContain("layero data enable --db kofeinya --repair");
    expect(String(err.next_action)).not.toContain("keys issue");
    expect(api.enableDataApi).not.toHaveBeenCalled();
    // С --with-secret подсказка ведёт на выпуск секретного ключа.
    const secret = await dataEnableCmd({ db: "kofeinya", withSecret: true }).then(() => null, (e) => e);
    expect(secret).toMatchObject({ code: "data_api_already_enabled" });
    expect(String(secret.next_action)).toContain("layero data keys issue --db kofeinya --kind secret");
    expect(api.enableDataApi).not.toHaveBeenCalled();
  });

  it("--repair: только с --db, только у включённой базы и только с подтверждением", async () => {
    await expect(dataEnableCmd({ repair: true, yes: true })).rejects.toMatchObject({ code: "database_unknown" });
    await expect(dataEnableCmd({ db: "draft", repair: true, yes: true })).rejects.toMatchObject({ code: "data_api_disabled" });
    const err = await dataEnableCmd({ db: "kofeinya", repair: true }).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "confirmation_required" });
    expect(String(err.message)).toContain("схему public");
    expect(String(err.next_action)).toContain("layero data enable --db kofeinya --repair --yes");
    expect(api.enableDataApi).not.toHaveBeenCalled();

    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dataEnableCmd({ db: "kofeinya", repair: true });
    } finally {
      log.mockRestore();
    }
    expect(prompt.asked[0]).toContain("схему public");
    expect(api.enableDataApi).not.toHaveBeenCalled();
  });

  it("--repair --yes переприменяет и помечает событие", async () => {
    api.enableDataApi.mockResolvedValue({ slug: "kofeinya", key: null, secret_key: null });
    const out = await events(() => dataEnableCmd({ db: "kofeinya", repair: true, yes: true }));
    expect(api.enableDataApi).toHaveBeenCalledWith("acme", "db-1", false);
    expect(out[0]).toMatchObject({ event: "data_api_enabled", reapplied: true });
  });

  it("текст после переприменения — о случившемся и без «всё закрыто»", async () => {
    api.enableDataApi.mockResolvedValue({ slug: "kofeinya", key: null, secret_key: null });
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let repaired = "";
    let enabled = "";
    try {
      await dataEnableCmd({ db: "kofeinya", repair: true, yes: true });
      repaired = log.mock.calls.flat().join("\n");
      log.mockClear();
      api.enableDataApi.mockResolvedValue({ slug: "draft", key: { key: "pk_live_new" }, secret_key: null });
      await dataEnableCmd({ db: "draft" });
      enabled = log.mock.calls.flat().join("\n");
    } finally {
      log.mockRestore();
    }
    expect(repaired).toContain("переприменён");
    expect(repaired).toContain("лишились прав на схему public (USAGE)");
    expect(repaired).toContain("схемах api и app сохранились");
    expect(repaired).not.toContain("потеряют");
    expect(repaired).not.toContain("Все методы закрыты");
    expect(enabled).toContain("Все методы закрыты");
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
    expect(flags(["enable"])).toEqual(expect.arrayContaining(["--with-secret", "--repair", "--yes"]));
    expect(find(["methods"])).toBeDefined();
  });
});
