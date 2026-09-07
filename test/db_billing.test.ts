// Деньги в CLI: честный отказ на платный заказ и срок оплаты в списке.
//
// 🚨 ПЛАТНЫЙ ЗАКАЗ ИЗ ТЕРМИНАЛА НЕВОЗМОЖЕН, И ЭТО ОСОЗНАННО: у него есть цена и
// заморозка денег на карте, а подтвердить сумму в терминале негде. Но команда
// об этом молчала: `--cpu 2` давала «неизвестный параметр», то есть ответ про
// синтаксис вместо ответа про причину.
//
// 🚨 И СРОК ОПЛАТЫ. `db list` показывал платную базу неотличимо от бесплатной,
// а у неё через несколько дней закрывается доступ. Человек, живущий в
// терминале, узнавал бы об этом по неработающей базе.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { listDatabases, createDatabase, listOrganizations } = vi.hoisted(() => ({
  listDatabases: vi.fn(), createDatabase: vi.fn(), listOrganizations: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    listDatabases = listDatabases;
    createDatabase = createDatabase;
    listOrganizations = listOrganizations;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(async () => ({ apiUrl: "https://api.layero.ru", token: "t" })),
}));

import { billingLine, dbCreateCmd, dbListCmd } from "../src/commands/db.js";
import { setMode } from "../src/agent.js";

const DAY = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  listOrganizations.mockResolvedValue([{ slug: "acme", kind: "personal" }]);
});

describe("платный заказ из терминала", () => {
  it("отказывает и ведёт в панель, а не создаёт Shared молча", async () => {
    await expect(dbCreateCmd("shop", { cpu: 2, org: "acme" })).rejects.toMatchObject({
      code: "dedicated_needs_panel",
    });
    // 🚨 Главное: базу НЕ создали. Молчаливое создание Shared вместо
    // выделенного хуже отказа — человек получил бы не то, что просил, и узнал
    // бы об этом по нехватке мощности.
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("в отказе есть адрес мастера, а не просто «нельзя»", async () => {
    const err = await dbCreateCmd("shop", { dedicated: true, org: "acme" })
      .then(() => null, (e) => e);
    expect(String(err?.next_action ?? err?.message)).toContain("/databases?new=1");
  });

  it("адрес панели выводится из адреса API, а не зашит", async () => {
    // Стенд не должен уводить человека на боевую панель.
    process.env.LAYERO_DASHBOARD_URL = "http://localhost:5174";
    const err = await dbCreateCmd("shop", { ram: 4096, org: "acme" })
      .then(() => null, (e) => e);
    delete process.env.LAYERO_DASHBOARD_URL;
    expect(String(err?.next_action ?? "")).toContain("http://localhost:5174/databases?new=1");
  });

  it("обычное создание не задето", async () => {
    createDatabase.mockResolvedValue({ id: "db-1", connection_string: "postgres://…" });
    await dbCreateCmd("shop", { org: "acme" });
    expect(createDatabase).toHaveBeenCalledOnce();
  });
});

describe("срок оплаты в списке", () => {
  const base = { id: "d", name: "shop", provider: "layero", status: "active",
                 db_name: "db_shop", name_slug: "shop", api_enabled: false,
                 projects_count: 0, quota_bytes: 0, size_bytes: 0,
                 placement: "dedicated" as const };

  it("у бесплатной базы про деньги ни слова", () => {
    expect(billingLine({ ...base, placement: "sandbox" })).toBeNull();
  });

  it("оплаченная — цена и дата следующего списания", () => {
    const line = billingLine({ ...base, billing: {
      status: "active", price_month_kopecks: 90000,
      paid_until: iso(24 * DAY), next_charge_at: iso(21 * DAY) } });
    expect(line).toContain("900");
    expect(line).toContain("спишем");
  });

  it("🚨 у закрытого доступа — про снос, а не про списание", () => {
    // «Спишем 3 октября» здесь было бы неправдой: списывать уже пробовали.
    const line = billingLine({ ...base, billing: {
      status: "suspended", price_month_kopecks: 90000,
      paid_until: iso(-DAY), next_charge_at: iso(-4 * DAY),
      terminate_at: iso(3 * DAY) } });
    expect(line).toContain("удалим");
    expect(line).not.toContain("спишем");
  });

  it("у неоплаченной — до какого числа ещё работает", () => {
    const line = billingLine({ ...base, billing: {
      status: "past_due", price_month_kopecks: 90000,
      paid_until: iso(2 * DAY), next_charge_at: iso(-DAY) } });
    expect(line).toContain("оплата не прошла");
    expect(line).toContain("работает по");
  });

  it("список печатает эту строку, а не только умеет её строить", async () => {
    // Место вызова — то, что ломается: функция может быть верной и не звучать.
    setMode({ agent: false, json: false, interactive: true, reason: "test" });
    listDatabases.mockResolvedValue([{ ...base, billing: {
      status: "suspended", price_month_kopecks: 90000,
      paid_until: iso(-DAY), next_charge_at: iso(-4 * DAY),
      terminate_at: iso(3 * DAY) } }]);
    const said: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => { said.push(a.join(" ")); });
    await dbListCmd({ org: "acme" });
    spy.mockRestore();
    expect(said.join("\n")).toContain("удалим");
  });
});
