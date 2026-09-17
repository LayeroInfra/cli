import { ApiClient, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { LayeroError, emit } from "../agent.js";
import { orgOf } from "./db.js";

interface SourcesOptions {
  org?: string;
  json?: boolean;
}

async function makeClient(): Promise<ApiClient> {
  const cfg = await loadConfig();
  if (!cfg.token) {
    throw new LayeroError(
      "auth_required",
      "вход не выполнен",
      "выполните `layero login` или задайте LAYERO_TOKEN",
    );
  }
  return new ApiClient(cfg);
}

/** `layero sources list` — провайдеры, которые платформа умеет, и подключения организации. */
export async function sourcesListCmd(opts: SourcesOptions): Promise<void> {
  const api = await makeClient();
  const org = await orgOf(api, opts);
  const [providers, connections] = await Promise.all([
    api.listSourceProviders(org),
    api.listSourceConnections(org),
  ]);
  emit({
    event: "sources",
    org,
    providers: providers.map((p) => ({
      id: p.id,
      title: p.title,
      self_hosted: p.self_hosted,
      webhook_supported: p.webhook_supported,
      token_hint: p.token_hint ?? null,
    })),
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider_id,
      account: c.external_account,
      status: c.status,
      projects_count: c.projects_count,
      token_expiry_state: c.token_expiry_state,
      last_error: c.last_error,
    })),
  });
}

/** Читает stdin целиком — для `--token-stdin`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * `layero sources connect <provider> --token-stdin` — подключить провайдера
 * по PAT. Токен принимается флагом `--token` (для скриптов, где история не
 * пишется) и через stdin (`--token-stdin`): в истории shell и в транскрипте
 * агента `--token ghp_…` остаётся навсегда, а `echo $PAT | … --token-stdin`
 * — нет. Сервер проверяет токен до записи и наружу его не возвращает.
 *
 * Список провайдеров — `/organizations/{slug}/source-providers`: сверяем до
 * запроса, чтобы опечатка дала список, а не 400.
 */
export async function sourcesConnectCmd(
  provider: string,
  opts: SourcesOptions & { token?: string; tokenStdin?: boolean; baseUrl?: string; name?: string },
): Promise<void> {
  const api = await makeClient();
  const org = await orgOf(api, opts);
  const providers = await api.listSourceProviders(org);
  const spec = providers.find((p) => p.id === provider.trim().toLowerCase());
  if (!spec) {
    throw new LayeroError(
      "provider_unknown",
      `провайдера «${provider}» нет`,
      `доступны: ${providers.map((p) => p.id).join(", ")}; GitHub подключается установкой App в панели`,
    );
  }
  if (opts.baseUrl && !spec.self_hosted) {
    throw new LayeroError(
      "bad_format",
      `${spec.title} не поддерживает собственный инстанс`,
      "уберите --base-url",
    );
  }

  let token = (opts.token ?? "").trim();
  if (opts.tokenStdin) {
    token = (await readStdin()).trim();
  }
  if (!token) {
    throw new LayeroError(
      "token_missing",
      "не передан токен провайдера",
      `${spec.token_hint ? spec.token_hint + ". " : ""}Передайте его через stdin: \`echo "$PAT" | layero sources connect ${spec.id} --token-stdin\``,
    );
  }

  let created;
  try {
    created = await api.createSourceConnection(org, {
      provider_id: spec.id,
      token,
      display_name: opts.name ?? null,
      base_url: opts.baseUrl ?? null,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 502) {
      throw new LayeroError(
        "source_rejected",
        `${spec.title} не принял токен: ${err.body.slice(0, 300)}`,
        spec.token_hint ?? "проверьте токен и его права",
      );
    }
    throw err;
  }
  emit({
    event: "source_connected",
    org,
    connection_id: created.id,
    provider: created.provider_id,
    account: created.external_account,
  });
}

/** `layero sources repos <connection_id>` — репозитории, видимые токену подключения. */
export async function sourcesReposCmd(connectionId: string, opts: SourcesOptions): Promise<void> {
  const api = await makeClient();
  const org = await orgOf(api, opts);
  let repos;
  try {
    repos = await api.listSourceRepos(org, connectionId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new LayeroError(
        "connection_not_found",
        `в организации «${org}» нет подключения ${connectionId}`,
        "`layero sources list`",
      );
    }
    throw err;
  }
  emit({
    event: "source_repos",
    org,
    connection_id: connectionId,
    repos: repos.map((r) => ({
      path: r.path,
      name: r.name,
      default_branch: r.default_branch,
      private: r.private,
      can_admin: r.can_admin,
      updated_at: r.updated_at,
    })),
  });
}
