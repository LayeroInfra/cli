import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { detectProject } from "../detect.js";
import { emit, detectMode } from "../agent.js";

interface InitOptions {
  // When set, write/overwrite files without asking. Default in
  // non-interactive mode.
  yes?: boolean;
  // Skip the AGENTS.md / CLAUDE.md / .cursorrules updates.
  skipAgentDocs?: boolean;
}

const AGENT_BLOCK_MARKER_START = "<!-- layero:start -->";
const AGENT_BLOCK_MARKER_END = "<!-- layero:end -->";

function agentDocBlock(framework: string): string {
  return `${AGENT_BLOCK_MARKER_START}
## Deploying with Layero

This project deploys to Layero (https://layero.ru). To ship local changes:

\`\`\`bash
npx layero@latest deploy
\`\`\`

Detected framework: **${framework}**. No git repository or GitHub connection
is required — Layero packs and uploads the local directory directly.

### First-time auth (one-click device flow)

If you're not logged in yet, \`deploy\` (or \`login\`) starts the browser
device-flow automatically and emits a JSON line:

\`\`\`json
{"event":"auth_required","url":"https://app.layero.ru/cli?code=ABCD-1234","user_code":"ABCD-1234"}
\`\`\`

Render the \`url\` as a clickable link in chat. The user opens it, signs in
(GitHub or Yandex — Layero creates the account automatically on first OAuth),
clicks "Разрешить доступ", and the CLI's poll loop picks up the token within
2 seconds. No localhost server is involved — the browser can be on a
different machine than the CLI.

### JSON-lines events

When run inside an agent (\`CURSOR_AGENT\`, \`CLAUDECODE\`, or any non-TTY
stdout), the CLI auto-switches to JSON-lines. Key events to watch:

| event | meaning |
|---|---|
| \`auth_required\` | render \`url\` as a link, keep waiting |
| \`detected\` | framework auto-detection result |
| \`project_created\` / \`project_linked\` | project bound for this directory |
| \`build_log\` | forward only if it contains errors |
| \`ready\` | \`url\` = live public site (show to user, stop). \`dashboard_url\` = management page. |
| \`error\` | follow \`next_action\` field verbatim |

Common error codes and remediation:

- \`not_logged_in\` → run \`npx layero@latest login\`
- \`auth_expired\` / \`auth_timeout\` → user did not approve in time, re-run login
- \`invalid_type\` → drop \`--type\`, rely on auto-detect
- \`cli_deploys_disabled\` → user must enable CLI deploys in project settings
- \`deploy_failed\` / \`deploy_error\` → check the dashboard URL in the message

### Re-deploys and production

A plain \`npx layero deploy\` of a CLI project **publishes to the apex**
\`https://<project>.layero.app\` — direct uploads auto-promote, so you do
**not** need \`--prod\` or a separate \`promote\` step. Safe to run repeatedly;
each run replaces what the apex serves.

There is no separate per-deploy preview address: user sites live in the
\`layero.app\` zone, which has no preview sub-zone and no CDN in front, so the
apex is reachable the moment the deploy is ready.

Hand the user \`ready.url\` and stop — that address is live.

There is no way to publish without replacing the live site from the CLI:
\`--branch\` is accepted and **silently ignored** — archive uploads are always
filed under the reserved \`cli\` environment. If the user asks for a version
"just to look at" that leaves the live address alone, tell them it needs a
connected repository and a push to a branch. (\`--prod\` exists for
git-connected projects; for direct CLI uploads it's redundant.)

### Already built? Skip the server build

If the site is already built locally (e.g. a Next.js static export in \`out/\`,
or a \`dist/\`), ship the artifact directly and skip the server-side
\`npm install\` + build:

\`\`\`bash
npx layero@latest deploy --prebuilt out
\`\`\`

Full reference: https://docs.layero.ru/en/cli/agents
${AGENT_BLOCK_MARKER_END}
`;
}

async function upsertAgentDoc(
  cwd: string,
  filename: string,
  content: string,
): Promise<"created" | "updated" | "unchanged"> {
  const filePath = path.join(cwd, filename);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  if (existing === null) {
    await fs.writeFile(filePath, content, "utf-8");
    return "created";
  }

  // Already has our block — replace it in place so we can iterate
  // safely (re-running `layero init` updates the block, doesn't append).
  if (existing.includes(AGENT_BLOCK_MARKER_START)) {
    const start = existing.indexOf(AGENT_BLOCK_MARKER_START);
    const endMarker = existing.indexOf(AGENT_BLOCK_MARKER_END);
    if (endMarker === -1) {
      // Malformed — fall through to append.
      const merged = existing.trimEnd() + "\n\n" + content;
      await fs.writeFile(filePath, merged, "utf-8");
      return "updated";
    }
    const newBlock = content.trimEnd() + "\n";
    const merged =
      existing.slice(0, start) +
      newBlock +
      existing.slice(endMarker + AGENT_BLOCK_MARKER_END.length).replace(/^\n+/, "\n");
    if (merged === existing) return "unchanged";
    await fs.writeFile(filePath, merged, "utf-8");
    return "updated";
  }

  // Append our block to the existing file with a separating blank line.
  const merged = existing.trimEnd() + "\n\n" + content;
  await fs.writeFile(filePath, merged, "utf-8");
  return "updated";
}

async function ensureProjectJson(cwd: string, framework: string, build_cmd: string, output_dir: string): Promise<"created" | "unchanged"> {
  const dir = path.join(cwd, ".layero");
  const file = path.join(dir, "project.json");
  try {
    await fs.access(file);
    return "unchanged";
  } catch {
    // missing → create
  }
  await fs.mkdir(dir, { recursive: true });
  const scaffold = {
    framework_hint: framework,
    build_cmd,
    output_dir,
    analytics_enabled: false,
    env_vars: {},
  };
  await fs.writeFile(file, JSON.stringify(scaffold, null, 2) + "\n", "utf-8");
  return "created";
}

async function ensureGitignore(cwd: string): Promise<void> {
  const gi = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gi, "utf-8");
  } catch {
    return; // no .gitignore — leave alone, this is meant to be additive
  }
  // We only want to ignore the auth-state-bearing files. `project.json`
  // itself is safe to commit (project_id is not a secret).
  if (!content.includes(".layero/")) {
    const append = (content.endsWith("\n") ? "" : "\n") + "\n# Layero local state\n.layero/cache/\n";
    await fs.writeFile(gi, content + append, "utf-8");
  }
}

export async function initCmd(opts: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const mode = detectMode();
  const detected = await detectProject(cwd);

  emit({
    event: "detected",
    framework: detected.framework_hint,
    build_cmd: detected.build_cmd,
    output_dir: detected.output_dir,
    confident: detected.confident,
  });

  const block = agentDocBlock(detected.framework_hint);

  if (!opts.skipAgentDocs) {
    // Touch every agent-doc convention we know about. If one already
    // exists we update it in-place; otherwise we create only the most
    // common one (AGENTS.md, the cross-vendor convention) so we don't
    // litter the repo with .cursorrules / CLAUDE.md the user doesn't use.
    const candidates = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];
    const existing: string[] = [];
    for (const f of candidates) {
      try {
        await fs.access(path.join(cwd, f));
        existing.push(f);
      } catch {
        // not present
      }
    }
    const targets = existing.length > 0 ? existing : ["AGENTS.md"];
    for (const f of targets) {
      const result = await upsertAgentDoc(cwd, f, block);
      if (mode.interactive) {
        console.log(chalk.green(`  ${result === "created" ? "✓ created" : result === "updated" ? "✓ updated" : "= unchanged"} ${f}`));
      }
    }
  }

  const pjResult = await ensureProjectJson(
    cwd,
    detected.framework_hint,
    detected.build_cmd,
    detected.output_dir,
  );
  if (mode.interactive) {
    console.log(
      chalk.green(
        `  ${pjResult === "created" ? "✓ created" : "= unchanged"} .layero/project.json`,
      ),
    );
  }

  await ensureGitignore(cwd);

  if (mode.interactive) {
    console.log("");
    console.log(chalk.bold("Next:"));
    console.log("  $ npx layero login    # one-time, in your browser");
    console.log("  $ npx layero deploy   # ship the current directory");
  }
}
