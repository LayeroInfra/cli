import chalk from "chalk";
import { ApiClient } from "../api.js";
import { loadConfig } from "../config.js";
import { persistProjectLinking } from "../project-config.js";

export async function linkCmd(idOrSlug: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    console.error(chalk.yellow("not logged in. run `layero login` first."));
    process.exitCode = 1;
    return;
  }
  const api = new ApiClient(cfg);
  // The backend accepts UUIDs only on /projects/{id}; for slug we fall back
  // to listing — this is fine because users typically have <100 projects.
  let proj;
  try {
    proj = await api.getProject(idOrSlug);
  } catch {
    const all = await api.listProjects();
    const match = all.find((p) => p.slug === idOrSlug);
    if (!match) {
      console.error(chalk.red(`no project with id/slug "${idOrSlug}"`));
      process.exitCode = 1;
      return;
    }
    proj = match;
  }
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
  console.log(
    chalk.green(`linked ${proj.slug} (${proj.id}) → ./.layero/project.json`),
  );
  if (proj.status === "pending_setup") {
    console.log(
      chalk.yellow(
        "  note: project is in pending_setup. finish the setup wizard in the dashboard, " +
          "or run `layero deploy` to upload source and get the wizard URL.",
      ),
    );
  }
}
