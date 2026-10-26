// `db create` в JSON ждёт готовности базы (T-20261025-33, п. 1): раньше событие
// уходило, пока база `creating`, и следующая команда агента получала 404.
import { describe, expect, it, vi } from "vitest";
import { nextActionFor } from "../src/next-action.js";
import { waitUntilReady } from "../src/commands/db.js";

describe("waitUntilReady", () => {
  it("дожидается active", async () => {
    const statuses = ["creating", "creating", "active"];
    const api: any = { listDatabases: vi.fn(async () => [{ name: "shop", status: statuses.shift() }]) };
    expect(await waitUntilReady(api, "acme", "shop", 1000, 1)).toBe("active");
    expect(api.listDatabases).toHaveBeenCalledTimes(3);
  });

  it("не дождались — creating, а не «готово»", async () => {
    const api: any = { listDatabases: vi.fn(async () => [{ name: "shop", status: "creating" }]) };
    expect(await waitUntilReady(api, "acme", "shop", 20, 5)).toBe("creating");
  });

  it("сбой подготовки — failed", async () => {
    const api: any = { listDatabases: vi.fn(async () => [{ name: "shop", status: "failed" }]) };
    expect(await waitUntilReady(api, "acme", "shop", 1000, 1)).toBe("failed");
  });
});

describe("nextActionFor — подсказка вместо общего совета (п. 2)", () => {
  it("база ещё создаётся", () => {
    expect(nextActionFor(404, "база не найдена или не активна")).toContain("db list");
  });
  it("бесплатная база уже есть", () => {
    expect(nextActionFor(409, "база с Shared CPU у организации уже есть. Следующую заведите выделенным инстансом"))
      .toContain("одна на организацию");
  });
  it("ошибки SQL", () => {
    expect(nextActionFor(400, 'relation "orders" does not exist')).toContain("pg_tables");
    expect(nextActionFor(400, "syntax error at or near \"SELEC\"")).toContain("синтаксическая");
    expect(nextActionFor(400, "permission denied for table x")).toContain("GRANT");
  });
  it("auth и storage — включение в панели, а не CREATE SCHEMA (T-20261026-16)", () => {
    const hint = "схема auth и функция auth.uid() появляются после включения входа: " +
      "Базы данных → эта база → Авторизация → «Включить авторизацию»";
    for (const msg of [hint, 'schema "auth" does not exist', "function auth.uid() does not exist"]) {
      const action = nextActionFor(400, msg)!;
      expect(action).toContain("Авторизация");
      expect(action).not.toContain("CREATE SCHEMA");
    }
    expect(nextActionFor(400, 'schema "storage" does not exist')).toContain("Файлы");
    expect(nextActionFor(400, 'schema "shop" does not exist')).toContain("CREATE SCHEMA");
  });
  it("неизвестный отказ — без выдуманной подсказки", () => {
    expect(nextActionFor(400, "что-то совсем другое")).toBeUndefined();
  });
});
