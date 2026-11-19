// Отказ 402 «лимит тарифа»: текст сервера вместо служебного ключа показателя,
// подсказка — по рекомендации сервера (лимиты с 1 декабря, оферта 4.1).
import { describe, expect, it } from "vitest";
import { asAccountStateError, planLimitError } from "../src/account-errors.js";
import { ApiError } from "../src/api.js";

const body = (detail: Record<string, unknown>) => JSON.stringify({ detail });

describe("planLimitError", () => {
  it("Free, сборки закончились: текст сервера, совет — Pro, без builds.billable", () => {
    const e = planLimitError(body({
      feature: "builds.billable", limit: 100, observed: 100, suggested_plan: "pro",
      message: "Сборки по тарифу закончились. Опубликованные сайты работают. Новый период начнётся 1 января. Откройте раздел «Потребление».",
    }));
    expect(e.code).toBe("plan_limit");
    expect(e.message).toContain("Сборки по тарифу закончились");
    expect(e.message).not.toContain("builds.billable");
    expect(e.next_action).toBe("перейдите на Pro на app.layero.ru/billing");
  });

  it.each([
    ["enable_extra_usage", "включите дополнительное потребление"],
    ["raise_budget", "увеличьте бюджет дополнительного потребления"],
    ["top_up", "пополните баланс"],
  ])("Pro, %s: совет — не смена тарифа", (action, hint) => {
    const e = planLimitError(body({
      feature: "builds.billable", limit: 1000, observed: 1000, suggested_plan: null,
      suggested_action: action, message: "Сборки по тарифу закончились. Опубликованные сайты работают.",
    }));
    expect(e.next_action).toContain(hint);
    expect(e.next_action).not.toContain("смените тариф");
    expect(e.message).not.toContain("builds.billable");
  });

  it("известный лимит — прежний текст со счётчиком", () => {
    const e = planLimitError(body({ feature: "max_projects", limit: 5, observed: 5, suggested_plan: "pro" }));
    expect(e.message).toBe("Тариф не позволяет больше проектов (5 при лимите 5).");
    expect(e.next_action).toContain("смените тариф");
  });

  it("тело не JSON — общий текст", () => {
    expect(planLimitError("<html>").message).toBe("Действие недоступно на текущем тарифе.");
  });

  it("asAccountStateError переводит 402 в plan_limit", () => {
    const e = asAccountStateError(new ApiError("402", 402, body({ feature: "builds.billable", message: "Сборки по тарифу закончились." })));
    expect(e?.code).toBe("plan_limit");
    expect(e?.message).toBe("Сборки по тарифу закончились.");
  });

  it("показывает готовый ответ сервера: фразу со ссылкой и что делать агенту", () => {
    const e = planLimitError(body({
      feature: "custom_domains", suggested_plan: "pro",
      message: "Свои домены доступны на тарифе Pro",
      user_message: "Свои домены доступны на тарифе Pro, у организации acme сейчас Free. Попробуйте Pro 7 дней бесплатно: https://app.layero.ru/orgs/acme/billing?subscribe=month",
      next_action: "Расскажите пользователю, что это доступно на тарифе Pro: пробный период 7 дней бесплатно, оформить можно по ссылке https://app.layero.ru/orgs/acme/billing?subscribe=month. Не повторяйте действие, пока подписка не оформлена.",
    }));
    expect(e.code).toBe("plan_limit");
    expect(e.message).toContain("Попробуйте Pro 7 дней бесплатно: https://app.layero.ru/orgs/acme/billing?subscribe=month");
    expect(e.next_action).toContain("Не повторяйте действие");
  });
});
