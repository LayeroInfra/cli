// Клиент Data API в CLI: пути и тела запросов (T-20260911-9).
//
// Команды проверяются на подделке клиента, поэтому ошибка в самом адресе ручки
// там не видна: подделке всё равно, куда «ушёл» запрос. Здесь — настоящий
// `ApiClient` и подменённый `fetch`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api.js";

function client(): { api: ApiClient; calls: Array<{ url: string; method: string; body: any }> } {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("{}", { status: 200 });
  }));
  return { api: new ApiClient({ apiUrl: "https://api.test/", token: "t" } as any), calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("адреса ручек Data API", () => {
  it("адрес сайта уходит параметром и кодируется целиком", async () => {
    const { api, calls } = client();
    await api.removeDataOrigin("acme", "db-1", "https://shop.example/?a=1&b=2");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: "https://api.test/organizations/acme/databases/db-1/api/origins?origin=https%3A%2F%2Fshop.example%2F%3Fa%3D1%26b%3D2",
    });
  });

  it("уровни — POST на /api/levels с командами для сверки", async () => {
    const { api, calls } = client();
    await api.setDataLevels("acme", "db-1", {
      object: "app.products", levels: { GET: "visitor" }, level: null, apply: true, expected_sql: ["GRANT …;"],
    });
    expect(calls[0]).toEqual({
      method: "POST",
      url: "https://api.test/organizations/acme/databases/db-1/api/levels",
      body: { object: "app.products", levels: { GET: "visitor" }, level: null, apply: true, expected_sql: ["GRANT …;"] },
    });
  });

  it("методы, ключи, сайты и включение", async () => {
    const { api, calls } = client();
    await api.listDataMethods("acme", "db-1");
    await api.listDataKeys("acme", "db-1");
    await api.issueDataKey("acme", "db-1", { kind: "secret", label: null, expires_in_days: 30 });
    await api.revokeDataKey("acme", "db-1", "k1");
    await api.addDataOrigin("acme", "db-1", "https://shop.example", "витрина");
    await api.enableDataApi("acme", "db-1", true);
    const base = "https://api.test/organizations/acme/databases/db-1/api";
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${base}/methods`,
      `GET ${base}/keys`,
      `POST ${base}/keys`,
      `DELETE ${base}/keys/k1`,
      `POST ${base}/origins`,
      `POST ${base}/enable?with_secret=true`,
    ]);
    expect(calls[2]!.body).toEqual({ kind: "secret", label: null, expires_in_days: 30 });
    expect(calls[4]!.body).toEqual({ origin: "https://shop.example", note: "витрина" });
  });
});
