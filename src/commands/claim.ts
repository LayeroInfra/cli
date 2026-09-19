import open from "open";
import { ApiClient, ApiError, ClaimableProjectOut } from "../api.js";
import { CliConfig, loadConfig, saveConfig } from "../config.js";
import { loadProjectConfig, persistProjectLinking } from "../project-config.js";
import { LayeroError, detectMode, emit } from "../agent.js";
import { dashboardOrigin } from "../urls.js";

/**
 * Claimable-проекты (этап 13 AX-аудита).
 *
 * Сценарий: агент работает без аккаунта Layero — токена нет, браузера нет,
 * человек не рядом. Платформа заводит временный проект и выдаёт токен на
 * него; сайт живёт час; человек забирает его в свой аккаунт по ссылке
 * `claim_url`. Принять заявку можно ТОЛЬКО в панели: CLI и агент не
 * подтверждают её ни при каких флагах.
 */

/** Код заявки: из ответа сервера, а если его там нет — из `claim_url`. */
export function claimCodeOf(created: Pick<ClaimableProjectOut, "claim_url" | "claim_code">): string {
  if (created.claim_code) return created.claim_code;
  try {
    const u = new URL(created.claim_url);
    const q = u.searchParams.get("code");
    if (q) return q;
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return last;
  } catch {
    /* не URL — ниже */
  }
  throw new LayeroError(
    "claimable_unavailable",
    "платформа не вернула код заявки",
    "повторите позже; если повторяется — сообщите на https://docs.layero.ru/contacts/",
  );
}

/**
 * Создать claimable-проект и запомнить его: токен — в `~/.layero/config.json`
 * (по проекту), код и ссылку — в `.layero/project.json`. Возвращает конфиг
 * с токеном заявки, которым идёт деплой.
 */
export async function createClaimable(
  cfg: CliConfig,
  cwd: string,
  input: { name?: string; framework_hint?: string },
): Promise<{ cfg: CliConfig; created: ClaimableProjectOut; code: string }> {
  const api = new ApiClient(cfg);
  let created: ClaimableProjectOut;
  try {
    created = await api.createClaimableProject(input);
  } catch (err) {
    // 404/501 — ручки нет; 503 — платформа выключила песочницы; 429 — квота
    // заявок исчерпана. Все три — «сейчас так нельзя», и совет один: войти.
    if (err instanceof ApiError && [404, 429, 501, 503].includes(err.status)) {
      throw new LayeroError(
        "claimable_unavailable",
        err.status === 429
          ? "лимит заявок без аккаунта исчерпан — попробуйте позже"
          : "деплой без аккаунта на этой платформе сейчас не включён",
        "войдите: `layero login`, либо задайте LAYERO_TOKEN (выпуск — `layero token create` или app.layero.ru/settings/cli)",
      );
    }
    throw err;
  }
  const code = claimCodeOf(created);
  const next: CliConfig = {
    ...cfg,
    token: created.token,
    claim_tokens: { ...(cfg.claim_tokens ?? {}), [created.project_id]: created.token },
  };
  // В файл — только карту токенов заявок, не сам токен как «вход»: иначе
  // следующий `layero whoami` считал бы временный токен аккаунтом.
  await saveConfig({ ...cfg, claim_tokens: next.claim_tokens });
  await persistProjectLinking(cwd, {
    project_id: created.project_id,
    slug: created.slug,
    organization_slug: created.organization,
    apex_hostname: created.url ? new URL(created.url).hostname : `${created.slug}.layero.app`,
    claim: { code, claim_url: created.claim_url, expires_at: created.expires_at },
  });
  return { cfg: next, created, code };
}

/** Токен заявки для проекта из `.layero/project.json`, если он есть. */
export function claimTokenFor(cfg: CliConfig, projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return cfg.claim_tokens?.[projectId];
}

/**
 * Конфиг с токеном, которым можно ЧИТАТЬ проект этой папки.
 *
 * 🚨 Песочница (`deploy --claim`) — тоже вход. Её токен лежит в
 * `~/.layero/config.json` по id проекта, и прав на чтение хватает; без этой
 * ветки агент без аккаунта получал на упавшей сборке совет «выполни
 * `layero login`» и не мог узнать причину отказа ничем, кроме панели, которая
 * ему недоступна (T-20260918-8). Для `diagnose`, `logs`, `deploys list` — то,
 * что читает; действия, меняющие сайт, этим путём не ходят.
 */
export async function configForFolder(
  opts: { project?: string },
  cwd: string,
): Promise<CliConfig> {
  const cfg = await loadConfig();
  if (cfg.token) return cfg;
  const linked = await loadProjectConfig(cwd);
  const sameProject =
    !opts.project || opts.project === linked?.project_id || opts.project === linked?.slug;
  const claim = sameProject ? claimTokenFor(cfg, linked?.project_id) : undefined;
  if (claim) return { ...cfg, token: claim };
  throw new LayeroError(
    "auth_required",
    "нужен вход",
    "выполни `layero login` или задай LAYERO_TOKEN",
  );
}

function claimUrlFor(cfg: CliConfig, code: string): string {
  return `${dashboardOrigin(cfg.apiUrl)}/claim?code=${encodeURIComponent(code)}`;
}

async function resolveCode(cwd: string, explicit?: string): Promise<{ code: string; claim_url: string | null }> {
  if (explicit) return { code: explicit.trim(), claim_url: null };
  const linked = await loadProjectConfig(cwd);
  if (linked?.claim?.code) return { code: linked.claim.code, claim_url: linked.claim.claim_url };
  throw new LayeroError(
    "claim_unknown",
    "в этой папке нет claimable-проекта",
    "передайте код: `layero claim status <code>` — или создайте проект без аккаунта: `layero deploy --claim`",
  );
}

/** `layero claim status [code]` — что с заявкой: жива, забрана, истекла. */
export async function claimStatusCmd(code: string | undefined, opts: { json?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const cfg = await loadConfig();
  const ref = await resolveCode(cwd, code);
  // Без токена намеренно: статус заявки — публичный по коду, как и сама ссылка.
  const api = new ApiClient({ apiUrl: cfg.apiUrl });
  let status;
  try {
    status = await api.getClaimStatus(ref.code);
  } catch (err) {
    // 422 — код не той формы (короче 8 символов): для человека это тот же
    // «кода нет», а не внутренняя ошибка CLI.
    if (err instanceof ApiError && (err.status === 404 || err.status === 422)) {
      throw new LayeroError(
        "claim_unknown",
        `заявки с кодом ${ref.code} нет — истекла или код неверный`,
        "новый проект без аккаунта: `layero deploy --claim`",
      );
    }
    throw err;
  }
  emit({
    event: "claim_status",
    code: ref.code,
    status: status.status,
    claimed: status.claimed ?? status.status === "claimed",
    expires_at: status.expires_at ?? null,
    url: status.url ?? null,
    claim_url: status.claim_url ?? ref.claim_url ?? claimUrlFor(cfg, ref.code),
  });
}

/**
 * `layero claim accept <code>` — открыть страницу заявки в панели. Принять
 * можно только человеком, залогиненным в панели: CLI ссылку открывает
 * (в терминале) или печатает (агенту), и на этом его роль кончается.
 */
export async function claimAcceptCmd(code: string | undefined, opts: { json?: boolean; noBrowser?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const cfg = await loadConfig();
  const ref = await resolveCode(cwd, code);
  const claimUrl = ref.claim_url ?? claimUrlFor(cfg, ref.code);
  const mode = detectMode();
  let opened = false;
  if (mode.interactive && !opts.noBrowser) {
    try {
      await open(claimUrl);
      opened = true;
    } catch {
      opened = false;
    }
  }
  emit({ event: "claim_accept", code: ref.code, claim_url: claimUrl, opened });
}
