import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";
import { persistProjectLinking } from "../project-config.js";
import { LayeroError, emit } from "../agent.js";

export async function linkCmd(idOrSlug: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError(
      "auth_required",
      "вход не выполнен",
      "выполните `layero login` или задайте LAYERO_TOKEN",
    );
  }
  const api = new ApiClient(cfg);
  // Слаг или id — различает клиент по форме значения (`resolveProject`):
  // UUID, ушедший в поиск по слагу, не нашёлся бы.
  const proj = await api.resolveProject(idOrSlug);
  await persistProjectLinking(
    process.cwd(),
    {
      project_id: proj.id,
      slug: proj.slug,
      organization_slug: proj.organization.slug,
      apex_hostname: proj.apex_hostname,
    },
    proj.framework_hint ?? null,
  );
  emit({
    event: "project_linked",
    project_id: proj.id,
    slug: proj.slug,
    url: `https://${proj.apex_hostname}`,
    status: proj.status,
  });
}
