// `layero perf`: устройство и страница замера доходят до сервера (25.10.2026).
//
// Вердикт считает сервер — тот же, что в панели (балл Lighthouse, порог −10).
// Запуск и показ результата обязаны просить ОДНУ и ту же страницу на ОДНОМ
// устройстве: иначе `show` покажет чужой замер и чужое сравнение.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api.js";

function client(): { api: ApiClient; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method) });
    return new Response("{}", { status: 200 });
  }));
  return { api: new ApiClient({ apiUrl: "https://api.test/", token: "t" } as any), calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("адрес ручки perf-check", () => {
  it("без флагов — прежний адрес: сервер мерит главную на компьютере", async () => {
    const { api, calls } = client();
    await api.startPerfCheck("p-1");
    await api.getPerfCheck("p-1");
    expect(calls).toEqual([
      { method: "POST", url: "https://api.test/projects/p-1/perf-check" },
      { method: "GET", url: "https://api.test/projects/p-1/perf-check" },
    ]);
  });

  it("--device и --path уходят параметрами в запуск и в показ одинаково", async () => {
    const { api, calls } = client();
    const opts = { device: "mobile", path: "/pricing?sort=price" };
    await api.startPerfCheck("p-1", opts);
    await api.getPerfCheck("p-1", opts);
    const want = "https://api.test/projects/p-1/perf-check?device=mobile&path=%2Fpricing%3Fsort%3Dprice";
    expect(calls.map((c) => c.url)).toEqual([want, want]);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
});
