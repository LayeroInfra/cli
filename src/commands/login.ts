import { loadConfig } from "../config.js";
import { runDeviceLogin } from "../auth.js";

export async function loginCmd(_opts: Record<string, unknown>): Promise<void> {
  const cfg = await loadConfig();
  await runDeviceLogin(cfg);
}
