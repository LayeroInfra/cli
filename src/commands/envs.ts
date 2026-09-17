import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";
import { loadProjectConfig } from "../project-config.js";
import { LayeroError, emit } from "../agent.js";

/**
 * `layero envs list [--project]` — окружения проекта с адресами.
 *
 * Отдельной ручки «environments» в API нет: окружение и ветка — одна
 * сущность (`environments` в базе, `/projects/{id}/branches` наружу), и
 * список приходит оттуда. У CLI-проекта это одно окружение `cli`; у проекта
 * с репозиторием — ветка на окружение. Архивные и снятые с раздачи в список
 * не входят — так же, как в панели.
 */
export async function envsListCmd(opts: { project?: string; json?: boolean }): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError(
      "auth_required",
      "вход не выполнен",
      "выполните `layero login` или задайте LAYERO_TOKEN",
    );
  }
  const api = new ApiClient(cfg);
  let ref = opts.project;
  if (!ref) {
    const linked = await loadProjectConfig(process.cwd());
    ref = linked?.project_id;
  }
  if (!ref) {
    throw new LayeroError(
      "project_unknown",
      "в этой папке нет привязанного проекта",
      "запустите из папки проекта или передайте --project <id|slug>",
    );
  }
  const project = await api.resolveProject(ref);
  const branches = await api.listBranches(project.id);
  const productionBranch = project.production_branch_name ?? project.default_branch;
  emit({
    event: "environments",
    project: project.slug,
    environments: branches.map((b) => ({
      id: b.id,
      branch: b.branch_name,
      url: b.preview_url,
      hostname: b.hostname,
      active_deploy_id: b.active_deploy_id,
      active_deploy_at: b.active_deploy_at ?? null,
      production: b.branch_name === productionBranch,
    })),
  });
}
