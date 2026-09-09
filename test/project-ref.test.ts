import { describe, expect, it } from "vitest";
import { looksLikeId } from "../src/project-ref.js";

/**
 * `--project <id|slug>` обещан в справке трёх команд. Отличать одно от другого
 * приходится клиенту, а не серверу: слаг проекта уникален В ПРЕДЕЛАХ
 * ОРГАНИЗАЦИИ (`projects_owner_slug_uniq`), то есть один и тот же слаг законно
 * существует у двух организаций сразу, и ручка `/projects/{id}` выбирать между
 * ними не имеет права.
 */
describe("ссылка на проект", () => {
  it("узнаёт идентификатор", () => {
    expect(looksLikeId("b377c218-5859-49d4-a1e8-ca3e3fc3af11")).toBe(true);
    expect(looksLikeId("B377C218-5859-49D4-A1E8-CA3E3FC3AF11")).toBe(true);
  });

  it("не принимает слаг за идентификатор", () => {
    // 🚨 Ровно этот слаг и уезжал в путь ручки как есть, возвращая 422
    // `uuid_parsing`, который CLI показывал как «internal, сообщите об ошибке».
    expect(looksLikeId("kofeinya-spa")).toBe(false);
    expect(looksLikeId("layero-docs")).toBe(false);
  });

  it("не путается на похожем", () => {
    expect(looksLikeId("b377c218-5859-49d4-a1e8-ca3e3fc3af1")).toBe(false);
    expect(looksLikeId("zzzzzzzz-5859-49d4-a1e8-ca3e3fc3af11")).toBe(false);
    expect(looksLikeId("")).toBe(false);
  });
});
