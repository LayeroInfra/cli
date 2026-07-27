import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";
import { ApiClient } from "../api.js";

export async function tokenSetCmd(jwt: string): Promise<void> {
  const cfg = await loadConfig();
  cfg.token = jwt.trim();
  // Probe /auth/me to validate the token before persisting.
  const probe = new ApiClient(cfg);
  try {
    const me = await probe.me();
    cfg.user = { id: me.id, username: me.username ?? null, email: me.email };
  } catch (err) {
    console.error(
      chalk.red(`token rejected by API: ${(err as Error).message}`),
    );
    process.exitCode = 1;
    return;
  }
  await saveConfig(cfg);
  console.log(
    chalk.green(
      `saved token for ${cfg.user?.username ?? cfg.user?.email ?? cfg.user?.id}`,
    ),
  );
  if (!cfg.user?.username) {
    console.log(
      chalk.yellow(
        "no username set — open https://app.layero.ru/onboarding to pick one " +
          "before `layero deploy`.",
      ),
    );
  }
}
