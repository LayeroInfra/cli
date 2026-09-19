// Поток лога сборки в `--json` (T-20260918-8/9).
//
// 1. Событие `stage` объявлялось по текущему этапу деплоя ДО пачки строк, и
//    хвост прошлого этапа оказывался под заголовком нового.
// 2. Строки `npm http fetch|cache` — почти четверть лога сборки на проде; в
//    `--json` каждая была отдельным событием, и ошибка тонула в них.
import { describe, expect, it, vi, beforeEach } from "vitest";

import { streamDeployLogs } from "../src/logs.js";
import { setMode } from "../src/agent.js";

beforeEach(() => setMode({ agent: true, json: true, interactive: false, reason: "test" }));

function capture(): { events: any[]; restore: () => void } {
  const events: any[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
    events.push(JSON.parse(String(s)));
    return true;
  });
  return { events, restore: () => spy.mockRestore() };
}

describe("streamDeployLogs", () => {
  it("объявляет этап по строке: хвост install не попадает под build", async () => {
    const api = {
      pollLogs: vi.fn().mockResolvedValueOnce({
        current_stage: "build",
        terminal: true,
        status: "ready",
        lines: [
          { id: 1, line: "added 10 packages", stream: "stdout", stage: "install" },
          { id: 2, line: "vite build", stream: "stdout", stage: "build" },
        ],
      }),
    };
    const { events, restore } = capture();
    try {
      await streamDeployLogs(api as any, "dep-1");
    } finally {
      restore();
    }
    expect(events.map((e) => (e.event === "stage" ? `stage:${e.name}` : e.line))).toEqual([
      "stage:install",
      "added 10 packages",
      "stage:build",
      "vite build",
    ]);
  });

  it("прячет строки npm http, один раз говоря об этом", async () => {
    const api = {
      pollLogs: vi.fn().mockResolvedValueOnce({
        current_stage: "install",
        terminal: true,
        status: "ready",
        lines: [
          { id: 1, line: "npm http fetch GET 200 https://npm/x 5ms", stream: "stderr", stage: "install" },
          { id: 2, line: "npm http cache y@1 0ms (cache hit)", stream: "stderr", stage: "install" },
          { id: 3, line: "npm error ERESOLVE", stream: "stderr", stage: "install" },
        ],
      }),
    };
    const { events, restore } = capture();
    try {
      await streamDeployLogs(api as any, "dep-1");
    } finally {
      restore();
    }
    const lines = events.filter((e) => e.event === "build_log").map((e) => e.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/npm http" download lines are hidden/);
    expect(lines[1]).toBe("npm error ERESOLVE");
  });
});

// T-20260918-16: опрос логов без таймаута и повтора вешал deploy на 15 минут
// и ронял его с `internal: fetch failed` при успешной сборке.
import { setRetryDelayScaleForTests } from "../src/logs.js";
import { ApiError } from "../src/api.js";

describe("streamDeployLogs: сбои опроса", () => {
  beforeEach(() => setRetryDelayScaleForTests(0));

  it("переживает сетевые сбои и доходит до конца сборки", async () => {
    const api = {
      pollLogs: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
        .mockResolvedValueOnce({ current_stage: "activate", terminal: true, status: "ready", lines: [] }),
    };
    const { restore } = capture();
    try {
      const final = await streamDeployLogs(api as any, "dep-1");
      expect(final.status).toBe("ready");
    } finally {
      restore();
    }
    expect(api.pollLogs).toHaveBeenCalledTimes(3);
  });

  it("после серии сбоев отдаёт deploy_watch_lost с подсказкой, а не internal", async () => {
    const api = { pollLogs: vi.fn().mockRejectedValue(new TypeError("fetch failed")) };
    const { restore } = capture();
    try {
      await expect(streamDeployLogs(api as any, "dep-9")).rejects.toMatchObject({
        code: "deploy_watch_lost",
        next_action: expect.stringContaining("logs --deploy dep-9"),
      });
    } finally {
      restore();
    }
    expect(api.pollLogs).toHaveBeenCalledTimes(8);
  });

  it("отказ по существу (404) не повторяет", async () => {
    const api = { pollLogs: vi.fn().mockRejectedValue(new ApiError("nope", 404, "")) };
    const { restore } = capture();
    try {
      await expect(streamDeployLogs(api as any, "dep-1")).rejects.toBeInstanceOf(ApiError);
    } finally {
      restore();
    }
    expect(api.pollLogs).toHaveBeenCalledTimes(1);
  });
});
