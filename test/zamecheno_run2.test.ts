// Прогон 2 «Замечено» (27.10.2026): то, что делалось только в панели или обходом.
//  · R2-03 `db delete` — без --yes вне терминала ничего не удаляет;
//  · R2-04 `data buckets create` — коротким ключом хранилища, без секретного;
//  · R2-05 `db sql --file` — скрипт из файла;
//  · R2-08 `data auth sender` — имя отправителя писем.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const api = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  listDatabases: vi.fn(),
  deleteDatabase: vi.fn(),
  openStorageSession: vi.fn(),
  setDataAuthSettings: vi.fn(),
  queryDatabase: vi.fn(),
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

import { dbDeleteCmd, dbSqlCmd } from "../src/commands/db.js";
import { dataAuthSenderCmd, dataBucketsCreateCmd, parseSize } from "../src/commands/data-files.js";
import { setMode } from "../src/agent.js";

const DB = { id: "db-1", name: "zamecheno", name_slug: "zamecheno", api_enabled: true, status: "active" };

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

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  api.listOrganizations.mockResolvedValue([{ slug: "acme", kind: "personal" }]);
  api.listDatabases.mockResolvedValue([DB]);
  api.openStorageSession.mockResolvedValue({ url: "https://data.example/zamecheno", key: "short-key", expires_at: null });
  api.queryDatabase.mockResolvedValue({ columns: [], rows: [], row_count: 0, truncated: false, status: "ok" });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ name: "screenshots" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("db delete", () => {
  it("без --yes вне терминала ничего не удаляет", async () => {
    const { error } = await capture(() => dbDeleteCmd("zamecheno", { json: true }));
    expect(error?.code).toBe("confirmation_required");
    expect(api.deleteDatabase).not.toHaveBeenCalled();
  });

  it("с --yes удаляет и сообщает событием", async () => {
    const { out, error } = await capture(() => dbDeleteCmd("zamecheno", { yes: true, json: true }));
    expect(error).toBeNull();
    expect(api.deleteDatabase).toHaveBeenCalledWith("acme", "db-1");
    expect(out).toContain("database_deleted");
  });
});

describe("data buckets create", () => {
  it("идёт в хранилище коротким ключом с лимитами", async () => {
    const { out, error } = await capture(() =>
      dataBucketsCreateCmd("screenshots", { private: true, max: "5MB", types: "image/jpeg, image/png", json: true }));
    expect(error).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://data.example/zamecheno/storage/v1/bucket");
    expect(init.headers.apikey).toBe("short-key");
    expect(JSON.parse(init.body)).toEqual({
      id: "screenshots", name: "screenshots", public: false,
      file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ["image/jpeg", "image/png"],
    });
    expect(out).toContain("data_bucket_created");
  });

  it("отказ хранилища — словами, а не молча", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "bucket exists" }), { status: 409 }));
    const { error } = await capture(() => dataBucketsCreateCmd("screenshots", { json: true }));
    expect(error?.message).toContain("bucket exists");
  });

  it("размер понимается по-человечески", () => {
    expect(parseSize("512KB")).toBe(512 * 1024);
    expect(parseSize("1,5 GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize("1000")).toBe(1000);
    expect(() => parseSize("пять")).toThrow();
  });
});

describe("db sql --file", () => {
  it("скрипт читается из файла целиком", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zm-sql-"));
    const file = path.join(dir, "0001.sql");
    writeFileSync(file, "create table t(x int);\ninsert into t values (1);\n");
    const { error } = await capture(() => dbSqlCmd("zamecheno", { file, json: true }));
    expect(error).toBeNull();
    expect(api.queryDatabase).toHaveBeenCalledWith("acme", "db-1",
      "create table t(x int);\ninsert into t values (1);");
  });

  it("файл и текст разом — отказ", async () => {
    const { error } = await capture(() => dbSqlCmd("zamecheno", { file: "x.sql", command: "select 1", json: true }));
    expect(error?.code).toBe("bad_format");
  });
});

describe("data auth sender", () => {
  it("кладёт имя отправителя в настройки писем", async () => {
    const { out, error } = await capture(() => dataAuthSenderCmd("Замечено", { json: true }));
    expect(error).toBeNull();
    expect(api.setDataAuthSettings).toHaveBeenCalledWith("acme", "db-1", { emails: { sender_name: "Замечено" } });
    expect(out).toContain("data_auth_sender_set");
  });
});
