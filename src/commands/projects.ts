import readline from "node:readline/promises";
import { ApiClient, ApiError, ProjectSummary } from "../api.js";
import { loadConfig } from "../config.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { orgOf } from "./db.js";

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

export async function projectsListCmd(): Promise<void> {
  const api = await makeClient();
  const list = await api.listProjects();
  emit({
    event: "projects",
    projects: list.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      organization: p.organization.slug,
      url: `https://${p.apex_hostname}`,
      source_type: p.source_type,
      repo: p.repo_full_name ?? null,
      status: p.status,
    })),
  });
}

interface CreateOptions {
  repo?: string;
  branch?: string;
  name?: string;
  org?: string;
  json?: boolean;
}

/**
 * `<provider>:<owner/repo>` → провайдер и путь. Путь у GitLab бывает
 * вложенным (`group/sub/project`) — режем только по ПЕРВОМУ двоеточию.
 */
export function parseRepoRef(raw: string): { provider: string; path: string } {
  const idx = raw.indexOf(":");
  const provider = idx > 0 ? raw.slice(0, idx).trim().toLowerCase() : "";
  const path = (idx > 0 ? raw.slice(idx + 1) : raw).trim().replace(/^\/+|\/+$/g, "");
  if (!provider || !path.includes("/")) {
    throw new LayeroError(
      "repo_format",
      `не разобрать «${raw}»`,
      "формат: --repo <provider>:<owner/repo>, например --repo github:acme/site или --repo gitverse:acme/site; провайдеры — `layero sources list`",
    );
  }
  return { provider, path };
}

/**
 * `layero projects create --repo <provider>:<owner/repo>` — проект из
 * репозитория без панели (этап 6 AX-аудита). Раньше путь (a) «есть
 * репозиторий» начинался с кнопки «Импорт из репозитория», и агент, у
 * которого панели нет, был вынужден выбирать путь (b) — заливать папку.
 *
 * GitHub — через ключ аккаунта установки App: сервер заводит проект и
 * вебхук одним вызовом, иного режима у App нет. Остальные провайдеры — в два
 * шага: проект, затем `connect-source`, потому что только он возвращает
 * судьбу вебхука, а без вебхука push не собирается, и молчать об этом нельзя.
 */
export async function projectsCreateCmd(opts: CreateOptions): Promise<void> {
  if (!opts.repo) {
    throw new LayeroError(
      "repo_format",
      "не указан репозиторий",
      "`layero projects create --repo <provider>:<owner/repo>`; папку без репозитория выкладывает `layero deploy`",
    );
  }
  const { provider, path } = parseRepoRef(opts.repo);
  const api = await makeClient();
  const org = await orgOf(api, opts);

  const accounts = await api.listImportAccounts(org);
  const candidates = accounts.filter((a) => a.provider === provider);
  if (candidates.length === 0) {
    const known = [...new Set(accounts.map((a) => a.provider))];
    throw new LayeroError(
      "account_not_found",
      `в организации «${org}» нет подключения к ${provider}`,
      known.length
        ? `подключены: ${known.join(", ")}; добавить — \`layero sources connect ${provider} --token-stdin\``
        : `добавьте подключение: \`layero sources connect ${provider} --token-stdin\` (GitHub — установкой App в панели)`,
    );
  }
  const account =
    candidates.find((a) => a.status === "active" && a.can_import !== false) ?? candidates[0]!;
  if (account.status !== "active" || account.can_import === false) {
    throw new LayeroError(
      "account_not_found",
      `подключение ${provider} (${account.login}) в состоянии ${account.status}${account.status_note ? `: ${account.status_note}` : ""}`,
      account.configure_url ?? "переподключите провайдер: `layero sources connect …`",
    );
  }

  // Репозиторий сверяем по списку аккаунта: опечатка в пути даёт понятный
  // отказ здесь, а не 502 от провайдера после создания проекта.
  const repos = await api.listImportRepos(org, account.key);
  const repo = repos.find((r) => r.path.toLowerCase() === path.toLowerCase());
  if (!repo) {
    const sample = repos.slice(0, 8).map((r) => r.path).join(", ");
    throw new LayeroError(
      "repo_not_found",
      `репозиторий «${path}» не виден подключению ${provider} (${account.login})`,
      sample ? `доступны: ${sample}${repos.length > 8 ? ", …" : ""}` : "у подключения нет ни одного репозитория",
    );
  }
  if (repo.imported_project_ids.length > 0) {
    throw new LayeroError(
      "repo_already_imported",
      `репозиторий «${repo.path}» уже привязан к проекту ${repo.imported_project_ids.join(", ")}`,
      "`layero link <id>` — привязать папку к нему; второй проект из того же репозитория заводится в панели",
    );
  }

  const branch = opts.branch ?? repo.default_branch ?? "main";
  const name = opts.name ?? repo.name;

  let project: ProjectSummary;
  if (account.key.startsWith("github:")) {
    project = await api.createProjectFromAccount({
      name,
      organization_slug: org,
      source_account_key: account.key,
      repo_path: repo.path,
      default_branch: branch,
    });
    emitCreated(project, repo.path, branch);
    emit({ event: "source_connected", org, connection_id: account.key, provider, account: account.login });
    // У GitHub App вебхук — часть установки: без него App не существует.
    emit({ event: "webhook_installed", project: project.slug, url: "" });
    return;
  }

  const connectionId = account.key.replace(/^connection:/, "");
  project = await api.createCliProject({ name, organization_slug: org });
  let connected;
  try {
    connected = await api.connectSource(project.id, {
      connection_id: connectionId,
      repo_path: repo.path,
      branch,
    });
  } catch (err) {
    // Проект без источника бесполезен и занимает адрес — убираем. Удаление
    // требует scope admin; без него проект останется, и мы это скажем.
    let cleaned = false;
    try {
      await api.deleteProject(project.id);
      cleaned = true;
    } catch {
      /* нет прав или сеть — скажем словами ниже */
    }
    const reason = err instanceof ApiError ? err.body.slice(0, 300) : String(err);
    throw new LayeroError(
      "source_connect_failed",
      `репозиторий не привязался: ${reason}`,
      cleaned
        ? "проект удалён; проверьте токен подключения (`layero sources list`) и повторите"
        : `проект ${project.slug} создан без репозитория — привяжите в панели или удалите: \`layero projects delete ${project.slug} --yes\``,
    );
  }
  emitCreated(connected.project, repo.path, branch);
  emit({ event: "source_connected", org, connection_id: connectionId, provider, account: account.login });
  if (connected.webhook_registered) {
    emit({ event: "webhook_installed", project: connected.project.slug, url: connected.webhook_url });
  } else {
    emit({
      event: "webhook_unavailable",
      project: connected.project.slug,
      url: connected.webhook_url,
      hint:
        connected.webhook_hint ??
        "провайдер не дал создать вебхук этим токеном — заведите его в настройках репозитория вручную",
    });
  }
}

function emitCreated(project: ProjectSummary, repo: string, branch: string): void {
  emit({
    event: "project_created",
    project_id: project.id,
    slug: project.slug,
    organization: project.organization.slug,
    url: `https://${project.apex_hostname}`,
    repo,
    branch,
  });
}

/**
 * `layero projects delete <slug> --yes` — необратимо. Маршрут требует у
 * токена scope `admin`: токен по умолчанию (`read`+`deploy`) получит
 * `forbidden`, и это правильно — агент с деплой-токеном не должен уметь
 * снести проект.
 */
export async function projectsDeleteCmd(
  ref: string,
  opts: { yes?: boolean; json?: boolean },
): Promise<void> {
  const api = await makeClient();
  const project = await api.resolveProject(ref);
  const mode = detectMode();
  if (!opts.yes) {
    if (!mode.interactive) {
      throw new LayeroError(
        "confirmation_required",
        `удаление проекта ${project.slug} (${project.apex_hostname}) необратимо, а подтвердить его здесь некому`,
        `покажите это человеку и повторите с --yes: \`layero projects delete ${project.slug} --yes\``,
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await rl.question(
          `Удалить проект ${project.slug} и сайт https://${project.apex_hostname}? Необратимо. Введите слаг для подтверждения: `,
        )
      ).trim();
      if (answer !== project.slug) {
        throw new LayeroError("confirmation_required", "удаление отменено", "введите слаг проекта точно, как показан");
      }
    } finally {
      rl.close();
    }
  }
  try {
    await api.deleteProject(project.id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new LayeroError(
        "forbidden",
        "удаление проекта требует токена со scope admin",
        "выпустите токен: `layero token create <имя> --scope admin` — или удалите проект в панели",
      );
    }
    throw err;
  }
  emit({ event: "project_deleted", project_id: project.id, slug: project.slug });
}
