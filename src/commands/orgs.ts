import chalk from "chalk";
import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";

/** `layero orgs list` — show every Layero organization the caller belongs to.
 *
 * Useful before `layero deploy --org=<slug>` so the user can see which
 * slugs to pass without leaving the terminal.
 */
export async function orgsListCmd(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) throw new Error("not logged in. run `layero login` first.");
  const api = new ApiClient(cfg);
  const orgs = await api.listOrganizations();
  if (orgs.length === 0) {
    console.log(chalk.dim("no organizations on this account."));
    return;
  }
  for (const o of orgs) {
    const kindBadge =
      o.kind === "personal" ? chalk.dim("personal") : chalk.cyan("team");
    const roleBadge = chalk.dim(`(${o.my_role})`);
    console.log(`  ${chalk.bold(o.slug.padEnd(20))} ${kindBadge}  ${roleBadge}`);
  }
}
