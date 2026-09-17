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

/**
 * True when we're on a build runner.
 *
 * Deliberately NOT the same as `!detectMode().interactive`: an AI agent
 * (Cursor, Claude Code) is also non-interactive, but there the device-auth
 * flow is the documented happy path — the agent renders the link and a human
 * clicks it. On a runner nobody can click, so the same flow just hangs until
 * the code expires.
 */
export function isCiEnv(): boolean {
  return CI_ENV_VARS.some((k) => process.env[k] && process.env[k] !== "0");
}

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
  | ({ event: "username_set"; username: string; organization: string } & EventCommon)
  | ({ event: "project_created"; project_id: string; slug: string; organization: string; url?: string; repo?: string; branch?: string } & EventCommon)
  | ({ event: "project_linked"; project_id: string; slug: string; url?: string; status?: string } & EventCommon)
  | ({ event: "detected"; framework: string; build_cmd: string; output_dir: string; confident: boolean; runtime_kind?: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web"; ssr_warning?: string } & EventCommon)
  | ({ event: "prebuilt"; dir: string } & EventCommon)
  | ({ event: "packing"; files: number; bytes: number; sha256: string; prebuilt_dir?: string } & EventCommon)
  | ({ event: "uploading" } & EventCommon)
  | ({ event: "uploaded"; archive_key: string } & EventCommon)
  // У `projects create --repo` — с итогом детекта: что применили за человека.
  | ({ event: "setup_applied"; project?: string; framework?: string; build_cmd?: string | null; output_dir?: string | null; layero_found?: boolean } & EventCommon)
  // Проект создан, но мастер не завершён: по `--no-deploy` (pending) или
  // потому что детект/настройка/первая сборка не удались (failed). В обоих
  // случаях `url` — адрес мастера в панели, где человек доделает.
  | ({ event: "setup_pending"; project: string; url: string; hint: string } & EventCommon)
  | ({ event: "setup_failed"; project: string; reason: string; url: string; hint: string } & EventCommon)
  | ({ event: "runtime_type_applied"; project_type: "ssr_next" | "streamlit" | "gradio" | "flask" | "python_web" | "node_web" } & EventCommon)
  | ({ event: "runtime_type_apply_failed"; error: string } & EventCommon)
  // Стоп на повторяющейся ошибке (V224): подряд идущие сборки падают с одной
  // и той же причиной, и платформа отказывается выкатывать следующую вслепую.
  // Событие обязано нести САМ ТЕКСТ ошибки: агент, дошедший до десятого
  // повтора, её не читал — она приходит в конце длинного лога, а он смотрит
  // на код возврата. Здесь она первая и единственная.
  | ({
      event: "repeated_failure_guard";
      streak: number;
      threshold: number;
      // Чем набрана серия: "project" — отказами этого проекта, "owner" —
      // суммой по всем проектам владельца. Агенту это меняет вывод: во
      // втором случае новый проект правило не обходит.
      scope: "project" | "owner";
      failure_stage?: string;
      error?: string;
    } & EventCommon)
  // Этот деплой занял слот превью и снял с раздачи чужую ветку (V263).
  // Отдельным событием, а не полем в `ready`: агент, увидевший `ready`,
  // считает работу законченной и дальше не читает, а тут изменился ЧУЖОЙ
  // работающий адрес — про это он обязан узнать явно и до итога.
  | ({
      event: "preview_evicted";
      // Кого сняли. Обычно один, но при первом включении лимита проект
      // приводится к нему целиком.
      evicted: Array<{ branch?: string; hostname?: string }>;
      // Сколько превью проект раздаёт одновременно — чтобы агент не гадал,
      // почему это произошло, и мог сказать человеку число.
      limit?: number;
    } & EventCommon)
  | ({ event: "deploy_started"; deploy_id: string; project?: string; url?: string } & EventCommon)
  | ({ event: "build_log"; line: string; stream: string } & EventCommon)
  | ({ event: "stage"; name: string } & EventCommon)
  // Диагностика (AGENT-08). `build_log_excerpt` — ВЫЖИМКА вокруг фатальной
  // строки, а не хвост: платформа уже выбрала из лога значимое, и агенту не
  // нужно тянуть в контекст две тысячи строк ради одной.
  | ({
      event: "diagnosis";
      deploy_id: string;
      status: string | null;
      stage: string | null;
      verdict: string | null;
      build_log_excerpt: string[];
      build_error_found: boolean;
      runtime_log_excerpt: string[];
      runtime_error_found: boolean;
      runtime_state: string | null;
      next_actions: string[];
      truncated: boolean;
    } & EventCommon)
  // Ни значений, ни префиксов: только имена и длины. Всё, что попало в
  // вывод агента, оседает в истории переписки.
  | ({ event: "env_vars"; project: string; vars: Array<{ key: string; length: number }> } & EventCommon)
  // Единственное событие со ЗНАЧЕНИЯМИ, и это осознанно: адрес Data API и
  // публичный ключ уезжают в бандл фронтенда, то есть видны любому посетителю
  // сайта. Скрывать их от агента, который этот фронтенд и пишет, — обряд:
  // без них он не соберёт первый же запрос к базе. Секретного ключа здесь не
  // бывает никогда — платформа его не хранит.
  | ({ event: "data_env"; project: string; vars: Record<string, string> } & EventCommon)
  // Data API базы (T-20260911-9). В списке ключей — только префиксы. Значение
  // ключа есть в одном событии, `data_key_issued`, и ровно один раз: секретный
  // платформа не хранит, другого способа его узнать нет ни у кого.
  | ({
      event: "data_keys";
      org: string;
      database: string;
      keys: Array<{
        id: string;
        kind: "public" | "secret";
        prefix: string;
        label: string | null;
        created_at: string | null;
        last_used_at: string | null;
        expires_at: string | null;
        in_build: boolean;
        service: boolean;
      }>;
    } & EventCommon)
  | ({
      event: "data_key_issued";
      org: string;
      database: string;
      id: string;
      kind: "public" | "secret";
      prefix: string;
      key: string;
      expires_at: string | null;
    } & EventCommon)
  | ({ event: "data_key_revoked"; org: string; database: string; id: string } & EventCommon)
  | ({
      event: "data_origins";
      org: string;
      database: string;
      origins: Array<{ origin: string; note: string | null }>;
      from_projects: string[];
      localhost_allowed: boolean;
    } & EventCommon)
  | ({ event: "data_origin_added"; org: string; database: string; origin: string } & EventCommon)
  | ({ event: "data_origin_removed"; org: string; database: string; origin: string } & EventCommon)
  // `warnings` — почему у роли не работает ни одна таблица (право в схеме без USAGE на неё).
  | ({ event: "data_methods"; org: string; database: string; warnings: string[]; tables: unknown[]; functions: unknown[] } & EventCommon)
  // `applied: false` — показ: ничего не изменено. Без `--yes` вне терминала CLI
  // только показывает: агент обязан увидеть команды ДО того, как таблица
  // откроется интернету.
  | ({
      event: "data_grant";
      org: string;
      database: string;
      object: unknown;
      current: Record<string, string>;
      next: Record<string, string>;
      sql: string[];
      warnings: string[];
      applied: boolean;
      next_action?: string;
    } & EventCommon)
  | ({
      event: "data_api_enabled";
      org: string;
      database: string;
      slug: string;
      public_key: string | null;
      secret_key: string | null;
      // `true` — переприменение у базы с включённым API (`--repair`): права ролей на `public` сняты.
      reapplied: boolean;
    } & EventCommon)
  // Базы организации (DX-03). `database_created` несёт строку подключения:
  // пароль показывается ОДИН раз, и агенту он нужен ровно так же, как человеку.
  | ({ event: "token_created"; id: string; name: string; token: string; scopes: string[] } & EventCommon)
  | ({ event: "tokens"; tokens: unknown[] } & EventCommon)
  | ({ event: "token_revoked"; id: string } & EventCommon)
  | ({ event: "databases"; org: string; databases: unknown[] } & EventCommon)
  | ({
      event: "database_created";
      org: string;
      name: string;
      connection_string: string;
      password: string;
    } & EventCommon)
  | ({ event: "database_connected"; org: string; database: string; project: string } & EventCommon)
  | ({ event: "database_disconnected"; org: string; database: string; project: string } & EventCommon)
  | ({
      event: "query_result";
      database: string;
      columns: string[];
      rows: unknown[][];
      row_count: number;
      status: string | null;
      truncated: boolean;
      statements?: Array<{ sql: string; status: string | null; row_count: number }>;
    } & EventCommon)
  | ({ event: "env_set"; project: string; keys: string[]; total: number } & EventCommon)
  | ({ event: "env_unset"; project: string; keys: string[] } & EventCommon)
  | ({ event: "analytics_status"; connected: boolean; counter_id?: number; status: string; injection_mode: string; tracked_branch?: string } & EventCommon)
  // Между ссылкой и подключением стоит ЧЕЛОВЕК: OAuth Яндекса проходит в
  // браузере, и ни CLI, ни агент не сделают этот шаг за него.
  | ({ event: "analytics_connect_started"; oauth_url: string; next_action: string } & EventCommon)
  | ({ event: "analytics_stats"; period: string; state: string; totals: unknown; trend: string | null; sources: unknown[]; devices: unknown[]; pages: unknown[] } & EventCommon)
  | ({ event: "analytics_disconnected"; project: string } & EventCommon)
  | ({ event: "perf_check_started"; run_id: string; status: string | null; next_action: string } & EventCommon)
  // Вердикт по БАЛЛУ: тайминги на одном и том же коде гуляют на десятки
  // процентов, и решение по ним было бы случайным.
  | ({ event: "perf_check"; run_id: string; score: number | null; previous_score: number | null; delta: number | null; verdict: string; message: string; timings: unknown; significant_delta: number } & EventCommon)
  | ({ event: "domains"; project: string; domains: unknown[] } & EventCommon)
  // `domain_added` намеренно НЕ ждёт готовности: между ним и рабочим
  // доменом стоит человек, правящий DNS у регистратора.
  | ({ event: "domain_added"; domain: string; domain_id: string; ssl_status: string; records: unknown[]; next_action: string } & EventCommon)
  | ({ event: "domain_verified"; domain: string; verified: boolean; ssl_status: string; checks: unknown; next_check_at?: string; error?: string } & EventCommon)
  | ({ event: "domain_primary"; domain: string } & EventCommon)
  | ({ event: "domain_removed"; domain: string } & EventCommon)
  | ({ event: "build_logs"; status: string; lines: unknown[] } & EventCommon)
  | ({ event: "runtime_logs"; status: string; lines: unknown[] } & EventCommon)
  // `ready`:
  //   url           — the LIVE PUBLIC site (apex when published, else the
  //                    reachable preview host). NOT the dashboard. This is
  //                    the link to hand the user. (B3)
  //   preview_url   — a per-deploy preview host that is reachable *now* via
  //                    the VM-edge (NLB) wildcard cert, even while the apex's
  //                    YC-CDN cert/route is still propagating. (B4/B7)
  //   dashboard_url — the control-plane management page for the project.
  //   edge_ready    — true once the canonical (apex) host serves over CDN;
  //                    false while CDN propagation is still in flight.
  //   edge_eta_seconds — rough remaining CDN-warmup seconds when !edge_ready.
  | ({
      event: "ready";
      url: string;
      preview_url?: string;
      dashboard_url?: string;
      edge_ready?: boolean;
      edge_eta_seconds?: number;
      deploy_id: string;
    } & EventCommon)
  | ({ event: "promoted"; url: string; deploy_id: string } & EventCommon)
  // Проба метода Data API (T-20260911-9). Отказ шлюза — 401, 403, 404 — это
  // результат пробы и приходит этим событием с кодом выхода 0. `not_rolled_back`
  // — запись прошла, откат ждали, а шлюз его не подтвердил: следом придёт
  // `error` с кодом `data_probe_not_rolled_back`.
  | ({
      event: "data_probe";
      org: string;
      database: string;
      request: {
        method: string;
        path: string;
        as: string;
        user_id: string | null;
        query: Record<string, string>;
        schema: string | null;
      };
      status: number;
      elapsed_ms: number;
      caller: string | null;
      rows: number | null;
      total: number | null;
      owner_total: number | null;
      rollback_expected: boolean;
      rolled_back: boolean;
      not_rolled_back: boolean;
      body_truncated: boolean;
      headers: Record<string, string>;
      body: unknown;
    } & EventCommon)
  // --- Этап 6 (AX-аудит 17.09.2026): `--json` у всех команд. ------------
  // Команды без событий печатали человеку и молчали агенту: `whoami`,
  // `projects list`, `orgs list`, `link`, `hooks *`, `logout` отдавали
  // stdout строками с цветом, и агент разбирал их регулярками. Ниже —
  // события этих команд; человеку они рендерятся как раньше.
  | ({ event: "me"; id: string; username: string | null; email: string | null; github_login?: string | null } & EventCommon)
  | ({ event: "logged_out"; config_path: string } & EventCommon)
  | ({
      event: "projects";
      projects: Array<{
        id: string;
        slug: string;
        name: string;
        organization: string;
        url: string;
        source_type: string;
        repo: string | null;
        status: string;
      }>;
    } & EventCommon)
  | ({
      event: "organizations";
      organizations: Array<{ id: string; slug: string; kind: string; role: string }>;
    } & EventCommon)
  | ({
      event: "hooks";
      project: string;
      hooks: Array<{
        id: string;
        name: string;
        branch: string | null;
        target: string;
        url: string;
        last_triggered_at: string | null;
      }>;
    } & EventCommon)
  // Адрес хука — секрет: кто угодно с ним запускает сборку. Он показывается
  // при создании один раз, как ключ Data API; в списке он тоже есть, потому
  // что платформа его хранит и отдаёт — прятать его от владельца незачем.
  | ({ event: "hook_created"; project: string; id: string; name: string; branch: string | null; target: string; url: string } & EventCommon)
  | ({ event: "hook_deleted"; project: string; id: string } & EventCommon)
  | ({
      event: "init_done";
      framework: string;
      agent_docs: Array<{ file: string; result: "created" | "updated" | "unchanged" }>;
      project_json: "created" | "unchanged";
    } & EventCommon)
  // --- Источники кода (git-провайдеры) и окружения. -----------------------
  | ({
      event: "sources";
      org: string;
      providers: Array<{
        id: string;
        title: string;
        self_hosted: boolean;
        webhook_supported: boolean;
        token_hint: string | null;
      }>;
      connections: Array<{
        id: string;
        provider: string;
        account: string | null;
        status: string;
        projects_count: number;
        token_expiry_state: string;
        last_error: string | null;
      }>;
    } & EventCommon)
  | ({ event: "source_connected"; org: string; connection_id: string; provider: string; account: string | null } & EventCommon)
  | ({
      event: "source_repos";
      org: string;
      connection_id: string;
      repos: Array<{
        path: string;
        name: string;
        default_branch: string;
        private: boolean;
        can_admin: boolean;
        updated_at: string | null;
      }>;
    } & EventCommon)
  // Вебхук — отдельным событием, а не полем: без него пуш в репозиторий не
  // соберётся, и агент обязан сказать об этом человеку словами, а не
  // пропустить `false` в середине объекта.
  // `url` нет у GitHub App: там вебхук — часть установки, своего адреса у него нет.
  | ({ event: "webhook_installed"; project: string; url?: string } & EventCommon)
  | ({ event: "webhook_unavailable"; project: string; url: string; hint: string } & EventCommon)
  | ({
      event: "environments";
      project: string;
      environments: Array<{
        id: string;
        branch: string;
        url: string;
        hostname: string;
        active_deploy_id: string | null;
        active_deploy_at: string | null;
        production: boolean;
      }>;
    } & EventCommon)
  | ({ event: "project_deleted"; project_id: string; slug: string } & EventCommon)
  // --- Claimable (этап 13): сайт без аккаунта, человек забирает потом. -----
  | ({
      event: "claimable";
      project_id: string;
      slug: string;
      url: string;
      claim_url: string;
      expires_at: string;
    } & EventCommon)
  | ({
      event: "claim_status";
      code: string;
      status: string;
      claimed: boolean;
      expires_at: string | null;
      url: string | null;
      claim_url: string | null;
    } & EventCommon)
  | ({ event: "claim_accept"; code: string; claim_url: string; opened: boolean } & EventCommon)
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
    case "username_set":
      process.stdout.write(
        `✓ Имя аккаунта: ${event.username} (организация ${event.organization})\n`,
      );
      break;
    case "project_created":
      process.stdout.write(
        `✓ Created project ${event.slug} (org: ${event.organization})` +
          `${event.repo ? ` from ${event.repo}@${event.branch ?? "main"}` : ""}` +
          `${event.url ? ` → ${event.url}` : ""}\n`,
      );
      break;
    case "project_linked":
      process.stdout.write(`→ Project ${event.slug}${event.url ? `  ${event.url}` : ""}\n`);
      if (event.status === "pending_setup") {
        process.stdout.write(
          "  проект в pending_setup: `layero deploy` загрузит код и применит настройку\n",
        );
      }
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
      process.stdout.write(
        event.framework ? `✓ Setup applied (${event.framework})\n` : `✓ Setup applied\n`,
      );
      break;
    case "setup_pending":
      process.stdout.write(`· Проект ждёт настройки в панели: ${event.url}\n`);
      break;
    case "setup_failed":
      process.stdout.write(`! ${event.hint}\n  Причина: ${event.reason}\n`);
      break;
    case "preview_evicted": {
      // Предупреждение, а не отчёт: перестал отвечать адрес, который кому-то
      // уже отдали ссылкой. Пишем имя ветки — по нему её и возвращают.
      const names = event.evicted
        .map((e) => e.branch ?? e.hostname ?? "")
        .filter(Boolean)
        .join(", ");
      process.stdout.write(
        `! Превью ${names} приостановлено — этот деплой занял его место\n`,
      );
      process.stdout.write(`  Вернуть: задеплойте ту ветку снова или откройте панель\n`);
      break;
    }
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
    case "repeated_failure_guard":
      // В человеческом режиме подробности печатает сама команда: там они с
      // цветом, в stderr и с вопросом. Дублировать их здесь значило бы
      // показать одно и то же дважды.
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
      if (event.edge_ready === false) {
        // Built & published, but the CDN edge for the apex is still
        // propagating (first deploy of a new hostname can take a few
        // minutes on YC CDN). The preview host is reachable immediately.
        const eta =
          typeof event.edge_eta_seconds === "number" && event.edge_eta_seconds > 0
            ? ` (edge propagating, ~${event.edge_eta_seconds}s)`
            : " (edge propagating)";
        process.stdout.write(`✓ Built. Live at ${event.url}${eta}\n`);
        if (event.preview_url) {
          process.stdout.write(`  Reachable now: ${event.preview_url}\n`);
        }
      } else {
        process.stdout.write(`✓ Live at ${event.url}\n`);
      }
      break;
    case "promoted":
      process.stdout.write(`✓ Published apex → ${event.url}\n`);
      break;
    case "me":
      process.stdout.write(`id:       ${event.id}\n`);
      process.stdout.write(`username: ${event.username ?? "(не задано)"}\n`);
      process.stdout.write(`email:    ${event.email ?? "(нет)"}\n`);
      if (event.github_login) process.stdout.write(`github:   ${event.github_login}\n`);
      break;
    case "logged_out":
      process.stdout.write(`✓ Выход выполнен (удалён ${event.config_path})\n`);
      break;
    case "projects":
      if (event.projects.length === 0) {
        process.stdout.write("Проектов пока нет — `layero deploy` создаст первый.\n");
        break;
      }
      for (const p of event.projects) {
        const tag = p.source_type === "cli" ? "[cli]" : "[git]";
        process.stdout.write(`${tag} ${p.slug}  ${p.id}  ${p.url}\n`);
      }
      break;
    case "organizations":
      if (event.organizations.length === 0) {
        process.stdout.write("У аккаунта нет организаций.\n");
        break;
      }
      for (const o of event.organizations) {
        process.stdout.write(`  ${o.slug.padEnd(20)} ${o.kind}  (${o.role})\n`);
      }
      break;
    case "hooks":
      if (event.hooks.length === 0) {
        process.stdout.write("Хуков пока нет — `layero hooks create <имя>` заведёт первый.\n");
        break;
      }
      for (const h of event.hooks) {
        const last = h.last_triggered_at ? `срабатывал ${h.last_triggered_at}` : "не срабатывал";
        process.stdout.write(
          `[${h.target}] ${h.name}  branch=${h.branch ?? "default"}  (${last})\n` +
            `        ${h.id}\n        ${h.url}\n`,
        );
      }
      break;
    case "hook_created":
      process.stdout.write(`✓ Хук [${event.target}] ${event.name}\n  ${event.id}\n  ${event.url}\n`);
      process.stdout.write(
        "\n  Вставьте адрес в CMS / cron / внешний CI как POST-вебхук. " +
          "Любой, у кого он есть, запускает сборку — храните как секрет; " +
          "ротация: delete + create.\n",
      );
      break;
    case "hook_deleted":
      process.stdout.write(`✓ Хук ${event.id} отозван\n`);
      break;
    case "init_done":
      for (const d of event.agent_docs) {
        const mark = d.result === "created" ? "✓ создан" : d.result === "updated" ? "✓ обновлён" : "= без изменений";
        process.stdout.write(`  ${mark} ${d.file}\n`);
      }
      process.stdout.write(
        `  ${event.project_json === "created" ? "✓ создан" : "= без изменений"} .layero/project.json\n`,
      );
      process.stdout.write("\nДальше:\n  $ npx layero@latest login    # один раз, в браузере\n  $ npx layero@latest deploy   # выложить текущую папку\n");
      break;
    case "sources":
      process.stdout.write(`Провайдеры (${event.org}):\n`);
      for (const p of event.providers) {
        const flags = [p.self_hosted ? "свой инстанс" : null, p.webhook_supported ? null : "без вебхуков"]
          .filter(Boolean)
          .join(", ");
        process.stdout.write(`  ${p.id.padEnd(12)} ${p.title}${flags ? `  (${flags})` : ""}\n`);
      }
      process.stdout.write("Подключения:\n");
      if (event.connections.length === 0) {
        process.stdout.write("  нет — `layero sources connect <provider> --token-stdin`\n");
      }
      for (const c of event.connections) {
        process.stdout.write(
          `  ${c.id}  ${c.provider.padEnd(12)} ${c.account ?? "—"}  ${c.status}` +
            `  проектов: ${c.projects_count}${c.last_error ? `  ! ${c.last_error}` : ""}\n`,
        );
      }
      break;
    case "source_connected":
      process.stdout.write(
        `✓ Подключён ${event.provider}${event.account ? ` (${event.account})` : ""}: ${event.connection_id}\n`,
      );
      break;
    case "source_repos":
      if (event.repos.length === 0) {
        process.stdout.write("Токену не видно ни одного репозитория.\n");
        break;
      }
      for (const r of event.repos) {
        process.stdout.write(
          `  ${r.path.padEnd(40)} ${r.default_branch.padEnd(10)} ${r.private ? "private" : "public"}\n`,
        );
      }
      break;
    case "webhook_installed":
      process.stdout.write(`✓ Вебхук установлен — push в репозиторий запускает сборку\n`);
      break;
    case "webhook_unavailable":
      process.stdout.write(
        `! Вебхук не установлен: ${event.hint}\n  Адрес для ручной настройки: ${event.url}\n`,
      );
      break;
    case "environments":
      if (event.environments.length === 0) {
        process.stdout.write("Окружений пока нет — сначала `layero deploy` или push в репозиторий.\n");
        break;
      }
      for (const e of event.environments) {
        const mark = e.production ? "★" : " ";
        const when = e.active_deploy_at ? `  ${e.active_deploy_at}` : "  (нет активного деплоя)";
        process.stdout.write(`${mark} ${e.branch.padEnd(24)} ${e.url}${when}\n`);
      }
      break;
    case "project_deleted":
      process.stdout.write(`✓ Проект ${event.slug} удалён (очистка ресурсов идёт в фоне)\n`);
      break;
    case "claimable":
      process.stdout.write(`→ Временный проект ${event.slug}: ${event.url}\n`);
      process.stdout.write(`  Сайт живёт до ${event.expires_at} (72 часа). Забрать в аккаунт: ${event.claim_url}\n`);
      break;
    case "claim_status":
      process.stdout.write(
        `Код ${event.code}: ${event.status}${event.claimed ? " (забран)" : ""}` +
          `${event.expires_at ? `, действует до ${event.expires_at}` : ""}\n`,
      );
      if (event.url) process.stdout.write(`  сайт: ${event.url}\n`);
      if (event.claim_url && !event.claimed) process.stdout.write(`  забрать: ${event.claim_url}\n`);
      break;
    case "claim_accept":
      process.stdout.write(
        event.opened
          ? `→ Открыл ${event.claim_url} — подтвердите в панели\n`
          : `→ Откройте в браузере и подтвердите в панели: ${event.claim_url}\n`,
      );
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
