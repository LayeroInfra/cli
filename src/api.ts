import { LayeroError } from "./agent.js";
import { CliConfig } from "./config.js";
import { CLI_VERSION, userAgent } from "./version.js";
import type { components } from "./generated/api-types.js";
import { looksLikeId } from "./project-ref.js";

/**
 * Типы ответов API берутся из СГЕНЕРИРОВАННОЙ схемы (AGENT-03), а не
 * описываются руками. Раньше здесь лежало ~200 строк интерфейсов, которые
 * синхронизировались с бэкендом глазами: поле, переименованное на сервере,
 * оставалось прежним в этом файле, TypeScript продолжал компилироваться, и
 * расхождение всплывало уже у пользователя.
 *
 * `scripts/gen-sdk.sh` перегенерирует файл, а CI падает, если он разошёлся
 * со схемой.
 */
type Schemas = components["schemas"];

export type ProjectSummary = Schemas["ProjectOut"];

/** Типы, которые платформа ЗАПУСКАЕТ, плюс `spa` — то, что она раздаёт. */
export type RuntimeKind =
  | "ssr_next"
  | "streamlit"
  | "gradio"
  | "flask"
  | "python_web"
  | "node_web"
  | "spa";
export type MeOut = Schemas["MeOut"];

/** Ключ Data API в списке. Значения здесь нет и быть не может — только префикс. */
export interface DataApiKey {
  id: string;
  key_prefix: string;
  is_public: boolean;
  label?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  expires_at?: string | null;
  in_build?: boolean;
  is_service?: boolean;
}

export interface DataApiMethods {
  roles: Record<string, string>;
  /** Почему у роли не работает ни одна таблица: право в схеме без USAGE на неё. */
  warnings?: string[];
  tables: Array<{
    schema: string;
    name: string;
    kind: "table" | "view";
    rls: boolean | null;
    path: string;
    /** Схема для заголовка профиля, когда путь без него ведёт на другую таблицу. */
    profile?: string | null;
    shadowed_by?: string | null;
    levels: Record<string, string>;
    writable: string[];
  }>;
  functions: Array<{
    schema: string;
    name: string;
    args: string;
    signature: string;
    kind?: "function" | "procedure";
    path: string | null;
    /** Адрес ведёт на другую функцию/процедуру: "схема.имя" вызываемой вместо этой. */
    shadowed_by?: string | null;
    /** В схеме api есть одноимённая функция или процедура: шлюз ищет по имени. */
    overloaded?: boolean;
    level: string;
    public_only: boolean;
  }>;
}

/** Показ или итог смены уровня: команды собирает сервер (`userdb_api_levels`). */
export interface DataApiLevelsPlan {
  object: { kind: "table" | "view" | "function" | "procedure"; schema: string; name: string; args?: string };
  current: Record<string, string>;
  next: Record<string, string>;
  sql: string[];
  warnings: string[];
  /** Причины, по которым применения не будет: сервер откажет. Входят и в `warnings`. */
  blocked?: string[];
  /** Поменяют ли команды права в базе. Нет поля — старый сервер: считать, что поменяют. */
  changes?: boolean;
  applied: boolean;
}
export type UploadInit = Schemas["UploadInitOut"];
export type DeployOut = Schemas["DeployOut"];
export type ProjectDetectOut = Schemas["ProjectDetectOut"];
export type ProjectSetupIn = Schemas["ProjectSetup"];
export type ProbeOut = Schemas["ProbeOut"];
export type LogsPollOut = Schemas["DeployLogsPollOut"];
export type DeploySessionOut = Schemas["DeploySessionOut"];
export type DeploySessionStatusOut = Schemas["DeploySessionStatusOut"];
export type DeployDiagnosisOut = Schemas["DeployDiagnosisOut"];
export type RuntimeLogsOut = Schemas["RuntimeLogsOut"];
export type DomainOut = Schemas["DomainOut"];
export type DomainInstructionsOut = Schemas["DomainInstructionsOut"];
export type PerfCheckOut = Schemas["PerfCheckOut"];
export type MetrikaIntegrationOut = Schemas["MetrikaIntegrationOut"];
export type EnvVarOut = Schemas["EnvVarOut"];
export type BranchOut = Schemas["BranchOut"];
export type SourceProviderOut = Schemas["SourceProviderOut"];
export type SourceConnectionOut = Schemas["SourceConnectionOut"];
export type SourceRepoOut = Schemas["SourceRepoOut"];
export type ImportAccountOut = Schemas["ImportAccountOut"];
export type ImportRepoOut = Schemas["ImportRepoOut"];
export type ConnectSourceOut = Schemas["ConnectSourceOut"];
export type ProjectDeleteOut = Schemas["ProjectDeleteOut"];

/**
 * Claimable-проект (этап 13 AX-аудита): сайт без аккаунта, человек забирает
 * потом. Контракт согласован с бэкендом (`/claimable/*`); в схеме его ещё
 * нет, поэтому форма описана здесь и ПРОВЕРЯЕТСЯ живым прогоном при выкатке.
 */
export interface ClaimableProjectOut {
  project_id: string;
  slug: string;
  organization: string;
  claim_url: string;
  token: string;
  expires_at: string;
  /** Код заявки; если сервер его не прислал — берётся из `claim_url`. */
  claim_code?: string;
  /** Адрес сайта; если не прислан — `https://<slug>.layero.app` не выдумываем, ждём `ready`. */
  url?: string;
  /** Обёртка панели `<панель>/preview/<метка>` — ссылка «для людей». */
  preview_url?: string;
}

export interface ClaimStatusOut {
  status: string;
  claimed?: boolean;
  expires_at?: string | null;
  url?: string | null;
  claim_url?: string | null;
  slug?: string | null;
}


/**
 * Ответ пробы метода через шлюз (T-20260911-1). У ручки нет модели ответа в
 * схеме, поэтому форма описана здесь — та же, что у панели (`ProbeHttpResult`).
 */
export interface DataApiProbe {
  status: number;
  elapsed_ms: number;
  headers: Record<string, string>;
  /** JSON ответа; строка — не JSON или обрезано. */
  body: unknown;
  /** Ответ длиннее 64 КБ — в `body` только его начало. */
  body_truncated: boolean;
  /** Кем шлюз посчитал запрос (`x-layero-caller`); `null` — ключ или токен не приняты. */
  caller: string | null;
  rows: number | null;
  /** Строк, видимых роли, — из `Content-Range`. */
  total: number | null;
  /** Строк в таблице у владельца — знаменатель «N из M». `null` — не посчиталось. */
  owner_total: number | null;
  /** Шлюз подтвердил откат (`x-layero-rolled-back`). */
  rolled_back: boolean;
  /** Откат ожидался — у всего, кроме `/whoami`. */
  rollback_expected: boolean;
}

// Один опрос логов отвечает за доли секунды. 30 с — заведомо «запрос завис»,
// а не «сборка идёт долго»: длительность сборки на ответ этой ручки не влияет.
export const POLL_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}


export interface DatabaseSummary {
  id: string;
  name: string;
  provider: string;
  status: string;
  db_name: string;
  name_slug: string | null;
  api_enabled: boolean;
  projects_count: number;
  quota_bytes: number;
  size_bytes: number | null;
  /** Где живёт база: общий шард, выделенный инстанс или чужой сервер.
   *  🚨 Поле сервер отдаёт давно, а CLI его не читал — по выводу нельзя было
   *  отличить базу из тарифа от инстанса за 7750 ₽ в месяц. */
  placement?: "sandbox" | "dedicated" | "external" | null;
  /** Мажор Postgres. `null` — узел не спрашивали или он молчит: показываем
   *  прочерк, а не выдумываем число. */
  pg_version?: number | null;
  /** Состояние оплаты платного инстанса. `null` — платить не за что.
   *
   *  🚨 У ВЫДЕЛЕННОГО ИНСТАНСА ЕСТЬ СРОК, И МОЛЧАТЬ О НЁМ ИЗ ТЕРМИНАЛА НЕЛЬЗЯ.
   *  `layero db list` показывал платную базу неотличимо от бесплатной, а у
   *  неё через несколько дней закрывается доступ. Человек, живущий в
   *  терминале, узнавал бы об этом по неработающей базе. */
  billing?: {
    status: string;
    price_month_kopecks: number;
    paid_until?: string | null;
    next_charge_at?: string | null;
    terminate_at?: string | null;
  } | null;
}

export interface DeployHookOut {
  id: string;
  name: string;
  branch: string | null;
  target: "preview" | "production";
  url: string;
  created_at: string;
  last_triggered_at: string | null;
}

export interface LogLine {
  id: number;
  stream: string;
  line: string;
  created_at: string;
}


export class ApiClient {
  constructor(private readonly cfg: CliConfig) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.cfg.token) {
      h.Authorization = `Bearer ${this.cfg.token}`;
    }
    // Версия — в КАЖДОМ запросе, а не только в деплое: иначе доля старых
    // сборок в поле остаётся неизмеримой (02.08.2026 — так и было).
    // Отдельный заголовок рядом с User-Agent, потому что UA по дороге может
    // переписать прокси или корпоративный шлюз, а этот — нет.
    h["User-Agent"] = userAgent();
    h["X-Layero-Cli-Version"] = CLI_VERSION;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    // Потолок ожидания ответа. По умолчанию его нет: загрузка архива и
    // длинные ручки живут дольше любого разумного числа. Задаётся там, где
    // запрос короткий и повторяемый (опрос логов сборки).
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.cfg.apiUrl.replace(/\/+$/, "")}${path}`;
    const init: RequestInit = {
      method,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      headers: this.headers(
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      ),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new ApiError(
        `API ${method} ${path} → ${resp.status}: ${text.slice(0, 500)}`,
        resp.status,
        text,
      );
    }
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  me(): Promise<MeOut> {
    return this.request<MeOut>("GET", "/auth/me");
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.request<ProjectSummary[]>("GET", "/projects");
  }

  listOrganizations(): Promise<
    Array<{
      id: string;
      slug: string;
      github_login: string | null;
      my_role: "admin" | "member";
      kind: "personal" | "team";
    }>
  > {
    return this.request("GET", "/organizations");
  }

  getProject(idOrSlug: string): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("GET", `/projects/${idOrSlug}`);
  }

  /**
   * Проект по идентификатору ИЛИ по слагу — так, как обещают справки команд.
   *
   * 🚨 РЕЗОЛВ ЖИВЁТ ЗДЕСЬ, А НЕ НА СЕРВЕРЕ, и это не лень. Слаг проекта
   * уникален В ПРЕДЕЛАХ ОРГАНИЗАЦИИ (`projects_owner_slug_uniq` — пара
   * organization_id + slug), то есть один и тот же слаг законно существует у
   * двух организаций сразу. Ручка `/projects/{id}` организации не знает и
   * выбирать между ними не имеет права; клиент знает, за кого он ходит.
   *
   * Отличаем по ФОРМЕ значения: UUID, ушедший в поиск по слагу, не нашёлся бы.
   * Раньше отличия не было вовсе — слаг уезжал в путь как есть, и ручка
   * отвечала 422 `uuid_parsing`, а CLI показывал его как «internal, сообщите
   * об ошибке» (T-20260909-32).
   */
  async resolveProject(idOrSlug: string): Promise<ProjectSummary> {
    if (looksLikeId(idOrSlug)) return this.getProject(idOrSlug);
    const projects = await this.listProjects();
    const found = projects.find((p) => p.slug === idOrSlug);
    if (!found) {
      const known = projects.map((p) => p.slug).slice(0, 8).join(", ");
      throw new LayeroError(
        "project_unknown",
        `проекта «${idOrSlug}» нет среди доступных`,
        known ? `есть такие: ${known}` : "заведите проект: layero deploy",
      );
    }
    return found;
  }

  createCliProject(input: {
    name: string;
    slug?: string;
    framework_hint?: string;
    /** Target Layero organization. When unset, backend creates the
     * project in the caller's personal org. */
    organization_slug?: string;
  }): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("POST", "/projects", {
      name: input.name,
      slug: input.slug,
      source_type: "cli",
      framework_hint: input.framework_hint,
      organization_slug: input.organization_slug,
    });
  }

  /**
   * Открыть сессию деплоя (AGENT-01/04).
   *
   * Один вызов вместо пяти: платформа сама решает, создавать ли проект,
   * применяет настройку и выдаёт адрес для загрузки архива. `commit_sha`
   * здесь не передаём — он известен только после упаковки, а паковать до
   * проверки прав значит зря жечь время пользователя на отказе.
   */
  createDeploySession(input: {
    project_id?: string;
    name?: string;
    organization_slug?: string;
    reuse_existing?: boolean;
    create_if_missing?: boolean;
    target?: "preview" | "production";
    branch?: string;
    promote?: boolean;
    prebuilt?: boolean;
    // null — «не задано»: решит сборщик по архиву (см. deploy.ts).
    framework_hint?: string | null;
    build_cmd?: string | null;
    output_dir?: string | null;
    runtime_kind?: string;
    // Кто назвал тип: `user` (флаг) или `detected` (догадка CLI).
    runtime_kind_origin?: "user" | "detected";
    root_directory?: string | null;
    env_vars?: Record<string, string>;
    commit_message?: string;
  }): Promise<DeploySessionOut> {
    return this.request<DeploySessionOut>("POST", "/deploy-sessions", input);
  }

  startDeploySession(
    sessionId: string,
    input: { commit_sha: string; confirm_repeated_failure?: boolean },
  ): Promise<DeploySessionStatusOut> {
    return this.request<DeploySessionStatusOut>(
      "POST",
      `/deploy-sessions/${sessionId}/start`,
      input,
    );
  }

  initUpload(projectId: string): Promise<UploadInit> {
    return this.request<UploadInit>(
      "POST",
      `/projects/${projectId}/uploads`,
    );
  }

  finalizeUpload(
    projectId: string,
    input: { source_archive_key: string; commit_sha: string },
  ): Promise<void> {
    return this.request<void>(
      "POST",
      `/projects/${projectId}/uploads/finalize`,
      input,
    );
  }

  completeSetup(
    projectId: string,
    input: {
      framework_hint: string;
      build_cmd: string;
      output_dir: string;
      analytics_enabled: boolean;
      env_vars: Record<string, string>;
      // Monorepo subdir; empty / null → repo root.
      root_directory?: string | null;
    },
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/setup`,
      input,
    );
  }

  /**
   * Сменить тип проекта.
   *
   * `force` — записать вопреки возражению платформы (409). Владелец имеет на
   * это право: детект ошибается, и репозиторий, который эвристика считает «не
   * бэкендом», прекрасно работает одним сервисом.
   */
  setRuntimeType(
    projectId: string,
    projectType: RuntimeKind,
    force = false,
    // Кто назвал тип: `user` — человек (`--type`), `platform` — детект. Тип от
    // детекта сборщик вправе уточнить по архиву; выбор человека — нет.
    origin: "user" | "platform" = "user",
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/runtime-type`,
      { project_type: projectType, force, origin },
    );
  }

  updateProject(
    projectId: string,
    input: { root_directory?: string | null },
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "PATCH",
      `/projects/${projectId}`,
      input,
    );
  }

  triggerDeploy(
    projectId: string,
    input: {
      source_archive_key: string;
      commit_sha: string;
      commit_message?: string;
      framework_hint?: string;
      // 'preview' (default) or 'production'. Production replaces the apex
      // hostname's active deploy and requires user confirmation in the CLI.
      target?: "preview" | "production";
      // Explicit branch override; wins over `target`. For preview deploys
      // without a branch, the backend routes to the per-project "cli"
      // pseudo-branch.
      branch?: string;
      // `--prebuilt`: archive contains the already-built artifact (dist/
      // contents, not source tree). Builder skips detect/install/build.
      prebuilt?: boolean;
    },
  ): Promise<DeployOut> {
    return this.request<DeployOut>(
      "POST",
      `/projects/${projectId}/deploy`,
      input,
    );
  }

  // Edge/URL readiness for an environment. Used after a deploy reaches
  // `ready` to report the real public URL + a reachable preview link
  // instead of the management dashboard.
  probeEnvironment(environmentId: string): Promise<ProbeOut> {
    return this.request<ProbeOut>(
      "GET",
      `/environments/${environmentId}/probe`,
    );
  }

  /** Одна сборка. Нужна, чтобы узнать её окружение для probe. */
  getDeploy(deployId: string): Promise<DeployOut> {
    return this.request<DeployOut>("GET", `/deploys/${deployId}`);
  }

  /**
   * Диагностика деплоя (AGENT-07): разобранная причина + окрестность
   * ошибки. Не сырой лог — платформа уже выбрала из него значимое.
   */
  getDeployDiagnosis(deployId: string): Promise<DeployDiagnosisOut> {
    return this.request<DeployDiagnosisOut>("GET", `/deploys/${deployId}/diagnosis`);
  }

  getRuntimeLogs(deployId: string, tail = 100): Promise<RuntimeLogsOut> {
    return this.request<RuntimeLogsOut>(
      "GET",
      `/deploys/${deployId}/runtime/logs?tail=${tail}`,
    );
  }

  // --- Переменные окружения (AGENT-13) --------------------------------

  /**
   * Платформа отдаёт маску, длину и короткий префикс — plaintext не
   * возвращается ни при каких условиях.
   */
  listEnvVars(projectId: string): Promise<EnvVarOut[]> {
    return this.request<EnvVarOut[]>("GET", `/projects/${projectId}/env`);
  }

  /**
   * Адрес и ПУБЛИЧНЫЙ ключ Data API — те же, что платформа кладёт в сборку.
   *
   * Единственное место, где значение приезжает открытым, и это не исключение
   * из правила выше, а другая природа: публичный ключ уезжает в бандл и виден
   * любому посетителю сайта. Секретного здесь не бывает.
   */
  // ── Базы организации (DX-03) ──────────────────────────────────────────
  //
  // 🚨 Заведено потому, что базу нельзя было создать ничем, кроме панели: у
  // CLI была одна команда `data env` — показать ключ УЖЕ существующей базы.
  // Адрес ручки и форму тела приходилось читать в исходниках платформы.

  listDatabases(org: string): Promise<DatabaseSummary[]> {
    return this.request<DatabaseSummary[]>("GET", `/organizations/${org}/databases`);
  }

  createDatabase(
    org: string,
    input: {
      name: string;
      quota_gb?: number;
      extensions?: string[];
      /** Накатывать ли стартовое наполнение: таблицы, роли, функция, политики.
       *  Сервер по умолчанию накатывает — CLI обязан уметь отказаться, иначе
       *  человек получает чужую схему в свою базу и молча. */
      preset?: boolean;
    },
  ): Promise<{ connection_string: string; password: string }> {
    return this.request("POST", `/organizations/${org}/databases`, {
      name: input.name,
      quota_gb: input.quota_gb ?? null,
      extensions: input.extensions ?? [],
      preset: input.preset ?? true,
    });
  }

  connectDatabaseToProject(
    org: string,
    dbId: string,
    projectId: string,
  ): Promise<unknown> {
    return this.request("POST", `/organizations/${org}/databases/${dbId}/projects`, {
      project_id: projectId,
    });
  }

  /** Отвязать проект от базы. Роль проекта при этом удаляется, а переменная
   *  уходит из его окружения — не сразу, а следующим деплоем. */
  disconnectDatabaseFromProject(
    org: string,
    dbId: string,
    projectId: string,
  ): Promise<unknown> {
    return this.request(
      "DELETE",
      `/organizations/${org}/databases/${dbId}/projects/${projectId}`,
    );
  }

  queryDatabase(
    org: string,
    dbId: string,
    sql: string,
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    row_count: number;
    status: string | null;
    truncated: boolean;
    statements?: Array<{ sql: string; status: string | null; row_count: number }>;
  }> {
    return this.request("POST", `/organizations/${org}/databases/${dbId}/query`, {
      sql,
      read_only: false,
    });
  }

  // ── Долгоживущие токены для CI (DX-02) ────────────────────────────────
  //
  // 🚨 Заведено потому, что неинтерактивного пути входа у CLI не было вовсе.
  // `layero login` требует человека с браузером, а единственной подсказкой
  // была команда `token set <jwt>` с подписью «пока login не доделан» — то
  // есть «раздобудьте токен где-нибудь ещё». В CI на этом месте вставали
  // насмерть. Ручка на сервере существовала с AGENT-02, у CLI её не было.

  createApiToken(input: {
    name: string;
    scopes?: Array<"read" | "deploy" | "admin">;
  }): Promise<{ id: string; name: string; token: string; scopes: string[]; hint: string }> {
    return this.request("POST", "/auth/tokens", {
      name: input.name,
      scopes: input.scopes ?? null,
    });
  }

  listApiTokens(): Promise<
    Array<{
      id: string;
      name: string;
      hint: string;
      scopes: string[];
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
    }>
  > {
    return this.request("GET", "/auth/tokens");
  }

  revokeApiToken(id: string): Promise<void> {
    return this.request("DELETE", `/auth/tokens/${id}`);
  }

  dataEnv(projectId: string): Promise<Record<string, string>> {
    return this.request<Record<string, string>>("GET", `/projects/${projectId}/data-env`);
  }

  // ── Data API базы: ключи, сайты, методы и уровни (T-20260911-9) ─────────
  //
  // Те же ручки, что у раздела «API» в панели. Ответы у них без модели в
  // схеме, поэтому их форма описана здесь; тела запросов — из схемы.

  listDataKeys(org: string, dbId: string): Promise<DataApiKey[]> {
    return this.request("GET", `/organizations/${org}/databases/${dbId}/api/keys`);
  }

  issueDataKey(
    org: string,
    dbId: string,
    input: Schemas["ApiKeyIn"],
  ): Promise<{ id: string; key: string; prefix: string; is_public: boolean; expires_at?: string | null }> {
    return this.request("POST", `/organizations/${org}/databases/${dbId}/api/keys`, input);
  }

  revokeDataKey(org: string, dbId: string, keyId: string): Promise<unknown> {
    return this.request("DELETE", `/organizations/${org}/databases/${dbId}/api/keys/${keyId}`);
  }

  listDataOrigins(org: string, dbId: string): Promise<{
    origins: Array<{ origin: string; note?: string | null }>;
    from_projects: string[];
    localhost_allowed?: boolean;
  }> {
    return this.request("GET", `/organizations/${org}/databases/${dbId}/api/origins`);
  }

  addDataOrigin(org: string, dbId: string, origin: string, note: string | null): Promise<unknown> {
    const body: Schemas["OriginIn"] = { origin, note };
    return this.request("POST", `/organizations/${org}/databases/${dbId}/api/origins`, body);
  }

  /** Источник — параметром запроса: в нём `://` и точки, путём он стал бы чужим маршрутом. */
  removeDataOrigin(org: string, dbId: string, origin: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/organizations/${org}/databases/${dbId}/api/origins?origin=${encodeURIComponent(origin)}`,
    );
  }

  listDataMethods(org: string, dbId: string): Promise<DataApiMethods> {
    return this.request("GET", `/organizations/${org}/databases/${dbId}/api/methods`);
  }

  setDataLevels(org: string, dbId: string, input: Schemas["ApiLevelsIn"]): Promise<DataApiLevelsPlan> {
    return this.request("POST", `/organizations/${org}/databases/${dbId}/api/levels`, input);
  }

  enableDataApi(
    org: string,
    dbId: string,
    withSecret: boolean,
  ): Promise<{ slug: string; key: { key: string } | null; secret_key: { key: string } | null }> {
    return this.request(
      "POST",
      `/organizations/${org}/databases/${dbId}/api/enable?with_secret=${withSecret ? "true" : "false"}`,
    );
  }

  /**
   * Значение `null` = «оставить как есть». Благодаря этому добавить одну
   * переменную можно, не читая остальные, — то есть не имея доступа к
   * чужим секретам.
   */
  replaceEnvVars(
    projectId: string,
    vars: Record<string, string | null>,
  ): Promise<EnvVarOut[]> {
    return this.request<EnvVarOut[]>("PUT", `/projects/${projectId}/env`, { vars });
  }

  // --- Метрика (AGENT-12) ---------------------------------------------

  getMetrikaIntegration(projectId: string): Promise<MetrikaIntegrationOut> {
    return this.request<MetrikaIntegrationOut>(
      "GET",
      `/projects/${projectId}/integrations/metrika`,
    );
  }

  /**
   * Возвращает ссылку на OAuth Яндекса. Открыть её должен ЧЕЛОВЕК —
   * ни CLI, ни агент за него авторизоваться не могут.
   */
  connectMetrika(projectId: string, branch?: string): Promise<{ oauth_url: string }> {
    return this.request<{ oauth_url: string }>(
      "POST",
      `/projects/${projectId}/integrations/metrika/connect`,
      branch ? { branch_name: branch } : {},
    );
  }

  getMetrikaStats(projectId: string, period = "7d"): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/projects/${projectId}/integrations/metrika/stats?period=${encodeURIComponent(period)}`,
    );
  }

  disconnectMetrika(projectId: string): Promise<void> {
    return this.request<void>("DELETE", `/projects/${projectId}/integrations/metrika`);
  }

  // --- Замеры (AGENT-11) ----------------------------------------------

  /** Запустить замер активного деплоя. Не ждёт: прогон асинхронный. */
  startPerfCheck(projectId: string): Promise<PerfCheckOut> {
    return this.request<PerfCheckOut>("POST", `/projects/${projectId}/perf-check`);
  }

  /** Результат последнего замера со сравнением с предыдущим деплоем. */
  getPerfCheck(projectId: string): Promise<PerfCheckOut> {
    return this.request<PerfCheckOut>("GET", `/projects/${projectId}/perf-check`);
  }

  // --- Домены (AGENT-09) ---------------------------------------------

  listDomains(projectId: string): Promise<DomainOut[]> {
    return this.request<DomainOut[]>("GET", `/projects/${projectId}/domains`);
  }

  /**
   * Схему и путь бэкенд стрипает сам, так что вставленный из адресной
   * строки `https://shop.example.com/page` доедет как `shop.example.com`.
   */
  addDomain(projectId: string, domain: string): Promise<DomainOut> {
    return this.request<DomainOut>("POST", `/projects/${projectId}/domains`, { domain });
  }

  getDomainInstructions(projectId: string, domainId: string): Promise<DomainInstructionsOut> {
    return this.request<DomainInstructionsOut>(
      "GET",
      `/projects/${projectId}/domains/${domainId}/instructions`,
    );
  }

  verifyDomain(projectId: string, domainId: string): Promise<DomainOut> {
    return this.request<DomainOut>("POST", `/projects/${projectId}/domains/${domainId}/verify`);
  }

  makeDomainPrimary(projectId: string, domainId: string): Promise<DomainOut> {
    return this.request<DomainOut>("POST", `/projects/${projectId}/domains/${domainId}/primary`);
  }

  removeDomain(projectId: string, domainId: string): Promise<void> {
    return this.request<void>("DELETE", `/projects/${projectId}/domains/${domainId}`);
  }

  pollLogs(deployId: string, afterId: number): Promise<LogsPollOut> {
    return this.request<LogsPollOut>(
      "GET",
      `/deploys/${deployId}/logs?after_id=${afterId}`,
      undefined,
      POLL_TIMEOUT_MS,
    );
  }

  listProjectDeploys(
    projectId: string,
    branch?: string,
  ): Promise<DeployOut[]> {
    const qs = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    return this.request<DeployOut[]>(
      "GET",
      `/projects/${projectId}/deploys${qs}`,
    );
  }

  rollbackProject(
    projectId: string,
    input: { branch?: string; deploy_id?: string },
  ): Promise<DeployOut> {
    return this.request<DeployOut>(
      "POST",
      `/projects/${projectId}/rollback`,
      input,
    );
  }

  // V071 production-pointer: pin apex to a specific deploy. `source` is
  // recorded in promote_events and lets us split CLI vs UI adoption later.
  promoteDeploy(
    projectId: string,
    deployId: string,
  ): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/promote`,
      { deploy_id: deployId, source: "cli" },
    );
  }

  // Clear projects.production_deploy_id — apex resumes following latest
  // ready deploy of default_branch (or sole-env, see V071 host_resolver).
  unpinProduction(projectId: string): Promise<ProjectSummary> {
    return this.request<ProjectSummary>(
      "POST",
      `/projects/${projectId}/unpin`,
    );
  }

  listDeployHooks(projectId: string): Promise<DeployHookOut[]> {
    return this.request<DeployHookOut[]>(
      "GET",
      `/projects/${projectId}/deploy-hooks`,
    );
  }

  createDeployHook(
    projectId: string,
    input: { name: string; branch?: string | null; target?: "preview" | "production" },
  ): Promise<DeployHookOut> {
    return this.request<DeployHookOut>(
      "POST",
      `/projects/${projectId}/deploy-hooks`,
      input,
    );
  }

  deleteDeployHook(projectId: string, hookId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/projects/${projectId}/deploy-hooks/${hookId}`,
    );
  }

  startDeviceAuth(): Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    poll_interval: number;
  }> {
    return this.request("POST", "/auth/cli/device");
  }

  pollDeviceAuth(device_code: string): Promise<{
    status: "pending" | "approved" | "expired";
    token?: string;
  }> {
    return this.request("POST", "/auth/cli/device/poll", { device_code });
  }

  setUsername(
    value: string,
  ): Promise<{ username: string; organization_slug: string }> {
    return this.request("POST", "/auth/me/username", { value });
  }

  checkUsername(
    value: string,
  ): Promise<{ available: boolean; normalized: string; reason: string | null }> {
    return this.request(
      "GET",
      `/auth/me/username/check?value=${encodeURIComponent(value)}`,
    );
  }

  /**
   * Проба метода Data API настоящим запросом через шлюз; запись откатывается
   * (T-20260911-1). Ответ шлюза, в том числе его отказ, приходит телом 200.
   */
  probeDataApi(org: string, dbId: string, input: Schemas["ProbeHttpIn"]): Promise<DataApiProbe> {
    return this.request("POST", `/organizations/${org}/databases/${dbId}/api/probe-http`, input);
  }

  // --- Источники кода: провайдеры, подключения, репозитории (этап 6). ------

  listSourceProviders(org: string): Promise<SourceProviderOut[]> {
    return this.request<SourceProviderOut[]>("GET", `/organizations/${org}/source-providers`);
  }

  listSourceConnections(org: string): Promise<SourceConnectionOut[]> {
    return this.request<SourceConnectionOut[]>("GET", `/organizations/${org}/source-connections`);
  }

  /** Токен уходит на сервер и НЕ возвращается: ответ — подключение без него. */
  createSourceConnection(
    org: string,
    input: { provider_id: string; token: string; display_name?: string | null; base_url?: string | null },
  ): Promise<SourceConnectionOut> {
    return this.request<SourceConnectionOut>("POST", `/organizations/${org}/source-connections`, input);
  }

  listSourceRepos(org: string, connectionId: string): Promise<SourceRepoOut[]> {
    return this.request<SourceRepoOut[]>(
      "GET",
      `/organizations/${org}/source-connections/${connectionId}/repos`,
    );
  }

  /** Аккаунты, из которых организация может импортировать: GitHub App и токеновые подключения. */
  listImportAccounts(org: string): Promise<ImportAccountOut[]> {
    return this.request<ImportAccountOut[]>("GET", `/organizations/${org}/import/accounts`);
  }

  listImportRepos(org: string, accountKey: string): Promise<ImportRepoOut[]> {
    return this.request<ImportRepoOut[]>(
      "GET",
      `/organizations/${org}/import/repos?account=${encodeURIComponent(accountKey)}`,
    );
  }

  /**
   * Проект из репозитория GitHub через ключ аккаунта (`github:<installation>`):
   * сервер сам заводит проект и вебхук — у GitHub App иного режима нет.
   */
  createProjectFromAccount(input: {
    name: string;
    organization_slug?: string;
    source_account_key: string;
    repo_path: string;
    default_branch?: string;
  }): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("POST", "/projects", {
      name: input.name,
      source_type: "github",
      organization_slug: input.organization_slug,
      source_account_key: input.source_account_key,
      repo_path: input.repo_path,
      default_branch: input.default_branch ?? "main",
    });
  }

  /**
   * Привязать репозиторий внешнего провайдера к существующему проекту.
   * Возвращает и итог вебхука: у GitVerse/GitLab/GitFlic его может не дать
   * токен, у SourceCraft вебхуков нет вовсе — привязка при этом остаётся.
   */
  connectSource(
    projectId: string,
    input: { connection_id: string; repo_path: string; branch?: string | null },
  ): Promise<ConnectSourceOut> {
    return this.request<ConnectSourceOut>("POST", `/projects/${projectId}/connect-source`, input);
  }

  /**
   * Подсказка детекта для проекта с репозиторием — то, что панель показывает
   * в мастере: фреймворк, команда сборки, папка результата, менеджер пакетов,
   * найден ли `layero.json`.
   */
  detectProject(projectId: string): Promise<ProjectDetectOut> {
    return this.request<ProjectDetectOut>("GET", `/projects/${projectId}/detect`);
  }

  /**
   * Завершить мастер за человека: та же ручка, что у кнопки «Начать деплой»
   * в панели. Обязателен только `framework_hint`; остальное — то, что дал
   * детект. Не заданное здесь не заглушка, а «решит сборщик по репозиторию».
   */
  applySetup(projectId: string, input: ProjectSetupIn): Promise<ProjectSummary> {
    return this.request<ProjectSummary>("POST", `/projects/${projectId}/setup`, input);
  }

  /**
   * Первая сборка проекта с репозиторием: без архива — сервер сам берёт HEAD
   * ветки по умолчанию. Панель после мастера делает ровно этот вызов.
   */
  triggerRepoDeploy(projectId: string): Promise<DeployOut> {
    return this.request<DeployOut>("POST", `/projects/${projectId}/deploy`, {});
  }

  /** Окружения проекта: ветки с адресами. Архивные и снятые с раздачи не входят. */
  listBranches(projectId: string): Promise<BranchOut[]> {
    return this.request<BranchOut[]>("GET", `/projects/${projectId}/branches`);
  }

  /** Требует scope `admin` у токена: удаление необратимо. */
  deleteProject(projectId: string): Promise<ProjectDeleteOut> {
    return this.request<ProjectDeleteOut>("DELETE", `/projects/${projectId}`);
  }

  // --- Claimable (этап 13). Без токена: заявку создаёт кто угодно. ----------

  createClaimableProject(input: { name?: string; framework_hint?: string }): Promise<ClaimableProjectOut> {
    return this.request<ClaimableProjectOut>("POST", "/claimable/projects", input);
  }

  getClaimStatus(code: string): Promise<ClaimStatusOut> {
    return this.request<ClaimStatusOut>("GET", `/claimable/status?code=${encodeURIComponent(code)}`);
  }
}

export async function uploadArchive(
  init: UploadInit,
  filePath: string,
): Promise<void> {
  const fs = await import("node:fs");
  const stat = await fs.promises.stat(filePath);
  // Use Node fetch with a stream body. Duplex 'half' is required when the
  // body is a stream — Node refuses otherwise.
  const stream = fs.createReadStream(filePath);
  const resp = await fetch(init.upload_url, {
    method: "PUT",
    headers: {
      ...init.headers,
      "Content-Length": String(stat.size),
    },
    // @ts-expect-error duplex is a Node-specific option for streamed bodies
    duplex: "half",
    body: stream as unknown as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `S3 PUT ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
}
