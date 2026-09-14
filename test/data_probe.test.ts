// `layero data probe` (T-20260911-9): проба метода Data API через шлюз.
//
// Главное, что проверяется:
//  · тревога «изменения НЕ откатились» — ровно когда откат ждали, ответ 200–399
//    и шлюз его не подтвердил; у отказа 401/403 и у /whoami её нет;
//  · отказ шлюза — результат пробы: событие и код 0, а не ошибка CLI;
//  · «N из M» — только со счётом владельца; «3 из 3» по счёту роли не рисуется;
//  · всё, что отклоняется локально, не доходит до сети.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  listDatabases: vi.fn(),
  probeDataApi: vi.fn(),
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

import { ApiError } from "../src/api.js";
import { dataProbeCmd } from "../src/commands/data-probe.js";
import { registerDataApiCommands } from "../src/commands/data-api.js";
import { setMode } from "../src/agent.js";

const DB = { id: "db-1", name: "Кофейня", name_slug: "kofeinya", api_enabled: true };
const USER = "7c8aa53d-3b61-40a7-bd2e-695058acd72f";

const OK = {
  status: 200,
  elapsed_ms: 12,
  headers: { "content-range": "0-2/3" },
  body: [{ sku: "A" }, { sku: "B" }, { sku: "C" }],
  body_truncated: false,
  caller: "visitor",
  rows: 3,
  total: 3,
  owner_total: 10,
  rolled_back: true,
  rollback_expected: true,
};

/** События stdout и исход команды: ошибка не прячет то, что уже ушло событием. */
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

/** Человеческий вывод команды и её исход. */
async function human(run: () => Promise<unknown>): Promise<{ text: string; error: any }> {
  setMode({ agent: false, json: false, interactive: true, reason: "test" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let error: any = null;
  let text = "";
  try {
    await run();
  } catch (e) {
    error = e;
  } finally {
    // eslint-disable-next-line no-control-regex
    text = log.mock.calls.flat().join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    log.mockRestore();
  }
  return { text, error };
}

async function refused(run: () => Promise<unknown>): Promise<any> {
  const { error } = await capture(run);
  expect(error).toBeTruthy();
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  api.listOrganizations.mockResolvedValue([{ slug: "acme", kind: "personal" }]);
  api.listDatabases.mockResolvedValue([DB]);
  api.probeDataApi.mockResolvedValue(OK);
});

describe("запрос пробы", () => {
  it("метод, путь, параметры, роль и схема уходят в ручку", async () => {
    await capture(() => dataProbeCmd("get", "/rest/v1/products", {
      db: "kofeinya", query: ["select=sku", "limit=1", "price=gt.100"], schema: "app",
    }));
    expect(api.probeDataApi).toHaveBeenCalledWith("acme", "db-1", {
      method: "GET",
      path: "/rest/v1/products",
      query: { select: "sku", limit: "1", price: "gt.100" },
      body: null,
      as: "visitor",
      user_id: null,
      schema: "app",
    });
  });

  it("значение параметра со знаком «=» не режется", async () => {
    await capture(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", query: ["or=(a.eq.1,b.eq.2)", "x=a=b"] }));
    expect(api.probeDataApi.mock.calls[0]![2].query).toEqual({ or: "(a.eq.1,b.eq.2)", x: "a=b" });
  });

  it("параметр без «=» и повтор имени — отказ до запроса", async () => {
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", query: ["select"] })))
      .toMatchObject({ code: "data_probe_query" });
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", query: ["id=eq.1", "id=eq.2"] })))
      .toMatchObject({ code: "data_probe_query" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("--body разбирается как JSON и уходит объектом", async () => {
    await capture(() => dataProbeCmd("POST", "/rest/v1/cart", {
      db: "kofeinya", as: "user", user: USER, body: '{"product_id":6,"qty":1}',
    }));
    expect(api.probeDataApi.mock.calls[0]![2]).toEqual({
      method: "POST", path: "/rest/v1/cart", query: {}, body: { product_id: 6, qty: 1 },
      as: "user", user_id: USER, schema: null,
    });
  });

  it("--body-file читает файл", async () => {
    const dir = await mkdtemp(join(tmpdir(), "layero-probe-"));
    const file = join(dir, "order.json");
    await writeFile(file, '[{"qty": 2}]');
    await capture(() => dataProbeCmd("POST", "/rest/v1/rpc/order_create", { db: "kofeinya", bodyFile: file, as: "server" }));
    expect(api.probeDataApi.mock.calls[0]![2]).toMatchObject({ body: [{ qty: 2 }], as: "server", user_id: null });
  });

  it.each([
    ["тело не JSON", "POST", { body: "{qty:1}" }],
    ["тело — не объект", "POST", { body: "42" }],
    ["и --body, и --body-file", "POST", { body: "{}", bodyFile: "x.json" }],
    ["нет файла тела", "POST", { bodyFile: "/нет/такого/файла.json" }],
    ["тело у GET", "GET", { body: '{"qty":1}' }],
    ["тело у DELETE", "DELETE", { body: '{"qty":1}' }],
  ])("%s — data_probe_body до запроса", async (_name, method, extra) => {
    const err = await refused(() => dataProbeCmd(method, "/rest/v1/cart", { db: "kofeinya", ...extra }));
    expect(err).toMatchObject({ code: "data_probe_body" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("--as user без --user — отказ до запроса", async () => {
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", as: "user" }));
    expect(err).toMatchObject({ code: "data_probe_user_required" });
    expect(String(err.next_action)).toContain("--user");
    expect(api.listDatabases).not.toHaveBeenCalled();
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("--user без --as user и неизвестная роль — отказ", async () => {
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", user: USER })))
      .toMatchObject({ code: "data_probe_as" });
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", as: "admin" })))
      .toMatchObject({ code: "data_probe_as" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("путь с «?» — отказ с готовой командой на --query", async () => {
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/products?select=sku&limit=1", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_path" });
    expect(String(err.next_action)).toBe(
      "layero data probe GET /rest/v1/products --query select=sku --query limit=1 --db kofeinya",
    );
    expect(api.listDatabases).not.toHaveBeenCalled();
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH", "DELETE"])("whoami %s — отказ до запроса", async (method) => {
    const err = await refused(() => dataProbeCmd(method, "/whoami", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_method" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("неизвестный метод — отказ до запроса", async () => {
    expect(await refused(() => dataProbeCmd("PUT", "/rest/v1/cart", { db: "kofeinya" })))
      .toMatchObject({ code: "data_probe_method" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("отказ платформы до шлюза — data_probe_rejected с её текстом", async () => {
    api.probeDataApi.mockRejectedValue(new ApiError("409", 409, JSON.stringify({ detail: "у базы не включён вход — вошедших пользователей нет" })));
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", as: "user", user: USER }));
    expect(err).toMatchObject({ code: "data_probe_rejected" });
    expect(String(err.message)).toContain("у базы не включён вход");
    expect(String(err.next_action)).toContain("layero data methods --db kofeinya");
  });

  it("422 разбора — поле и причина в тексте", async () => {
    api.probeDataApi.mockRejectedValue(new ApiError("422", 422, JSON.stringify({
      detail: [{ loc: ["body", "path"], msg: "String should have at most 200 characters" }],
    })));
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_rejected" });
    expect(String(err.message)).toContain("path: String should have at most 200 characters");
  });

  it.each([401, 402, 500])("ответ ручки %i не переписывается — его разбирает общий обработчик", async (status) => {
    const original = new ApiError(String(status), status, JSON.stringify({ detail: "что-то" }));
    api.probeDataApi.mockRejectedValue(original);
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }))).toBe(original);
  });
});

describe("тревога об откате", () => {
  it.each([
    [200, true],
    [201, true],
    [204, true],
    [399, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [500, false],
  ])("ответ %i без подтверждения отката — тревога: %s", async (status, alarm) => {
    api.probeDataApi.mockResolvedValue({ ...OK, status, rolled_back: false, rollback_expected: true, caller: null });
    const { events, error } = await capture(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(events[0]).toMatchObject({ event: "data_probe", status, not_rolled_back: alarm });
    if (alarm) expect(error).toMatchObject({ code: "data_probe_not_rolled_back" });
    else expect(error).toBeNull();
  });

  it("человеку — 🚨 и «НЕ откатились», и ненулевой исход", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 201, rows: 1, total: null, owner_total: null, rolled_back: false });
    const { text, error } = await human(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(text).toContain("🚨 изменения НЕ откатились");
    expect(text).not.toContain("изменения откатились");
    expect(error).toMatchObject({ code: "data_probe_not_rolled_back" });
    expect(String(error.message)).toContain("Кофейня");
  });

  it("откат подтверждён — «изменения откатились», тревоги нет", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 201, rows: 1, total: null, owner_total: null, rolled_back: true });
    const { text, error } = await human(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(error).toBeNull();
    expect(text).toContain("изменения откатились");
    expect(text).not.toContain("НЕ откатились");
  });

  it("rolled_back не true, а строка — тоже не подтверждение", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 201, rolled_back: "true" as unknown as boolean });
    const { error } = await capture(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(error).toMatchObject({ code: "data_probe_not_rolled_back" });
  });

  it.each([
    [401, "bad_key"],
    [403, "no_table_grant"],
  ])("отказ шлюза %i — результат пробы: без слов об откате, «никто», код 0", async (status, code) => {
    api.probeDataApi.mockResolvedValue({
      ...OK, status, rows: null, total: null, owner_total: null, caller: null, rolled_back: false,
      body: { error: code },
    });
    const { text, error } = await human(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(error).toBeNull();
    expect(text).not.toContain("откат");
    expect(text).toContain("кто пришёл: никто — ключ или токен не приняты");
    expect(text).toContain(code);
  });

  it("whoami — откат не ожидался, и о нём ни слова", async () => {
    api.probeDataApi.mockResolvedValue({
      ...OK, rows: null, total: null, owner_total: null, rolled_back: false, rollback_expected: false,
      body: { caller: "visitor" },
    });
    const { text, error } = await human(() => dataProbeCmd("GET", "/whoami", { db: "kofeinya" }));
    expect(error).toBeNull();
    expect(text).not.toContain("откат");
    expect(text).toContain("кто пришёл: посетитель");
  });

  it.each([404, 500])("ответ %i без вызывающего — строки «кто пришёл» нет", async (status) => {
    api.probeDataApi.mockResolvedValue({
      ...OK, status, rows: null, total: null, owner_total: null, caller: null, rolled_back: false,
      body: { error: "unknown_database" },
    });
    const { text } = await human(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }));
    expect(text).not.toContain("кто пришёл");
  });
});

describe("вывод", () => {
  it("«N из M» — знаменатель владельца", async () => {
    const { text } = await human(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya" }));
    expect(text).toContain("3 из 10");
    expect(text).toContain("кто пришёл: посетитель");
    expect(text).toContain("12 мс");
    expect(text).toContain('"sku": "A"');
  });

  it("владелец не посчитал — «N из N» по счёту роли не рисуем", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, owner_total: null, total: 3 });
    const { text } = await human(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya" }));
    expect(text).not.toContain("3 из 3");
    expect(text).toContain("3 строки, сколько всего в таблице — не посчитали");
  });

  it("у функции без знаменателя — просто число строк", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, rows: 1, total: 5, owner_total: null });
    const { text } = await human(() => dataProbeCmd("POST", "/rest/v1/rpc/menu", { db: "kofeinya", body: "{}" }));
    expect(text).toContain("1 строка");
    expect(text).not.toContain("из 5");
    expect(text).not.toContain("не посчитали");
  });

  it("обрезанное тело — сказано, что показано начало", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, body: '[{"sku": "A"', body_truncated: true });
    const { text } = await human(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya" }));
    expect(text).toContain("ответ длиннее 64 КБ, показано начало");
    expect(text).toContain('[{"sku": "A"');
  });

  it("полное тело — ни слова об обрезке", async () => {
    const { text } = await human(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya" }));
    expect(text).not.toContain("64 КБ");
  });

  it("JSON-событие: поля ответа, запрос без тела, и больше ничего", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 403, caller: null, rows: null, rolled_back: false,
      body: { error: "no_table_grant" }, owner_total: null, secret_extra: "не должно уехать" });
    const { events, error } = await capture(() => dataProbeCmd("POST", "/rest/v1/cart", {
      db: "kofeinya", as: "user", user: USER, body: '{"qty":1}', query: ["select=id"],
    }));
    expect(error).toBeNull();
    expect(events).toHaveLength(1);
    const { ts, ...event } = events[0];
    expect(typeof ts).toBe("string");
    expect(event).toEqual({
      event: "data_probe",
      org: "acme",
      database: "kofeinya",
      request: { method: "POST", path: "/rest/v1/cart", as: "user", user_id: USER, query: { select: "id" }, schema: null },
      status: 403,
      elapsed_ms: 12,
      caller: null,
      rows: null,
      total: 3,
      owner_total: null,
      rollback_expected: true,
      rolled_back: false,
      not_rolled_back: false,
      body_truncated: false,
      headers: { "content-range": "0-2/3" },
      body: { error: "no_table_grant" },
    });
  });

  it("в JSON-режиме человеческого текста нет", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await capture(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya" }));
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("регистрация", () => {
  it("флаги объявлены, --query повторяется, глобальный --json доезжает", async () => {
    const program = new Command();
    program.option("--json");
    program.exitOverride();
    const data = program.command("data");
    registerDataApiCommands(data, program);
    const probe = data.commands.find((c) => c.name() === "probe");
    expect((probe?.options ?? []).map((o) => o.long)).toEqual(expect.arrayContaining([
      "--as", "--user", "--query", "--body", "--body-file", "--schema", "--db", "--org",
    ]));

    // Терминал и режим «не JSON»: единственный источник --json — глобальный флаг.
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let printed = -1;
    try {
      await program.parseAsync([
        "node", "layero", "--json", "data", "probe", "GET", "/rest/v1/products",
        "--db", "kofeinya", "--query", "select=sku", "--query", "limit=1",
      ]);
      printed = log.mock.calls.length;
    } finally {
      log.mockRestore();
    }
    expect(api.probeDataApi.mock.calls[0]![2]).toMatchObject({ query: { select: "sku", limit: "1" } });
    // Флаг дошёл: человеческого вывода нет.
    expect(printed).toBe(0);
  });
});

describe("клиент", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST на /api/probe-http с телом как есть", async () => {
    const { ApiClient: RealClient } = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
    const calls: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(OK), { status: 200 });
    }));
    const client = new RealClient({ apiUrl: "https://api.test/", token: "t" } as any);
    const input = {
      method: "POST", path: "/rest/v1/cart", query: {}, body: { qty: 1 },
      as: "user" as const, user_id: USER, schema: null,
    };
    expect(await client.probeDataApi("acme", "db-1", input)).toEqual(OK);
    expect(calls).toEqual([{
      method: "POST",
      url: "https://api.test/organizations/acme/databases/db-1/api/probe-http",
      body: input,
    }]);
  });
});
