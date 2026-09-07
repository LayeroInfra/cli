// Переменные окружения (AGENT-13).
//
// Главное, что проверяется: значения и их префиксы НЕ попадают в вывод.
// Всё, что печатает CLI в агентском режиме, оседает в истории переписки и
// уходит провайдеру модели, поэтому «показать кусочек ключа» здесь не
// безобидная мелочь, а утечка в чужой транскрипт.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getProject, listEnvVars, replaceEnvVars, loadProjectConfig } = vi.hoisted(() => ({
  getProject: vi.fn(), listEnvVars: vi.fn(), replaceEnvVars: vi.fn(), loadProjectConfig: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    getProject = getProject; listEnvVars = listEnvVars; replaceEnvVars = replaceEnvVars;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn(async () => ({ apiUrl: "x", token: "t" })) }));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig }));

import { envListCmd, envSetCmd, envUnsetCmd } from "../src/commands/env.js";
import { setMode } from "../src/agent.js";

const SECRET_PREVIEW = "sk-live1";

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  loadProjectConfig.mockResolvedValue({ project_id: "p1" });
  getProject.mockResolvedValue({ id: "p1", slug: "site" });
  // 🚨 В ФИКСТУРЕ ЕСТЬ `value`, ХОТЯ СЕРВЕР ЕГО НЕ ШЛЁТ. Это не ошибка данных, а
  // худший случай нарочно: поле, которого в фикстуре нет, утечь в тесте не
  // может — `toEqual` не видит `undefined`, и мутация «добавили значение в
  // событие» осталась бы зелёной. Проверено мутацией 07.09.2026.
  //
  // Если завтра ручка начнёт отдавать значение (а причин не завтра, так
  // послезавтра найдётся), сторож поймает это сразу, а не после утечки.
  listEnvVars.mockResolvedValue([
    { key: "OPENAI_API_KEY", masked: "••••••••", length: 51,
      preview: SECRET_PREVIEW, value: `${SECRET_PREVIEW}-полное-значение` },
    { key: "DATABASE_URL", masked: "••••••••", length: 64,
      preview: "postgre", value: "postgres://user:pass@host/db" },
  ]);
  replaceEnvVars.mockResolvedValue([]);
});

describe("значения не утекают", () => {
  it("список не печатает ни значение, ни префикс", async () => {
    // emit() в JSON-режиме пишет прямо в stdout, минуя console.log.
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => {
      lines.push(String(c));
      return true;
    }) as any);
    try {
      await envListCmd({ json: true });
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain("OPENAI_API_KEY");
    expect(out).not.toContain(SECRET_PREVIEW);
    expect(out).not.toContain("postgre");
  });

  it("в JSON-событии только имя и длина", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => {
      lines.push(String(c));
      return true;
    }) as any);
    try {
      await envListCmd({ json: true });
    } finally {
      spy.mockRestore();
    }
    const ev = JSON.parse(lines.find((l) => l.includes('"env_vars"'))!);
    // 🚨 СЛИЧАЕМ ПОЛНЫЙ НАБОР ПОЛЕЙ, А НЕ ОТСУТСТВИЕ ЗНАЧЕНИЯ. Смысл проверки в
    // том, что в событие попадает ТОЛЬКО безопасное: добавили поле — тест
    // краснеет и заставляет посмотреть, безопасно ли оно. Проверка «значения
    // нет» пропустила бы новое поле молча, а именно так секрет и уезжает.
    //
    // `managed` добавлен 06.09.2026 (признак «переменная от платформы») —
    // булев флаг, значения не несёт. Тест краснел с 06.09 09:39 и оставался
    // красным сутки: сторож секретов, который всегда красный, перестают читать.
    expect(ev.vars).toEqual([
      { key: "OPENAI_API_KEY", length: 51, managed: false },
      { key: "DATABASE_URL", length: 64, managed: false },
    ]);
    expect(JSON.stringify(ev)).not.toContain(SECRET_PREVIEW);
  });
});

describe("частичное обновление", () => {
  it("добавление одной переменной не требует знать остальные", async () => {
    await envSetCmd(["NEW_KEY=hello"], { json: true });
    const [, vars] = replaceEnvVars.mock.calls[0]!;
    // Существующие уходят сентинелом null — «оставь как есть».
    expect(vars).toEqual({ OPENAI_API_KEY: null, DATABASE_URL: null, NEW_KEY: "hello" });
  });

  it("значение со знаком = внутри не режется", async () => {
    await envSetCmd(["TOKEN=abc=def=ghi"], { json: true });
    const [, vars] = replaceEnvVars.mock.calls[0]!;
    expect(vars.TOKEN).toBe("abc=def=ghi");
  });

  it("строка без = отвергается понятной ошибкой", async () => {
    await expect(envSetCmd(["JUSTKEY"], { json: true })).rejects.toThrow(/KEY=value/);
  });

  it("перезапись существующей не трогает соседей", async () => {
    await envSetCmd(["DATABASE_URL=postgres://new"], { json: true });
    const [, vars] = replaceEnvVars.mock.calls[0]!;
    expect(vars).toEqual({ OPENAI_API_KEY: null, DATABASE_URL: "postgres://new" });
  });
});

describe("удаление", () => {
  it("убирает ключ, остальные сохраняет сентинелом", async () => {
    await envUnsetCmd(["DATABASE_URL"], { json: true, yes: true });
    const [, vars] = replaceEnvVars.mock.calls[0]!;
    expect(vars).toEqual({ OPENAI_API_KEY: null });
  });

  it("несуществующий ключ — ошибка, а не молчаливое стирание набора", async () => {
    await expect(envUnsetCmd(["NOPE"], { json: true, yes: true })).rejects.toThrow(/нет таких/);
    expect(replaceEnvVars).not.toHaveBeenCalled();
  });
});
