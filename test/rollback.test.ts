// `layero rollback` на уже активную сборку (T-20260917-49).
//
// Второй `rollback` подряд: цель уже на живом адресе, API отвечает 400
// «target deploy is already the active one». Это штатный отказ, и подавать
// его как `internal` с сырым телом и выходом 5 («сбой платформы») нельзя.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { listProjectDeploys, rollbackProject, loadProjectConfig, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  return {
    listProjectDeploys: vi.fn(),
    rollbackProject: vi.fn(),
    loadProjectConfig: vi.fn(),
    ApiError,
  };
});

vi.mock("../src/api.js", () => {
  class ApiClient {
    listProjectDeploys = listProjectDeploys;
    rollbackProject = rollbackProject;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(async () => ({ apiUrl: "https://api.layero.ru", token: "t" })),
}));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig }));

import { rollbackCmd } from "../src/commands/deploys.js";
import { LayeroError } from "../src/agent.js";
import { exitCodeFor } from "../src/exit-codes.js";

const DEPLOYS = [
  { id: "d-new", status: "ready", commit_sha: "aaaaaaa1", created_at: "2026-09-17T10:00:00Z", commit_message: "new" },
  { id: "d-old", status: "ready", commit_sha: "bbbbbbb2", created_at: "2026-09-16T10:00:00Z", commit_message: "old" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  loadProjectConfig.mockResolvedValue({ project_id: "p1" });
  listProjectDeploys.mockResolvedValue(DEPLOYS);
});

describe("rollback на уже активную сборку", () => {
  it("400 already active → rollback_noop с next_action, выход 4", async () => {
    rollbackProject.mockRejectedValue(
      new ApiError("400", 400, '{"detail":"target deploy is already the active one"}'),
    );
    const err = await rollbackCmd({ yes: true }).catch((e) => e);
    expect(err).toBeInstanceOf(LayeroError);
    expect(err.code).toBe("rollback_noop");
    expect(err.message).toBe("откатывать нечего: эта сборка уже на живом адресе");
    expect(err.next_action).toContain("layero promote <sha>");
    expect(err.next_action).toContain("layero deploys list");
    expect(exitCodeFor(err.code)).toBe(4);
    expect(rollbackProject).toHaveBeenCalledWith("p1", { branch: undefined, deploy_id: "d-old" });
  });

  it("прочий 400 остаётся как был — не маскируется под rollback_noop", async () => {
    rollbackProject.mockRejectedValue(
      new ApiError("400", 400, '{"detail":"deploy belongs to a different environment"}'),
    );
    const err = await rollbackCmd({ yes: true }).catch((e) => e);
    expect(err).not.toBeInstanceOf(LayeroError);
    expect(err.message).toMatch(/rollback failed \(400\)/);
  });
});
