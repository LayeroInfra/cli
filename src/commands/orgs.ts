import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";
import { LayeroError, emit } from "../agent.js";

/** `layero orgs list` — организации аккаунта: личная и команды.
 *
 * Нужна перед `layero deploy --org=<slug>`, чтобы увидеть слаги, не выходя
 * из терминала.
 */
export async function orgsListCmd(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError(
      "auth_required",
      "вход не выполнен",
      "выполните `layero login` или задайте LAYERO_TOKEN",
    );
  }
  const api = new ApiClient(cfg);
  const orgs = await api.listOrganizations();
  emit({
    event: "organizations",
    organizations: orgs.map((o) => ({ id: o.id, slug: o.slug, kind: o.kind, role: o.my_role })),
  });
}
