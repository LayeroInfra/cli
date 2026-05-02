import chalk from "chalk";
import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";

export async function projectsListCmd(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    console.error(chalk.yellow("not logged in. run `layero login` first."));
    process.exitCode = 1;
    return;
  }
  const api = new ApiClient(cfg);
  const list = await api.listProjects();
  if (list.length === 0) {
    console.log("no projects yet — `layero deploy` to create one.");
    return;
  }
  for (const p of list) {
    const tag = p.source_type === "cli" ? chalk.magenta("[cli]") : chalk.blue("[gh] ");
    console.log(
      `${tag} ${chalk.bold(p.slug)}  ${chalk.dim(p.id)}  https://${p.apex_hostname}`,
    );
  }
}
