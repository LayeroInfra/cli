import { CliConfig } from "./config.js";
import type { components } from "./generated/api-types.js";

/**
 * Типы ответов API берутся из СГЕНЕРИРОВАННОЙ схемы (AGENT-03), а не
 * описываются руками. Раньше здесь лежало ~200 строк интерфейсов, которые
 * синхронизировались с бэкендом глазами: поле, переименованное на сервере,
 * оставалось прежним в этом файле, TypeScript продолжал компилироваться, и
 * расхождение всплывало уже у пользователя.
 *
 * `scripts/gen-sdk.sh` перегенерирует файл, а CI падает, если он разошёлся
 * со схемой.
 */
type Schemas = components["schemas"];

export type ProjectSummary = Schemas["ProjectOut"];
export type MeOut = Schemas["MeOut"];
export type UploadInit = Schemas["UploadInitOut"];
export type DeployOut = Schemas["DeployOut"];
export type ProbeOut = Schemas["ProbeOut"];
export type LogsPollOut = Schemas["DeployLogsPollOut"];
export type DeploySessionOut = Schemas["DeploySessionOut"];
export type DeploySessionStatusOut = Schemas["DeploySessionStatusOut"];

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}


export interface DeployHookOut {
  id: string;
  name: string;
  branch: string | null;
  target: "preview" | "production";
  url: string;
  created_at: string;
  last_triggered_at: string | null;
}

export interface LogLine {
  id: number;
  stream: string;
  line: string;
  created_at: string;
}


export class ApiClient {
  constructor(private readonly cfg: CliConfig) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.cfg.token) {
      h.Authorization = `Bearer ${this.cfg.token}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.apiUrl.replace(/\/+$/, "")}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      ),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new ApiError(
        `API ${method} ${path} → ${resp.status}: ${text.slice(0, 500)}`,
        resp.status,
        text,
      );
    }
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  me(): Promise<MeOut> {
    return this.request<MeOut>("GET", "/auth/me");
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.request<ProjectSummary[]>("GET", "/projects");
  }

  listOrganizations(): Promise<
    Array<{
      id: string;
      slug: string;
      github_login: string | null;
      my_role: "admin" | "member";
      kind: "personal" | "team";
    }>
  > {
    return this.request("GET", "/organizations");
  }

  getProject(idOrSlug: string): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("GET", `/projects/${idOrSlug}`);
  }

  createCliProject(input: {
    name: string;
    slug?: string;
    framework_hint?: string;
    /** Target Layero organization. When unset, backend creates the
     * project in the caller's personal org. */
    organization_slug?: string;
  }): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("POST", "/projects", {
      name: input.name,
      slug: input.slug,
      source_type: "cli",
      framework_hint: input.framework_hint,
      organization_slug: input.organization_slug,
    });
  }

  initUpload(projectId: string): Promise<UploadInit> {
    return this.request<UploadInit>(
      "POST",
      `/projects/${projectId}/uploads`,
    );
  }

  finalizeUpload(
    projectId: string,
    input: { source_archive_key: string; commit_sha: string },
  ): Promise<void> {
    return this.request<void>(
      "POST",
      `/projects/${projectId}/uploads/finalize`,
      input,
    );
  }

  completeSetup(
    projectId: string,
    input: {
      framework_hint: string;
      build_cmd: string;
      output_dir: string;
      analytics_enabled: boolean;
      env_vars: Record<string, string>;
      // Monorepo subdir; empty / null → repo root.
      root_directory?: string | null;
    },
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/setup`,
      input,
    );
  }

  setRuntimeType(
    projectId: string,
    projectType: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web" | "spa",
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/runtime-type`,
      { project_type: projectType },
    );
  }

  updateProject(
    projectId: string,
    input: { root_directory?: string | null },
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "PATCH",
      `/projects/${projectId}`,
      input,
    );
  }

  triggerDeploy(
    projectId: string,
    input: {
      source_archive_key: string;
      commit_sha: string;
      commit_message?: string;
      framework_hint?: string;
      // 'preview' (default) or 'production'. Production replaces the apex
      // hostname's active deploy and requires user confirmation in the CLI.
      target?: "preview" | "production";
      // Explicit branch override; wins over `target`. For preview deploys
      // without a branch, the backend routes to the per-project "cli"
      // pseudo-branch.
      branch?: string;
      // `--prebuilt`: archive contains the already-built artifact (dist/
      // contents, not source tree). Builder skips detect/install/build.
      prebuilt?: boolean;
    },
  ): Promise<DeployOut> {
    return this.request<DeployOut>(
      "POST",
      `/projects/${projectId}/deploy`,
      input,
    );
  }

  // Edge/URL readiness for an environment. Used after a deploy reaches
  // `ready` to report the real public URL + a reachable preview link
  // instead of the management dashboard.
  probeEnvironment(environmentId: string): Promise<ProbeOut> {
    return this.request<ProbeOut>(
      "GET",
      `/environments/${environmentId}/probe`,
    );
  }

  pollLogs(deployId: string, afterId: number): Promise<LogsPollOut> {
    return this.request<LogsPollOut>(
      "GET",
      `/deploys/${deployId}/logs?after_id=${afterId}`,
    );
  }

  listProjectDeploys(
    projectId: string,
    branch?: string,
  ): Promise<DeployOut[]> {
    const qs = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    return this.request<DeployOut[]>(
      "GET",
      `/projects/${projectId}/deploys${qs}`,
    );
  }

  rollbackProject(
    projectId: string,
    input: { branch?: string; deploy_id?: string },
  ): Promise<DeployOut> {
    return this.request<DeployOut>(
      "POST",
      `/projects/${projectId}/rollback`,
      input,
    );
  }

  // V071 production-pointer: pin apex to a specific deploy. `source` is
  // recorded in promote_events and lets us split CLI vs UI adoption later.
  promoteDeploy(
    projectId: string,
    deployId: string,
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/promote`,
      { deploy_id: deployId, source: "cli" },
    );
  }

  // Clear projects.production_deploy_id — apex resumes following latest
  // ready deploy of default_branch (or sole-env, see V071 host_resolver).
  unpinProduction(projectId: string): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/unpin`,
    );
  }

  listDeployHooks(projectId: string): Promise<DeployHookOut[]> {
    return this.request<DeployHookOut[]>(
      "GET",
      `/projects/${projectId}/deploy-hooks`,
    );
  }

  createDeployHook(
    projectId: string,
    input: { name: string; branch?: string | null; target?: "preview" | "production" },
  ): Promise<DeployHookOut> {
    return this.request<DeployHookOut>(
      "POST",
      `/projects/${projectId}/deploy-hooks`,
      input,
    );
  }

  deleteDeployHook(projectId: string, hookId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/projects/${projectId}/deploy-hooks/${hookId}`,
    );
  }

  startDeviceAuth(): Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    poll_interval: number;
  }> {
    return this.request("POST", "/auth/cli/device");
  }

  pollDeviceAuth(device_code: string): Promise<{
    status: "pending" | "approved" | "expired";
    token?: string;
  }> {
    return this.request("POST", "/auth/cli/device/poll", { device_code });
  }

  setUsername(
    value: string,
  ): Promise<{ username: string; organization_slug: string }> {
    return this.request("POST", "/auth/me/username", { value });
  }

  checkUsername(
    value: string,
  ): Promise<{ available: boolean; normalized: string; reason: string | null }> {
    return this.request(
      "GET",
      `/auth/me/username/check?value=${encodeURIComponent(value)}`,
    );
  }
}

export async function uploadArchive(
  init: UploadInit,
  filePath: string,
): Promise<void> {
  const fs = await import("node:fs");
  const stat = await fs.promises.stat(filePath);
  // Use Node fetch with a stream body. Duplex 'half' is required when the
  // body is a stream — Node refuses otherwise.
  const stream = fs.createReadStream(filePath);
  const resp = await fetch(init.upload_url, {
    method: "PUT",
    headers: {
      ...init.headers,
      "Content-Length": String(stat.size),
    },
    // @ts-expect-error duplex is a Node-specific option for streamed bodies
    duplex: "half",
    body: stream as unknown as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `S3 PUT ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
}
