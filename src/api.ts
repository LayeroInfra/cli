import { CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  apex_hostname: string;
  source_type: string;
  framework_hint: string | null;
  default_branch: string;
  owner: { id: string; github_login: string | null; slug: string };
  created_at: string;
  publish_status?: string;
  status?: "pending_setup" | "active";
}

export interface MeOut {
  id: string;
  github_login: string | null;
  owner_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface UploadInit {
  upload_url: string;
  source_archive_key: string;
  headers: Record<string, string>;
  expires_in: number;
}

export interface DeployOut {
  id: string;
  environment_id: string;
  status: string;
  commit_sha: string;
  current_stage: string | null;
  error_message: string | null;
}

export interface LogLine {
  id: number;
  stream: string;
  line: string;
  created_at: string;
}

export interface LogsPollOut {
  lines: LogLine[];
  status: string;
  error_message: string | null;
  s3_path: string | null;
  terminal: boolean;
  current_stage: string | null;
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

  getProject(idOrSlug: string): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("GET", `/projects/${idOrSlug}`);
  }

  createCliProject(input: {
    name: string;
    slug?: string;
    framework_hint?: string;
  }): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("POST", "/projects", {
      name: input.name,
      slug: input.slug,
      source_type: "cli",
      framework_hint: input.framework_hint,
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
    },
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/setup`,
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
    },
  ): Promise<DeployOut> {
    return this.request<DeployOut>(
      "POST",
      `/projects/${projectId}/deploy`,
      input,
    );
  }

  pollLogs(deployId: string, afterId: number): Promise<LogsPollOut> {
    return this.request<LogsPollOut>(
      "GET",
      `/deploys/${deployId}/logs?after_id=${afterId}`,
    );
  }

  setOwnerName(value: string): Promise<{ owner_name: string; owner_slug: string }> {
    return this.request("POST", "/me/owner", { value });
  }

  checkOwnerName(
    value: string,
  ): Promise<{ available: boolean; normalized: string; reason: string | null }> {
    return this.request(
      "GET",
      `/me/owner/check?value=${encodeURIComponent(value)}`,
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
