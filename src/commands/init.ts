import { promises as fs } from "node:fs";
import path from "node:path";
import { detectProject } from "../detect.js";
import { emit } from "../agent.js";

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
  // Компактный индекс, а не ссылка на навык: по evals Vercel блок в
  // AGENTS.md агент выполняет надёжнее (100 % против 79 % у навыка).
  // Полная версия — навык `layero` в LayeroInfra/layero-agents; здесь —
  // то, без чего первый деплой не случится. Коды ошибок сверяет
  // `check-error-codes.py`: не перечислять здесь то, чего CLI не выдаёт.
  return `${AGENT_BLOCK_MARKER_START}
## Layero

This project deploys to Layero (https://layero.ru) — hosting with build servers
in Russia. Full agent skill: https://github.com/LayeroInfra/layero-agents
(\`npx skills add LayeroInfra/layero-agents\`, Claude Code:
\`claude plugin marketplace add LayeroInfra/layero-agents && claude plugin install layero@layero\`).
Docs for agents: https://docs.layero.ru/agents/

### Three paths — pick by situation

1. **Repository connected** (GitHub, GitVerse, GitLab, GitFlic, SourceCraft) —
   push to a branch = preview, push to \`main\` = production. Connect one with
   \`npx layero@latest projects create --repo <provider>:<owner/repo>\`.
2. **A directory with code** (this project, framework: **${framework}**) —
   \`npx layero@latest deploy --json\`. The CLI packs the directory, the
   platform builds it. No git repository is needed for this path.
3. **A site already on Layero** — \`npx layero@latest diagnose\`, \`logs\`,
   \`rollback\`, \`domains\`, \`env\`, \`envs list\`, or the MCP server
   \`https://mcp.layero.ru/mcp\`.

### Deploy from this directory

\`\`\`bash
npx layero@latest deploy --json
\`\`\`

Not logged in? The command starts the browser device flow itself and prints
\`{"event":"auth_required","url":"…","user_code":"…"}\` — show \`url\` as a
clickable link and keep waiting; the CLI polls every 2 s. No localhost
callback: the browser may be on another machine. In CI use
\`LAYERO_TOKEN=… npx layero@latest deploy --project <slug> --json --yes\`.
No account at all? \`npx layero@latest deploy --claim\` publishes to a
temporary project for 72 hours and prints a \`claim_url\` for a human to
take it over.

Key JSON events: \`detected\` (framework), \`project_created\` /
\`project_linked\`, \`build_log\` (forward only lines with errors),
\`claimable\` (\`claim_url\`, \`expires_at\`), \`ready\` — \`url\` is the live
site: show it as-is and stop; \`dashboard_url\` is the panel, not the site.
\`error\` — follow \`next_action\` verbatim.

Exit codes: 0 ok · 2 auth (\`auth_required\`, \`auth_expired\`, \`auth_timeout\`) ·
3 not found (\`project_unknown\`, \`project_not_found\`) · 4 invalid input
(\`invalid_type\`, \`prebuilt_no_dir\`, \`branch_unsupported\`) · 5 remote
(\`deploy_failed\`, \`internal\`). Codes \`not_logged_in\`, \`deploy_error\`,
\`deploy_timed_out\` do not exist — do not branch on them.

### Rules

- Re-running \`deploy\` is safe and reuses the project; no commit needed.
- A plain \`deploy\` of a CLI project **replaces the live site** at
  \`ready.url\`: direct uploads auto-promote. \`--branch\` is refused
  (\`branch_unsupported\`) — isolated previews come from pushing a branch of
  a connected repository, nothing else.
- Already built locally? \`npx layero@latest deploy --prebuilt <dir>\`.
- Never \`git init\` just to deploy, never \`npm install -g layero\`, never
  build the site address from a template — only \`ready.url\`.
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
  const detected = await detectProject(cwd);

  emit({
    event: "detected",
    framework: detected.framework_hint,
    build_cmd: detected.build_cmd,
    output_dir: detected.output_dir,
    confident: detected.confident,
  });

  const block = agentDocBlock(detected.framework_hint);
  const agentDocs: Array<{ file: string; result: "created" | "updated" | "unchanged" }> = [];

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
      agentDocs.push({ file: f, result });
    }
  }

  const pjResult = await ensureProjectJson(
    cwd,
    detected.framework_hint,
    detected.build_cmd,
    detected.output_dir,
  );
  await ensureGitignore(cwd);

  emit({
    event: "init_done",
    framework: detected.framework_hint,
    agent_docs: agentDocs,
    project_json: pjResult,
  });
}
