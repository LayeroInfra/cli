import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";
import { LayeroError, emit } from "../agent.js";

export async function whoamiCmd(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError(
      "auth_required",
      "вход не выполнен",
      "выполните `layero login` или задайте LAYERO_TOKEN",
    );
  }
  const api = new ApiClient(cfg);
  const me = await api.me();
  emit({
    event: "me",
    id: me.id,
    username: me.username ?? null,
    email: me.email ?? null,
    github_login: me.github_login ?? null,
  });
}
