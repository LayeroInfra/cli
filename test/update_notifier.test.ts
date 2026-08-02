/**
 * Update notifier — pure logic.
 *
 * The notifier exists because a stale CLI silently withholds shipped fixes:
 * the runtime `project_type` auto-flip landed 2026-05-26 and prod still logged
 * 20 failed deploys / 16 projects over the next month with the exact crash it
 * prevents, because users (and the machine that found it) were running an old
 * build. These tests pin the two things that decide whether the nag is correct
 * and whether it is safe.
 */
import { describe, it, expect } from "vitest";
import { compareVersions, updateNotice } from "../src/update-notifier.js";

describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    // The bug a string compare would produce: "0.10.0" < "0.9.0".
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });

  it("handles the real-world case that triggered this work", () => {
    expect(compareVersions("0.5.3", "0.8.11")).toBe(-1);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("0.8.11", "0.8.11")).toBe(0);
  });

  it("compares a pre-release by its numeric core", () => {
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.4")).toBe(-1);
  });

  it("tolerates missing components and garbage", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("", "0.0.1")).toBe(-1);
    expect(compareVersions("not-a-version", "0.0.1")).toBe(-1);
  });
});

describe("updateNotice", () => {
  it("nags when behind, naming both versions and the upgrade command", () => {
    const notice = updateNotice("0.5.3", "0.8.11");
    expect(notice).toBeTruthy();
    expect(notice).toContain("0.5.3");
    expect(notice).toContain("0.8.11");
    expect(notice).toContain("npm i -g layero@latest");
  });

  it("stays silent when current", () => {
    expect(updateNotice("0.8.11", "0.8.11")).toBeNull();
  });

  it("stays silent when ahead of the registry (local dev build)", () => {
    expect(updateNotice("0.9.0", "0.8.11")).toBeNull();
  });

  it("stays silent when the latest version is unknown (offline)", () => {
    // resolveLatest returns null offline; the notifier must be a no-op, not a
    // scary message about a version we could not read.
    expect(updateNotice("0.5.3", null)).toBeNull();
  });
});

/**
 * Обе проверки выше — чистые, и обе проходили, пока нагон НЕ РАБОТАЛ ВООБЩЕ:
 * запрос уходил на `/layero/latest` с сокращённым `accept`, npm отвечал 406,
 * `fetchLatest` глотал не-ok и возвращал null. То есть «молчит, когда версия
 * неизвестна» было истинным всегда — во всех релизах, у всех пользователей.
 *
 * Поэтому проверка ходит в СЕТЬ: только живой ответ реестра доказывает, что
 * пара «адрес + заголовок» рабочая. Без сети — пропуск, а не падение: тест
 * охраняет контракт с npm, и падать он должен на 406, а не на офлайне.
 */
describe("registry contract (network)", () => {
  it("the URL + accept header the notifier uses actually returns dist-tags", async () => {
    let res: Response;
    try {
      res = await fetch("https://registry.npmjs.org/layero", {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return; // офлайн — проверять нечего
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as { "dist-tags"?: { latest?: string } };
    expect(typeof body["dist-tags"]?.latest).toBe("string");
  });
});
