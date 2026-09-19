/**
 * Коды выхода CLI по классам ошибок (AX-аудит 17.09.2026, этап 6).
 *
 * До этого любой отказ заканчивался `exit 1`, и скрипт, вызвавший `layero`,
 * не мог отличить «нет токена» от «сборка упала»: приходилось разбирать
 * JSON-событие `error`, а в человеческом режиме — текст. Классы взяты
 * из аудита и совпадают с тем, как их делят Vercel и `gh`:
 *
 *   0 — успех;
 *   1 — прочий отказ (лимит тарифа, нет прав, нужно подтверждение,
 *       повторяющаяся ошибка сборки — всё, что не попало в классы ниже);
 *   2 — нужен вход: нет токена, токен протух, вход не подтверждён;
 *   3 — не найдено: проект, организация, база, домен, хук, окружение;
 *   4 — неверный ввод: флаг, аргумент, формат, неподдерживаемая операция;
 *   5 — удалённая ошибка: сборка упала или отменена, 5xx платформы,
 *       непредвиденное исключение CLI.
 *
 * Отнесение ПО КОДУ ОШИБКИ, а не по месту выброса: код — контракт (см.
 * `check-error-codes.py`), и класс выхода становится его частью. Новый код,
 * не попавший ни в один список, даёт 1 — честно «прочее», а не наугад.
 */

const AUTH = new Set(["auth_required", "auth_expired", "auth_timeout"]);

const NOT_FOUND = new Set([
  "project_unknown",
  "project_not_found",
  "org_unknown",
  "database_unknown",
  "env_not_found",
  "domain_not_found",
  "hook_not_found",
  "connection_not_found",
  "account_not_found",
  "repo_not_found",
  "claim_unknown",
  "branch_without_env",
  "no_deploy",
  "no_deploys",
  "no_runs",
  "data_key_unknown",
]);

const INVALID_INPUT = new Set([
  "invalid_type",
  "invalid_choice",
  "prebuilt_no_dir",
  "prebuilt_no_index",
  "bad_format",
  "nothing_to_set",
  "rollback_noop",
  "sql_missing",
  "branch_unsupported",
  "claim_with_project",
  "provider_unknown",
  "repo_format",
  "token_missing",
  "username_rejected",
  "gb_not_supported",
  "dedicated_needs_panel",
  "data_key_kind",
  "data_key_expiry",
  "data_key_ambiguous",
  "data_levels_missing",
  "data_level_unknown",
  "data_probe_method",
  "data_probe_path",
  "data_probe_query",
  "data_probe_body",
  "data_probe_as",
  "data_probe_user_required",
  "data_probe_user_invalid",
  "data_probe_schema",
  "data_probe_expect",
]);

const REMOTE = new Set([
  "deploy_failed",
  "deploy_cancelled",
  "deploy_not_started",
  "deploy_watch_lost",
  "internal",
  "oauth_unavailable",
  "claimable_unavailable",
  "data_probe_gateway_failed",
]);

export const EXIT_OK = 0;
export const EXIT_OTHER = 1;
export const EXIT_AUTH = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_INVALID_INPUT = 4;
export const EXIT_REMOTE = 5;

export function exitCodeFor(code: string): number {
  if (AUTH.has(code)) return EXIT_AUTH;
  if (NOT_FOUND.has(code)) return EXIT_NOT_FOUND;
  if (INVALID_INPUT.has(code)) return EXIT_INVALID_INPUT;
  if (REMOTE.has(code)) return EXIT_REMOTE;
  // `deploy_<status>` собирается динамически; `http_5xx` — отказ платформы,
  // который не разобрали в понятный код.
  if (code.startsWith("deploy_")) return EXIT_REMOTE;
  if (/^http_5\d\d$/.test(code)) return EXIT_REMOTE;
  return EXIT_OTHER;
}
