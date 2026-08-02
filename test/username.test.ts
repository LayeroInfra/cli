/**
 * Имя аккаунта из терминала.
 *
 * Существует потому, что без имени бэкенд отвечает 412 на создание проекта, а
 * CLI умел только отправить в браузер («откройте /onboarding»). Для
 * инструмента, весь смысл которого — не ходить в дашборд, это тупик: на момент
 * правки в нём сидело 14 активных аккаунтов.
 *
 * Проверяем две вещи, которые ломаются молча и дорого:
 *   * подсказка имени не должна предлагать заведомо невалидное — иначе первый
 *     же Enter уходит в отказ;
 *   * в агентском режиме НЕЛЬЗЯ спрашивать: приглашение ввода там повиснет
 *     навсегда, и деплой из Cursor/CI просто не вернётся.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { suggestUsername, ensureUsername } from "../src/username.js";
import { LayeroError, setMode } from "../src/agent.js";

describe("suggestUsername", () => {
  it("берёт логин GitHub как есть, когда он уже валиден", () => {
    expect(suggestUsername({ github_login: "alice", email: "x@y.z" })).toBe("alice");
  });

  it("предпочитает логин GitHub почте", () => {
    expect(suggestUsername({ github_login: "bob", email: "carol@y.z" })).toBe("bob");
  });

  it("берёт локальную часть почты, когда GitHub не привязан", () => {
    expect(suggestUsername({ github_login: null, email: "carol@example.com" })).toBe("carol");
  });

  it("приводит к допустимому виду: регистр, точки, подчёркивания", () => {
    expect(suggestUsername({ github_login: null, email: "Ivan.Petrov_99@mail.ru" }))
      .toBe("ivan-petrov-99");
  });

  it("не оставляет дефис по краям и сдвоенные внутри", () => {
    expect(suggestUsername({ github_login: "--Foo..Bar--", email: null })).toBe("foo-bar");
  });

  it("отдаёт пустое, когда предлагать нечего", () => {
    // Пустая подсказка честнее заведомо невалидной: приглашение ввода просто
    // не подставит значение по умолчанию.
    expect(suggestUsername({ github_login: null, email: null })).toBe("");
    expect(suggestUsername({ github_login: "_", email: null })).toBe("");
  });

  it("режет по 32 символам и не оставляет хвостовой дефис после реза", () => {
    const got = suggestUsername({ github_login: "a".repeat(31) + "-bcd", email: null });
    expect(got.length).toBeLessThanOrEqual(32);
    expect(got.endsWith("-")).toBe(false);
  });
});

describe("ensureUsername", () => {
  beforeEach(() => {
    setMode({ agent: true, json: true, interactive: false, reason: "test" });
  });

  it("возвращает уже заданное имя, ничего не спрашивая и не записывая", async () => {
    let wrote = false;
    const api = {
      me: async () => ({ id: "u", username: "alice", email: null }),
      setUsername: async () => {
        wrote = true;
        return { username: "x", organization_slug: "x" };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await ensureUsername(api as any)).toBe("alice");
    expect(wrote).toBe(false);
  });

  it("в агентском режиме не спрашивает, а отдаёт username_required с командой", async () => {
    const api = { me: async () => ({ id: "u", username: null, email: "a@b.c" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await ensureUsername(api as any).catch((e) => e);
    expect(err).toBeInstanceOf(LayeroError);
    expect((err as LayeroError).code).toBe("username_required");
    // Подсказка обязана называть исполнимую команду, иначе агент снова
    // отправит человека в браузер — ровно то, от чего уходим.
    expect((err as LayeroError).next_action).toContain("layero username");
  });
});
