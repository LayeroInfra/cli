// Выбор деплоя для диагностики (AGENT-08).
//
// Спрашивают «почему упало», а не «как дела у позапрошлой удачной сборки».
// Если брать просто последний деплой, то после неудачной попытки, за которой
// последовал успешный редеплой, команда покажет успех — и пользователь решит,
// что проблема рассосалась сама.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getProject, listProjectDeploys, getDeployDiagnosis, loadProjectConfig } = vi.hoisted(() => ({
  getProject: vi.fn(),
  listProjectDeploys: vi.fn(),
  getDeployDiagnosis: vi.fn(),
  loadProjectConfig: vi.fn(),
}));

vi.mock("../src/api.js", () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  class ApiClient {
    getProject = getProject;
    listProjectDeploys = listProjectDeploys;
    getDeployDiagnosis = getDeployDiagnosis;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(async () => ({ apiUrl: "https://api.layero.ru", token: "t" })),
}));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig }));

import { diagnoseCmd } from "../src/commands/diagnose.js";
import { setMode } from "../src/agent.js";

const DIAG = {
  deploy_id: "d-fail", status: "failed", stage: "build", verdict: "Сборка упала",
  build_log_excerpt: ["ERROR"], build_error_found: true,
  runtime_log_excerpt: [], runtime_error_found: false,
  runtime_state: null, next_actions: ["fix_code"], truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  setMode({ agent: true, json: true, interactive: false, reason: "test" });
  getProject.mockResolvedValue({ id: "p1", slug: "site" });
  getDeployDiagnosis.mockResolvedValue(DIAG);
  loadProjectConfig.mockResolvedValue({ project_id: "p1" });
});

describe("выбор деплоя", () => {
  it("берёт последний НЕуспешный, а не просто последний", async () => {
    listProjectDeploys.mockResolvedValue([
      { id: "d-ok", status: "ready" },
      { id: "d-fail", status: "failed" },
    ]);
    await diagnoseCmd({ json: true });
    expect(getDeployDiagnosis).toHaveBeenCalledWith("d-fail");
  });

  it("при всех успешных берёт самый свежий", async () => {
    listProjectDeploys.mockResolvedValue([
      { id: "d-new", status: "ready" },
      { id: "d-old", status: "ready" },
    ]);
    await diagnoseCmd({ json: true });
    expect(getDeployDiagnosis).toHaveBeenCalledWith("d-new");
  });

  it("идущую сборку не считает падением", async () => {
    listProjectDeploys.mockResolvedValue([
      { id: "d-building", status: "building" },
      { id: "d-ok", status: "ready" },
    ]);
    await diagnoseCmd({ json: true });
    expect(getDeployDiagnosis).toHaveBeenCalledWith("d-building");
  });

  it("--deploy выигрывает и не ходит за списком", async () => {
    await diagnoseCmd({ json: true, deploy: "explicit-id" });
    expect(getDeployDiagnosis).toHaveBeenCalledWith("explicit-id");
    expect(listProjectDeploys).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });

  it("без проекта и без --deploy — понятная ошибка", async () => {
    loadProjectConfig.mockResolvedValue(null);
    await expect(diagnoseCmd({ json: true })).rejects.toThrow(/project_unknown|какой проект/);
  });

  it("проект без деплоев — понятная ошибка, а не пустой вывод", async () => {
    listProjectDeploys.mockResolvedValue([]);
    await expect(diagnoseCmd({ json: true })).rejects.toThrow(/no_deploys|ни одного деплоя/);
  });
});
