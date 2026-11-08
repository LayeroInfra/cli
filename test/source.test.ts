// `layero source` (T-20261108-4): какой деплой берём, куда кладём файл и как
// объясняем отказы платформы.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { listAllProjectDeploys, getDeploySource, getProject, loadProjectConfig, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body: string) { super(message); }
  }
  return {
    listAllProjectDeploys: vi.fn(),
    getDeploySource: vi.fn(),
    getProject: vi.fn(),
    loadProjectConfig: vi.fn(),
    ApiError,
  };
});

vi.mock("../src/api.js", () => {
  class ApiClient {
    listAllProjectDeploys = listAllProjectDeploys;
    getDeploySource = getDeploySource;
    getProject = getProject;
  }
  return { ApiClient, ApiError };
});
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(async () => ({ apiUrl: "https://api.layero.ru", token: "t" })),
}));
vi.mock("../src/project-config.js", () => ({ loadProjectConfig }));

import { pickDeploy, sourceCmd } from "../src/commands/source.js";
import { LayeroError } from "../src/agent.js";
import { exitCodeFor } from "../src/exit-codes.js";

const D = (id: string, sha: string, status = "ready") =>
  ({ id, commit_sha: sha, status, created_at: "2026-11-08T10:00:00Z" }) as never;
const DEPLOYS = [D("d-new", "aaaaaaa1"), D("d-live", "bbbbbbb2"), D("d-old", "ccccccc3")];

let dir: string;
let cwd: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "layero-source-"));
  cwd = process.cwd();
  process.chdir(dir);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  loadProjectConfig.mockResolvedValue({ project_id: "p1" });
  getProject.mockResolvedValue({ id: "p1", slug: "site", production_deploy_id: "d-live" });
  listAllProjectDeploys.mockResolvedValue(DEPLOYS);
  getDeploySource.mockResolvedValue({ url: "https://s3.example/x.zip", filename: "site-bbbbbbb.zip", expires_in: 300 });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 })));
});

afterEach(async () => {
  process.chdir(cwd);
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("какой деплой", () => {
  it("без аргумента — тот, что на адресе проекта", () => {
    expect(pickDeploy(DEPLOYS, undefined, "d-live")?.id).toBe("d-live");
  });
  it("без указателя — последний готовый", () => {
    expect(pickDeploy([D("x", "1", "failed"), ...DEPLOYS], undefined, null)?.id).toBe("d-new");
  });
  it("по префиксу коммита и по id", () => {
    expect(pickDeploy(DEPLOYS, "ccccc", null)?.id).toBe("d-old");
    expect(pickDeploy(DEPLOYS, "d-new", null)?.id).toBe("d-new");
  });
});

describe("layero source", () => {
  it("сохраняет ZIP под именем от платформы", async () => {
    await sourceCmd(undefined, {});
    expect(getDeploySource).toHaveBeenCalledWith("p1", "d-live");
    const saved = await fs.readFile(path.join(dir, "site-bbbbbbb.zip"));
    expect([...saved]).toEqual([80, 75, 3, 4]);
  });

  it("чужой файл не перезаписывает без --force", async () => {
    await fs.writeFile(path.join(dir, "site-bbbbbbb.zip"), "mine");
    const err = await sourceCmd(undefined, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LayeroError);
    expect(err.code).toBe("file_exists");
    expect(exitCodeFor(err.code)).toBe(4);
    expect(await fs.readFile(path.join(dir, "site-bbbbbbb.zip"), "utf8")).toBe("mine");
    await sourceCmd(undefined, { force: true });
    expect((await fs.readFile(path.join(dir, "site-bbbbbbb.zip"))).length).toBe(4);
  });

  it("--url не качает, а печатает ссылку", async () => {
    await sourceCmd(undefined, { url: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("https://s3.example/x.zip"));
  });

  it("деплой из репозитория — код и ссылка на коммит", async () => {
    getDeploySource.mockRejectedValue(new ApiError("409", 409, JSON.stringify({
      detail: { code: "source_in_repository", message: "…", commit_url: "https://github.com/a/b/commit/bbb" },
    })));
    const err = await sourceCmd(undefined, {}).catch((e) => e);
    expect(err.code).toBe("source_in_repository");
    expect(err.next_action).toContain("https://github.com/a/b/commit/bbb");
    expect(exitCodeFor(err.code)).toBe(4);
  });

  it("архив удалён — source_not_kept, выход 3", async () => {
    getDeploySource.mockRejectedValue(new ApiError("404", 404, JSON.stringify({
      detail: { code: "source_not_kept", message: "Исходники этого деплоя удалены" },
    })));
    const err = await sourceCmd("ccccc", {}).catch((e) => e);
    expect(err.code).toBe("source_not_kept");
    expect(exitCodeFor(err.code)).toBe(3);
  });

  it("viewer — forbidden с объяснением", async () => {
    getDeploySource.mockRejectedValue(new ApiError("403", 403, '{"detail":"Insufficient role"}'));
    const err = await sourceCmd(undefined, {}).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(err.next_action).toContain("editor");
  });

  it("неизвестный деплой — no_deploy", async () => {
    const err = await sourceCmd("zzzz", {}).catch((e) => e);
    expect(err.code).toBe("no_deploy");
    expect(getDeploySource).not.toHaveBeenCalled();
  });
});
