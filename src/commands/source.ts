import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient, ApiError, DeployOut } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, emit } from "../agent.js";

/**
 * `layero source [deploy]` — скачать то, из чего собран деплой (T-20261108-4).
 *
 * Платформа отдаёт ZIP ровно с тем, что было загружено: исходники из
 * `layero deploy` или готовые файлы публикации. `.env*` в ZIP не попадают.
 * Без аргумента — деплой, который сейчас открывается на главном адресе
 * проекта, а если его нет — последний готовый.
 *
 * Деплой из репозитория скачать нельзя: исходники лежат в репозитории, и
 * платформа их не хранит. Тогда `source_in_repository` со ссылкой на коммит.
 */

interface SourceOptions {
  project?: string;
  out?: string;
  url?: boolean;
  force?: boolean;
}

function apiDetail(err: ApiError): { code?: string; message?: string; commit_url?: string | null } | string | undefined {
  try {
    return (JSON.parse(err.body) as { detail?: never }).detail;
  } catch {
    return undefined;
  }
}

async function resolveProject(api: ApiClient, ref: string | undefined, cwd: string) {
  const linked = await loadProjectConfig(cwd);
  const id = ref ?? linked?.project_id;
  if (!id) {
    throw new LayeroError(
      "project_unknown",
      "не понятно, чей деплой скачивать",
      "запусти из каталога проекта или передай --project <id|slug>",
    );
  }
  try {
    return await api.getProject(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "project_not_found",
        `нет проекта с id/slug "${id}"`,
        "посмотри список: layero projects list",
      );
    }
    throw err;
  }
}

export function pickDeploy(
  deploys: DeployOut[],
  arg: string | undefined,
  productionDeployId: string | null | undefined,
): DeployOut | undefined {
  if (arg) return deploys.find((d) => d.id === arg || d.commit_sha.startsWith(arg));
  if (productionDeployId) {
    const live = deploys.find((d) => d.id === productionDeployId);
    if (live) return live;
  }
  return deploys.find((d) => d.status === "ready");
}

export async function sourceCmd(deployArg: string | undefined, opts: SourceOptions): Promise<void> {
  const cliCfg = await loadConfig();
  if (!cliCfg.token) {
    throw new LayeroError("auth_required", "нужен вход", "выполни `layero login`");
  }
  const api = new ApiClient(cliCfg);
  const project = await resolveProject(api, opts.project, process.cwd());
  const deploys = await api.listAllProjectDeploys(project.id);
  const target = pickDeploy(deploys, deployArg, project.production_deploy_id);
  if (!target) {
    throw new LayeroError(
      deployArg ? "no_deploy" : "no_deploys",
      deployArg ? `нет деплоя "${deployArg}" среди последних ста` : `у проекта "${project.slug}" ещё нет готового деплоя`,
      "посмотри список: layero deploys list",
    );
  }

  let link: { url: string; filename: string; expires_in: number };
  try {
    link = await api.getDeploySource(project.id, target.id);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const detail = apiDetail(err);
    const code = typeof detail === "object" && detail ? detail.code : undefined;
    const text = typeof detail === "string" ? detail : detail?.message;
    if (code === "source_in_repository") {
      const commit = typeof detail === "object" ? detail?.commit_url : null;
      throw new LayeroError(
        "source_in_repository",
        "этот деплой собран из репозитория — исходники в нём, платформа их не хранит",
        commit ? `открой коммит: ${commit}` : "открой коммит в своём репозитории",
      );
    }
    if (code === "source_not_kept") {
      throw new LayeroError(
        "source_not_kept",
        text ?? "исходники этого деплоя удалены",
        "загрузи файлы заново: layero deploy",
      );
    }
    if (err.status === 403) {
      throw new LayeroError(
        "forbidden",
        "скачивать исходники могут участники проекта с правом деплоить",
        "попроси владельца проекта выдать роль editor",
      );
    }
    if (err.status === 429) {
      throw new LayeroError("rate_limited", text ?? "слишком много скачиваний за час", "попробуй через час");
    }
    throw err;
  }

  if (opts.url) {
    emit({ event: "source_link", deploy_id: target.id, ...link });
    return;
  }

  const dest = path.resolve(opts.out ?? link.filename);
  if (!opts.force) {
    const exists = await fs.stat(dest).then(() => true, () => false);
    if (exists) {
      throw new LayeroError(
        "file_exists",
        `файл ${dest} уже есть`,
        "передай --out <путь> или --force, чтобы перезаписать",
      );
    }
  }
  const resp = await fetch(link.url);
  if (!resp.ok) {
    throw new LayeroError(
      "storage_refused",
      `хранилище не отдало файл (HTTP ${resp.status})`,
      "повтори команду: ссылка выдаётся заново",
    );
  }
  const data = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(dest, data);
  emit({ event: "source_downloaded", deploy_id: target.id, path: dest, bytes: data.length });
}
