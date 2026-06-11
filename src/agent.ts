// Agent / non-interactive mode detection + structured I/O.
//
// The CLI has historically assumed a human is watching. That breaks when
// Cursor / Claude Code / CI run `layero` as a tool: stdin/stdout aren't
// real TTYs, so any `readline.question` hangs forever and any ANSI escape
// in stderr leaks as `\x1b[36m` into the agent's transcript.
//
// Detection layers:
//   1. Explicit opt-in:  LAYERO_JSON=1  or  --json
//   2. Known agent envs: CURSOR_AGENT, CLAUDECODE, CLAUDE_CODE_*
//   3. CI envs:          CI, GITHUB_ACTIONS, GITLAB_CI, ...
//   4. No-TTY fallback:  !process.stdout.isTTY
//
// In agent/JSON mode:
//   * never prompt — every default is taken
//   * stdout becomes JSON-lines (`{"event":"...","..."}`)
//   * stderr stays plain text but without colour codes
//   * errors carry a machine-readable code + next_action

let cachedMode: AgentMode | null = null;

export interface AgentMode {
  agent: boolean;     // any non-human caller
  json: boolean;      // emit JSON-lines on stdout
  interactive: boolean; // safe to ask the user a question
  reason: string;     // why we picked this mode (for `--debug`)
}

const AGENT_ENV_VARS = [
  "LAYERO_JSON",
  "LAYERO_AGENT",
  "CURSOR_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION",
  "AIDER_CHAT",
  "CONTINUE_CLI",
];

const CI_ENV_VARS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI"];

export function detectMode(argv: string[] = process.argv): AgentMode {
  if (cachedMode) return cachedMode;

  const explicitJson = argv.includes("--json") || process.env.LAYERO_JSON === "1";
  if (explicitJson) {
    return (cachedMode = {
      agent: true,
      json: true,
      interactive: false,
      reason: "--json or LAYERO_JSON=1",
    });
  }

  const agentEnv = AGENT_ENV_VARS.find((k) => process.env[k] && process.env[k] !== "0");
  if (agentEnv) {
    return (cachedMode = {
      agent: true,
      json: true,
      interactive: false,
      reason: `env ${agentEnv}=${process.env[agentEnv]}`,
    });
  }

  const ciEnv = CI_ENV_VARS.find((k) => process.env[k] && process.env[k] !== "0");
  if (ciEnv) {
    return (cachedMode = {
      agent: true,
      // CI usually wants plain logs, not JSON-lines, unless the user opts in.
      // The `--yes` semantics still apply though.
      json: false,
      interactive: false,
      reason: `env ${ciEnv}=${process.env[ciEnv]}`,
    });
  }

  if (!process.stdout.isTTY) {
    return (cachedMode = {
      agent: true,
      json: false,
      interactive: false,
      reason: "stdout is not a TTY",
    });
  }

  return (cachedMode = {
    agent: false,
    json: false,
    interactive: true,
    reason: "interactive TTY",
  });
}

/** Force a specific mode. Used by tests; production code should rely on
 *  detectMode() reading the environment. */
export function setMode(mode: AgentMode): void {
  cachedMode = mode;
}

export interface EventCommon {
  ts?: string;
}

export type Event =
  | ({ event: "auth_required"; url: string; user_code: string } & EventCommon)
  | ({ event: "authorized"; user: string } & EventCommon)
  | ({ event: "project_created"; project_id: string; slug: string; organization: string } & EventCommon)
  | ({ event: "project_linked"; project_id: string; slug: string } & EventCommon)
  | ({ event: "detected"; framework: string; build_cmd: string; output_dir: string; confident: boolean; runtime_kind?: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web"; ssr_warning?: string } & EventCommon)
  | ({ event: "prebuilt"; dir: string } & EventCommon)
  | ({ event: "packing"; files: number; bytes: number; sha256: string; prebuilt_dir?: string } & EventCommon)
  | ({ event: "uploading" } & EventCommon)
  | ({ event: "uploaded"; archive_key: string } & EventCommon)
  | ({ event: "setup_applied" } & EventCommon)
  | ({ event: "runtime_type_applied"; project_type: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" } & EventCommon)
  | ({ event: "runtime_type_apply_failed"; error: string } & EventCommon)
  | ({ event: "deploy_started"; deploy_id: string } & EventCommon)
  | ({ event: "build_log"; line: string; stream: string } & EventCommon)
  | ({ event: "stage"; name: string } & EventCommon)
  | ({ event: "ready"; url: string; preview_url?: string; deploy_id: string } & EventCommon)
  | ({ event: "error"; code: string; next_action: string; message: string } & EventCommon);

export function emit(event: Event): void {
  const mode = detectMode();
  const stamped = { ...event, ts: new Date().toISOString() };
  if (mode.json) {
    process.stdout.write(JSON.stringify(stamped) + "\n");
    return;
  }
  renderHuman(event);
}

function renderHuman(event: Event): void {
  // We deliberately use plain text + arrow/check glyphs that survive in
  // every terminal we care about. Colours are layered on top via chalk
  // in deploy.ts / login.ts when the mode is interactive.
  switch (event.event) {
    case "auth_required":
      process.stdout.write(`→ Open ${event.url}\n`);
      process.stdout.write(`  (or enter the code ${event.user_code} after signing in)\n`);
      break;
    case "authorized":
      process.stdout.write(`✓ Authorized as ${event.user}\n`);
      break;
    case "project_created":
      process.stdout.write(`✓ Created project ${event.slug} (org: ${event.organization})\n`);
      break;
    case "project_linked":
      process.stdout.write(`→ Project ${event.slug}\n`);
      break;
    case "detected":
      process.stdout.write(
        event.runtime_kind
          ? `→ Detected ${event.runtime_kind} runtime app — will deploy as a scale-to-zero container\n`
          : `→ Detected ${event.framework} (build: ${event.build_cmd}, output: ${event.output_dir})\n`,
      );
      break;
    case "prebuilt":
      process.stdout.write(`→ Prebuilt mode: shipping ${event.dir}\n`);
      break;
    case "packing":
      process.stdout.write(
        `→ Packed ${event.files} files (${(event.bytes / (1024 * 1024)).toFixed(2)} MB)\n`,
      );
      break;
    case "uploading":
      process.stdout.write(`→ Uploading...\n`);
      break;
    case "uploaded":
      // intentionally quiet in human mode — the next stage line takes over
      break;
    case "setup_applied":
      process.stdout.write(`✓ Setup applied\n`);
      break;
    case "runtime_type_applied":
      process.stdout.write(`✓ Project type set to ${event.project_type}\n`);
      break;
    case "runtime_type_apply_failed":
      process.stdout.write(
        `! Failed to set project_type automatically: ${event.error}\n`,
      );
      process.stdout.write(
        `  Build may fail at detect; accept the suggestion in the dashboard if so.\n`,
      );
      break;
    case "deploy_started":
      process.stdout.write(`→ Building...\n`);
      break;
    case "stage":
      process.stdout.write(`  · ${event.name}\n`);
      break;
    case "build_log":
      process.stdout.write(`${event.line}\n`);
      break;
    case "ready":
      process.stdout.write(`✓ Live at ${event.url}\n`);
      break;
    case "error":
      process.stderr.write(`Error: ${event.code}\n`);
      process.stderr.write(`  ${event.message}\n`);
      if (event.next_action) {
        process.stderr.write(`  → ${event.next_action}\n`);
      }
      break;
  }
}

// Structured error carrying a machine-readable code and a one-line
// remediation hint. The CLI's top-level catch turns this into an
// `event: "error"` line in JSON mode and a coloured stderr block in
// human mode, then exits non-zero.
export class LayeroError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly next_action: string = "",
  ) {
    super(message);
    this.name = "LayeroError";
  }
}
