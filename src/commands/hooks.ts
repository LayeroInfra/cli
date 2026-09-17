import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, emit } from "../agent.js";

async function resolveProjectId(opts: { project?: string }): Promise<string> {
  if (opts.project) {
    // Принимает id напрямую; форма UUID проверяется на сервере.
    return opts.project;
  }
  const linked = await loadProjectConfig(process.cwd());
  if (linked?.project_id) {
    return linked.project_id;
  }
  throw new LayeroError(
    "project_unknown",
    "в этой папке нет привязанного проекта",
    "передайте --project <id> или запустите `layero deploy` из папки проекта, чтобы привязать её",
  );
}

async function makeClient(): Promise<ApiClient> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError(
      "auth_required",
      "вход не выполнен",
      "выполните `layero login` или задайте LAYERO_TOKEN",
    );
  }
  return new ApiClient(cfg);
}

export async function hooksListCmd(opts: { project?: string }): Promise<void> {
  const api = await makeClient();
  const projectId = await resolveProjectId(opts);
  const hooks = await api.listDeployHooks(projectId);
  emit({
    event: "hooks",
    project: projectId,
    hooks: hooks.map((h) => ({
      id: h.id,
      name: h.name,
      branch: h.branch,
      target: h.target,
      url: h.url,
      last_triggered_at: h.last_triggered_at,
    })),
  });
}

export async function hooksCreateCmd(
  name: string,
  opts: { project?: string; branch?: string; prod?: boolean },
): Promise<void> {
  if (!name || !name.trim()) {
    throw new LayeroError(
      "bad_format",
      "нужно имя хука",
      "`layero hooks create <имя>`",
    );
  }
  const api = await makeClient();
  const projectId = await resolveProjectId(opts);
  const hook = await api.createDeployHook(projectId, {
    name: name.trim(),
    branch: opts.branch ?? null,
    target: opts.prod ? "production" : "preview",
  });
  emit({
    event: "hook_created",
    project: projectId,
    id: hook.id,
    name: hook.name,
    branch: hook.branch,
    target: hook.target,
    url: hook.url,
  });
}

export async function hooksDeleteCmd(
  hookId: string,
  opts: { project?: string },
): Promise<void> {
  if (!hookId) {
    throw new LayeroError("bad_format", "нужен id хука", "`layero hooks delete <id>`");
  }
  const api = await makeClient();
  const projectId = await resolveProjectId(opts);
  try {
    await api.deleteDeployHook(projectId, hookId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "hook_not_found",
        `у проекта нет хука ${hookId} (уже удалён?)`,
        "`layero hooks list`",
      );
    }
    throw err;
  }
  emit({ event: "hook_deleted", project: projectId, id: hookId });
}
