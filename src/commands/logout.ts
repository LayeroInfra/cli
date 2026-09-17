import { clearConfig, configPath } from "../config.js";
import { emit } from "../agent.js";

export async function logoutCmd(): Promise<void> {
  await clearConfig();
  emit({ event: "logged_out", config_path: configPath() });
}
