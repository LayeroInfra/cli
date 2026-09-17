// Коды выхода по классам (этап 6 AX-аудита): 2 вход, 3 не найдено,
// 4 неверный ввод, 5 удалённая ошибка, 1 прочее.
import { describe, expect, it } from "vitest";
import { exitCodeFor } from "../src/exit-codes.js";

describe("exitCodeFor", () => {
  it("вход — 2", () => {
    for (const c of ["auth_required", "auth_expired", "auth_timeout"]) expect(exitCodeFor(c)).toBe(2);
  });
  it("не найдено — 3", () => {
    for (const c of ["project_unknown", "project_not_found", "org_unknown", "hook_not_found", "no_deploys", "claim_unknown"]) {
      expect(exitCodeFor(c)).toBe(3);
    }
  });
  it("неверный ввод — 4", () => {
    for (const c of ["invalid_type", "prebuilt_no_dir", "prebuilt_no_index", "branch_unsupported", "repo_format", "token_missing", "bad_format"]) {
      expect(exitCodeFor(c)).toBe(4);
    }
  });
  it("удалённая ошибка — 5, включая динамический deploy_<status> и http_5xx", () => {
    for (const c of ["deploy_failed", "deploy_cancelled", "deploy_not_started", "internal", "http_502", "deploy_whatever"]) {
      expect(exitCodeFor(c)).toBe(5);
    }
  });
  it("прочее — 1: лимит тарифа, нет прав, нужно подтверждение, 4xx без класса", () => {
    for (const c of ["plan_limit", "forbidden", "confirmation_required", "repeated_failure", "http_409", "unknown_code"]) {
      expect(exitCodeFor(c)).toBe(1);
    }
  });
});
