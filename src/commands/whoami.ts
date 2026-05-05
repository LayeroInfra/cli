import chalk from "chalk";
import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";

export async function whoamiCmd(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    console.error(chalk.yellow("not logged in. run `layero login` first."));
    process.exitCode = 1;
    return;
  }
  const api = new ApiClient(cfg);
  const me = await api.me();
  console.log(`id:     ${me.id}`);
  console.log(`owner:  ${me.owner_name ?? chalk.yellow("(not set)")}`);
  console.log(`email:  ${me.email ?? "(none)"}`);
  if (me.github_login) {
    console.log(`github: ${me.github_login}`);
  }
}
