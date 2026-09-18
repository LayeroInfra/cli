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
