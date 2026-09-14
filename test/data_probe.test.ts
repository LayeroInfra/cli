// `layero data probe` (T-20260911-9): проба метода Data API через шлюз.
//
// Главное, что проверяется:
//  · тревога «изменения НЕ откатились» — ровно когда откат ждали, ответ 200–399
//    и шлюз его не подтвердил; у отказа 401/403 и у /whoami её нет;
//  · код выхода по одному правилу: откат → --expect → 5xx → --expect → 0;
//  · «N из M» — только со счётом владельца; «3 из 3» по счёту роли не рисуется;
//  · всё, что отклоняется локально, не доходит до сети, а подсказка повтора
//    несёт все флаги, которые передал человек.
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

async function tempFile(name: string, content: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "layero-probe-")), name);
  await writeFile(file, content);
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  api.listOrganizations.mockResolvedValue([{ slug: "acme", kind: "personal" }]);
  api.listDatabases.mockResolvedValue([DB]);
  api.probeDataApi.mockResolvedValue(OK);
});

describe("запрос пробы", () => {
  it("метод, путь, параметры, роль и схема уходят в ручку; схема — в нижнем регистре", async () => {
    await capture(() => dataProbeCmd("get", "/rest/v1/products", {
      db: "kofeinya", query: ["select=sku", "limit=1", "price=gt.100"], schema: "APP",
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

  it.each([
    ["без «=»", ["select"]],
    ["пустое имя", ["=x"]],
    ["повтор имени", ["id=eq.1", "id=eq.2"]],
  ])("параметр: %s — отказ до запроса", async (_name, query) => {
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", query })))
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

  it("--body-file читает файл, BOM в начале срезается", async () => {
    const file = await tempFile("order.json", '[{"qty": 2}]');
    await capture(() => dataProbeCmd("POST", "/rest/v1/rpc/order_create", { db: "kofeinya", bodyFile: file, as: "server" }));
    expect(api.probeDataApi.mock.calls[0]![2]).toMatchObject({ body: [{ qty: 2 }], as: "server", user_id: null });

    const bom = await tempFile("bom.json", '\uFEFF{"qty":1}');
    const { error } = await capture(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", bodyFile: bom }));
    expect(error).toBeNull();
    expect(api.probeDataApi.mock.calls[1]![2]).toMatchObject({ body: { qty: 1 } });
  });

  it.each([
    ["тело не JSON", { body: "{qty:1}" }],
    ["тело — не объект", { body: "42" }],
    ["тело — null", { body: "null" }],
    ["нет файла тела", { bodyFile: "/нет/такого/файла.json" }],
  ])("%s — data_probe_body до запроса", async (_name, extra) => {
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", ...extra }));
    expect(err).toMatchObject({ code: "data_probe_body" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("и --body, и --body-file — отказ, даже если файл читается", async () => {
    const file = await tempFile("body.json", '{"qty":1}');
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: '{"qty":2}', bodyFile: file }));
    expect(err).toMatchObject({ code: "data_probe_body" });
    expect(String(err.message)).toContain("и --body, и --body-file");
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each(["GET", "DELETE"])("тело у %s — отказ по методу, а не по файлу", async (method) => {
    for (const extra of [{ body: '{"qty":1}' }, { bodyFile: "/нет/такого/файла.json" }]) {
      const err = await refused(() => dataProbeCmd(method, "/rest/v1/cart", { db: "kofeinya", ...extra }));
      expect(err).toMatchObject({ code: "data_probe_body" });
      expect(String(err.message)).toContain("только у POST и PATCH");
      expect(String(err.next_action)).toBe(`layero data probe ${method} /rest/v1/cart --db kofeinya`);
    }
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each([
    ['{"id":9007199254740993}', "9007199254740993", "9007199254740992"],
    ['{"price":12345678901234567.89}', "12345678901234567.89", "12345678901234568"],
    ['{"id":1152921504606846976}', "1152921504606846976", "1152921504606847000"],
    ['[1, {"a":[1e400]}]', "1e400", "в запрос ушло бы null"],
    ['{"a":1e-400}', "1e-400", "в запрос ушло бы 0"],
  ])("число %s теряет точность — отказ до запроса", async (body, text, sent) => {
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body }));
    expect(err).toMatchObject({ code: "data_probe_body" });
    expect(String(err.message)).toContain(`число ${text}`);
    expect(String(err.message)).toContain(sent);
    expect(String(err.next_action)).toContain(`"${text}"`);
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("точные числа и цифры внутри строк проходят", async () => {
    const body = '{"a":1.0,"b":1e3,"c":0.1,"d":-0,"e":"9007199254740993","f":9007199254740991,"g":-12.50,"h":"q\\" 9007199254740993"}';
    const { error } = await capture(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body }));
    expect(error).toBeNull();
    expect(api.probeDataApi.mock.calls[0]![2].body).toEqual(JSON.parse(body));
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

  it("--user '' при посетителе — тоже отказ: флаг передан, значит, ждали пользователя", async () => {
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", user: "" })))
      .toMatchObject({ code: "data_probe_as" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("--user не UUID — отказ до запроса; UUID в любом регистре и без дефисов проходит", async () => {
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", as: "user", user: "7c8aa53d" }));
    expect(err).toMatchObject({ code: "data_probe_user_invalid" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
    for (const user of [USER.toUpperCase(), USER.replace(/-/g, "")]) {
      const { error } = await capture(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya", as: "user", user }));
      expect(error).toBeNull();
    }
    expect(api.probeDataApi).toHaveBeenCalledTimes(2);
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

  it("подсказка при «?» несёт все переданные флаги", async () => {
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart?select=id", {
      db: "kofeinya", as: "user", user: USER, query: ["limit=1"], schema: "app", org: "acme", expect: "2xx",
    }));
    expect(String(err.next_action)).toBe(
      `layero data probe GET /rest/v1/cart --query select=id --query limit=1 --as user --user ${USER}` +
        " --schema app --expect 2xx --db kofeinya --org acme",
    );
  });

  it("подсказка экранирует кириллицу, пробелы и тело для shell", async () => {
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/товары?название=eq.Кофе латте&q=a+b", {
      db: "kofeinya", body: '{"qty":1}',
    }));
    expect(String(err.next_action)).toBe(
      "layero data probe POST '/rest/v1/товары' --query 'название=eq.Кофе латте' --query 'q=a b'" +
        ` --body '{"qty":1}' --db kofeinya`,
    );
  });

  it("управляющие символы в подсказке — записью $'…', «!» там же — \\x21", async () => {
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/items?x=a%09b", {
      db: "kofeinya", query: ["n=it's\n!\x01"],
    }));
    expect(String(err.next_action)).toBe(
      "layero data probe GET /rest/v1/items --query $'x=a\\tb' --query $'n=it\\'s\\n\\x21\\x01' --db kofeinya",
    );
  });

  it("подсказка несёт --body-file", async () => {
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/cart?x=1", { db: "kofeinya", bodyFile: "order it's.json" }));
    expect(String(err.next_action)).toBe(
      "layero data probe POST /rest/v1/cart --query x=1 --body-file 'order it'\\''s.json' --db kofeinya",
    );
  });

  it.each([
    ["/rest/v1/items?select=id", ["select=title"], "и в пути после «?», и флагом --query"],
    ["/rest/v1/items?a=1&a=2", [], "указан дважды"],
    ["/rest/v1/items?=x", [], "не пара имя=значение"],
  ])("«?» в %s с параметрами, на которых упал бы повтор, — отказ сразу", async (path, query, text) => {
    const err = await refused(() => dataProbeCmd("GET", path, { db: "kofeinya", query }));
    expect(err).toMatchObject({ code: "data_probe_query" });
    expect(String(err.message)).toContain(text);
    expect(api.listDatabases).not.toHaveBeenCalled();
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each([
    ["/rest/v1/rpc/", "нет имени функции"],
    ["/rest/v1/rpc//", "нет имени функции"],
    ["/rest/v1/", "нет имени таблицы"],
  ])("путь %s без имени — отказ, а не проба таблицы", async (path, text) => {
    const err = await refused(() => dataProbeCmd("POST", path, { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_path" });
    expect(String(err.message)).toContain(text);
    expect(String(err.next_action)).toBe("имена таблиц и функций — layero data methods --db kofeinya");
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each([
    ["/whoami/", "/whoami"],
    ["/rest/v1/cart/", "/rest/v1/cart"],
  ])("путь %s с косой чертой в конце — отказ, в подсказке без неё", async (path, fixed) => {
    const err = await refused(() => dataProbeCmd("GET", path, { db: "kofeinya", as: "server" }));
    expect(err).toMatchObject({ code: "data_probe_path" });
    expect(String(err.next_action)).toBe(`layero data probe GET ${fixed} --as server --db kofeinya`);
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH", "DELETE"])("whoami %s — отказ до запроса", async (method) => {
    const err = await refused(() => dataProbeCmd(method, "/whoami", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_method" });
    expect(String(err.next_action)).toBe("layero data probe GET /whoami --db kofeinya");
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("подсказка для whoami не несёт тело: у GET его не бывает", async () => {
    const err = await refused(() => dataProbeCmd("POST", "/whoami", { db: "kofeinya", as: "server", body: '{"qty":1}' }));
    expect(err).toMatchObject({ code: "data_probe_method" });
    expect(String(err.next_action)).toBe("layero data probe GET /whoami --as server --db kofeinya");
  });

  it.each(["PATCH", "DELETE"])("функция методом %s — отказ до запроса", async (method) => {
    const err = await refused(() => dataProbeCmd(method, "/rest/v1/rpc/menu", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_method" });
    expect(String(err.next_action)).toBe("layero data probe POST /rest/v1/rpc/menu --db kofeinya");
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("функция GET и POST проходят", async () => {
    await capture(() => dataProbeCmd("GET", "/rest/v1/rpc/menu", { db: "kofeinya" }));
    await capture(() => dataProbeCmd("POST", "/rest/v1/rpc/menu", { db: "kofeinya", body: "{}" }));
    expect(api.probeDataApi).toHaveBeenCalledTimes(2);
  });

  it("неизвестный метод — отказ до запроса", async () => {
    expect(await refused(() => dataProbeCmd("PUT", "/rest/v1/cart", { db: "kofeinya" })))
      .toMatchObject({ code: "data_probe_method" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it("--schema не из api, public, app — отказ до запроса", async () => {
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", schema: "hidden" }));
    expect(err).toMatchObject({ code: "data_probe_schema" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each(["api", "API", " Api "])("--schema %j у функции законна: не уходит, в эхе null", async (schema) => {
    const { events, error } = await capture(() => dataProbeCmd("POST", "/rest/v1/rpc/menu", { db: "kofeinya", schema, body: "{}" }));
    expect(error).toBeNull();
    expect(api.probeDataApi.mock.calls[0]![2].schema).toBeNull();
    expect(events[0].request.schema).toBeNull();
  });

  it("у функции другая схема — отказ, в подсказке без схемы", async () => {
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/rpc/menu", { db: "kofeinya", schema: "App", body: "{}" }));
    expect(err).toMatchObject({ code: "data_probe_schema" });
    expect(String(err.message)).toContain("у функций схема — только api");
    expect(String(err.message)).toContain("а не из App");
    expect(String(err.next_action)).toBe("layero data probe POST /rest/v1/rpc/menu --body '{}' --db kofeinya");
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });

  it.each(["app", "hidden"])("у /whoami --schema %s молча отбрасывается", async (schema) => {
    const { events, error } = await capture(() => dataProbeCmd("GET", "/whoami", { db: "kofeinya", schema }));
    expect(error).toBeNull();
    expect(api.probeDataApi.mock.calls[0]![2].schema).toBeNull();
    expect(events[0].request.schema).toBeNull();
  });

  it.each(["", "   "])("пустая --schema %j — как без флага и в подсказку не попадает", async (schema) => {
    const { error } = await capture(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", schema }));
    expect(error).toBeNull();
    expect(api.probeDataApi.mock.calls[0]![2].schema).toBeNull();
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/products/", { db: "kofeinya", schema }));
    expect(String(err.next_action)).toBe("layero data probe GET /rest/v1/products --db kofeinya");
  });

  it.each(["abc", "600", "2x", "20", ",", "2xx,oops"])("--expect %s — отказ до запроса", async (value) => {
    expect(await refused(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", expect: value })))
      .toMatchObject({ code: "data_probe_expect" });
    expect(api.probeDataApi).not.toHaveBeenCalled();
  });
});

describe("отказ ручки до шлюза", () => {
  const reject = (status: number, detail: unknown) =>
    api.probeDataApi.mockRejectedValue(new ApiError(String(status), status, JSON.stringify({ detail })));

  it.each([
    ["у базы не включён вход — вошедших пользователей нет", "--as visitor"],
    ["адрес пробы: /rest/v1/<таблица>, /rest/v1/rpc/<функция> или /whoami", "layero data methods --db kofeinya"],
    ["адрес пробы не собрался — проверьте имя таблицы или функции", "проверьте имя таблицы или функции"],
    ["у пробы больше 50 параметров", "не больше 50 флагов --query"],
    ["тело пробы больше 64 КБ", "до 64 КБ"],
    ["база не найдена или не активна", "layero db list"],
    ["роли Data API не заведены — включите API заново", "раздел «API»"],
    ["шлюз данных ещё не умеет пробу с откатом — запрос не выполнен, данные не тронуты", "данные не тронуты"],
    ["что-то новое на сервере", "layero data methods --db kofeinya"],
  ])("«%s» — data_probe_rejected с подсказкой по случаю", async (detail, hint) => {
    reject(409, detail);
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_rejected" });
    expect(String(err.message)).toContain(detail);
    expect(String(err.next_action)).toContain(hint);
  });

  it.each(["база не найдена", "not found"])("404 ручки «%s» — подсказка layero db list", async (detail) => {
    reject(404, detail);
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_rejected" });
    expect(String(err.next_action)).toBe("список баз и их состояние: layero db list");
  });

  it("шлюз данных не ответил — data_probe_gateway_failed, а не отказ", async () => {
    reject(409, "шлюз данных не ответил — попробуйте ещё раз");
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_gateway_failed" });
    expect(String(err.next_action)).toContain("повторите пробу позже");
  });

  it("403 ручки — подсказка про права администратора", async () => {
    reject(403, "недостаточно прав");
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/cart", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_rejected" });
    expect(String(err.next_action)).toContain("администратору");
  });

  it("422 разбора — поле и причина в тексте", async () => {
    reject(422, [{ loc: ["body", "path"], msg: "String should have at most 200 characters" }]);
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

describe("код выхода", () => {
  it.each([
    [200, true, "data_probe_not_rolled_back"],
    [201, true, "data_probe_not_rolled_back"],
    [204, true, "data_probe_not_rolled_back"],
    [399, true, "data_probe_not_rolled_back"],
    [400, false, null],
    [401, false, null],
    [403, false, null],
    [404, false, null],
    [500, false, "data_probe_gateway_failed"],
    [502, false, "data_probe_gateway_failed"],
    [503, false, "data_probe_gateway_failed"],
  ])("ответ %i без подтверждения отката: тревога %s, ошибка %s", async (status, alarm, code) => {
    api.probeDataApi.mockResolvedValue({ ...OK, status, rolled_back: false, rollback_expected: true, caller: null });
    const { events, error } = await capture(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(events[0]).toMatchObject({ event: "data_probe", status, not_rolled_back: alarm });
    if (code) expect(error).toMatchObject({ code });
    else expect(error).toBeNull();
  });

  it("5xx — в тексте код ошибки шлюза", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 503, rolled_back: false, body: { error: "too_busy" } });
    const err = await refused(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya" }));
    expect(err).toMatchObject({ code: "data_probe_gateway_failed" });
    expect(String(err.message)).toContain("503 (too_busy)");
  });

  it.each([
    [403, "2xx", "data_probe_unexpected_status"],
    [200, "403", "data_probe_unexpected_status"],
    [403, "401,403", null],
    [403, "4xx", null],
    [403, " 401 , 403 ", null],
    [200, "2XX", null],
    [503, "503", null],
    [503, "5xx", null],
    [503, "2xx", "data_probe_gateway_failed"],
  ])("ответ %i при --expect %s — ошибка %s", async (status, expectFlag, code) => {
    api.probeDataApi.mockResolvedValue({ ...OK, status, rolled_back: status < 400, caller: null });
    const { events, error } = await capture(() => dataProbeCmd("GET", "/rest/v1/products", { db: "kofeinya", expect: expectFlag }));
    expect(events[0]).toMatchObject({ event: "data_probe", status });
    if (code) expect(error).toMatchObject({ code });
    else expect(error).toBeNull();
  });

  it("неподтверждённый откат — ошибка, даже если статус совпал с --expect", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 201, rolled_back: false });
    const err = await refused(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}", expect: "201" }));
    expect(err).toMatchObject({ code: "data_probe_not_rolled_back" });
  });

  it("несовпавший --expect без --json: ненулевой исход и статус в тексте", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 403, rolled_back: false, caller: null, body: { error: "no_table_grant" } });
    const { text, error } = await human(() => dataProbeCmd("GET", "/rest/v1/orders", { db: "kofeinya", expect: "2xx" }));
    expect(text).toContain("Ответ 403");
    expect(error).toMatchObject({ code: "data_probe_unexpected_status" });
    expect(String(error.message)).toContain("шлюз ответил 403, а ожидали 2xx");
  });
});

describe("откат в выводе", () => {
  it("человеку — 🚨 и «НЕ откатились», и ненулевой исход", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 201, rows: 1, total: null, owner_total: null, rolled_back: false });
    const { text, error } = await human(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(text).toContain("🚨 изменения НЕ откатились");
    expect(text).not.toContain("изменения откатились");
    expect(text).not.toContain("Не откатываются");
    expect(error).toMatchObject({ code: "data_probe_not_rolled_back" });
    expect(String(error.message)).toContain("Кофейня");
  });

  it("откат подтверждён — «изменения откатились» и что откат не возвращает", async () => {
    api.probeDataApi.mockResolvedValue({ ...OK, status: 201, rows: 1, total: null, owner_total: null, rolled_back: true });
    const { text, error } = await human(() => dataProbeCmd("POST", "/rest/v1/cart", { db: "kofeinya", body: "{}" }));
    expect(error).toBeNull();
    expect(text).toContain("изменения откатились");
    expect(text).not.toContain("НЕ откатились");
    expect(text).toContain("Не откатываются: номера последовательностей, внешние вызовы из базы, сессионные блокировки");
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
    expect(text.toLowerCase()).not.toContain("откат");
    expect(text).toContain("кто пришёл: никто — ключ или токен не приняты");
    expect(text).toContain(code);
  });

  it.each([false, true])("whoami — откат не ожидался, и о нём ни слова (rolled_back: %s)", async (rolledBack) => {
    api.probeDataApi.mockResolvedValue({
      ...OK, rows: null, total: null, owner_total: null, rolled_back: rolledBack, rollback_expected: false,
      body: { caller: "visitor" },
    });
    const { text, error } = await human(() => dataProbeCmd("GET", "/whoami", { db: "kofeinya" }));
    expect(error).toBeNull();
    expect(text.toLowerCase()).not.toContain("откат");
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

  it.each([
    ["POST", { body: "{}" }, 1, "1 строка"],
    ["GET", {}, 2, "2 строки"],
  ])("у функции %s без знаменателя — просто число строк", async (method, extra, rows, words) => {
    api.probeDataApi.mockResolvedValue({ ...OK, rows, total: 5, owner_total: null });
    const { text } = await human(() => dataProbeCmd(method, "/rest/v1/rpc/menu", { db: "kofeinya", ...extra }));
    expect(text).toContain(words);
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

  it("JSON-событие: поля ответа, запрос без тела, заголовки по списку, и больше ничего", async () => {
    api.probeDataApi.mockResolvedValue({
      ...OK, status: 403, caller: null, rows: null, rolled_back: false, owner_total: null,
      body: { error: "no_table_grant" }, secret_extra: "не должно уехать",
      headers: {
        "content-type": "application/json", "Content-Range": "*/0", "x-layero-caller": "visitor",
        "x-layero-key": "pk_live_ab12", "x-layero-user": USER, "x-layero-rolled-back": "false",
        authorization: "Bearer eyJSECRET", "set-cookie": "s=1",
      },
    });
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
      headers: {
        "content-type": "application/json", "Content-Range": "*/0", "x-layero-caller": "visitor",
        "x-layero-key": "pk_live_ab12", "x-layero-user": USER, "x-layero-rolled-back": "false",
      },
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
      "--as", "--user", "--query", "--body", "--body-file", "--schema", "--expect", "--db", "--org",
    ]));

    // Терминал и режим «не JSON»: единственный источник --json — глобальный флаг.
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let printed = -1;
    try {
      await program.parseAsync([
        "node", "layero", "--json", "data", "probe", "GET", "/rest/v1/products",
        "--db", "kofeinya", "--query", "select=sku", "--query", "limit=1", "--expect", "200",
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
