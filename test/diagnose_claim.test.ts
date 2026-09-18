// `diagnose` и `logs` в папке песочницы без аккаунта (T-20260918-8).
//
// Агент без аккаунта выкатывает через `deploy --claim`. На упавшей сборке
// совет вёл в панель, которая ему недоступна, а `diagnose` требовал вход.
// Токен песочницы читать деплои своего проекта умеет — им и пользуемся.
import { describe, expect, it, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({
  seenTokens: [] as Array<string | undefined>,
  loadConfig: vi.fn(),
  loadProjectConfig: vi.fn(),
  getDeployDiagnosis: vi.fn(),
  pollLogs: vi.fn(),
  listProjectDeploys: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    constructor(cfg: { token?: string }) { M.seenTokens.push(cfg.token); }
    getDeployDiagnosis = M.getDeployDiagnosis;
    pollLogs = M.pollLogs;
    listProjectDeploys = M.listProjectDeploys;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({ loadConfig: M.loadConfig, saveConfig: vi.fn() }));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig: M.loadProjectConfig, persistProjectLinking: vi.fn() }));
vi.mock("open", () => ({ default: vi.fn() }));

import { diagnoseCmd, logsCmd } from "../src/commands/diagnose.js";
import { deploysListCmd } from "../src/commands/deploys.js";
import { setMode } from "../src/agent.js";

beforeEach(() => {
  vi.clearAllMocks();
  M.seenTokens.length = 0;
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  M.loadConfig.mockResolvedValue({ apiUrl: "https://api.layero.ru", claim_tokens: { "p-claim": "claim-token" } });
  M.loadProjectConfig.mockResolvedValue({ project_id: "p-claim", slug: "sandbox", claim: { code: "c" } });
  M.getDeployDiagnosis.mockResolvedValue({ deploy_id: "d1", status: "failed", next_actions: [] });
  M.pollLogs.mockResolvedValue({ status: "failed", lines: [], terminal: true });
});

describe("песочница без аккаунта", () => {
  it("diagnose берёт токен песочницы папки", async () => {
    await diagnoseCmd({ deploy: "d1", json: true });
    expect(M.seenTokens).toEqual(["claim-token"]);
    expect(M.getDeployDiagnosis).toHaveBeenCalledWith("d1");
  });

  it("logs — тоже", async () => {
    await logsCmd({ deploy: "d1", json: true });
    expect(M.seenTokens).toEqual(["claim-token"]);
  });

  it("deploys list — тоже: на него ведёт совет при отменённой выкатке", async () => {
    M.listProjectDeploys.mockResolvedValue([]);
    await deploysListCmd({});
    expect(M.seenTokens).toEqual(["claim-token"]);
    expect(M.listProjectDeploys).toHaveBeenCalledWith("p-claim", undefined);
  });

  it("чужой --project токеном песочницы не читается: нужен вход", async () => {
    await expect(diagnoseCmd({ project: "other", json: true })).rejects.toMatchObject({ code: "auth_required" });
  });

  it("вход аккаунта важнее токена песочницы", async () => {
    M.loadConfig.mockResolvedValue({ apiUrl: "x", token: "account", claim_tokens: { "p-claim": "claim-token" } });
    await diagnoseCmd({ deploy: "d1", json: true });
    expect(M.seenTokens).toEqual(["account"]);
  });
});
