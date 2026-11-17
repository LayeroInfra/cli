/**
 * Отказы API, которые означают нормальное состояние аккаунта, а не поломку
 * CLI: протухший вход (401), лимит тарифа (402), понятный отказ 4xx.
 * Вынесено из `bin/layero.ts`, чтобы покрыть тестами.
 */
import { LayeroError } from "./agent.js";
import { ApiError } from "./api.js";
import { nextActionFor } from "./next-action.js";

/**
 * Ответы API, которые означают НОРМАЛЬНОЕ состояние аккаунта, а не поломку.
 *
 * До 02.08.2026 их не разбирал никто, и они доезжали до пользователя как
 * `code: "internal"` с советом «сообщите о баге»:
 *
 *   Error: internal
 *     API GET /auth/me → 401: {"detail":"Invalid token"}
 *     → re-run with --debug for a stack trace, or report at …/contacts/
 *
 * 401 здесь — не редкость, а расписание: TTL токена 168 часов, то есть КАЖДЫЙ
 * пользователь CLI упирается в это раз в неделю. На момент проверки токен был
 * протухшим у 66 из 115 человек, деплоивших через CLI за месяц. Ни один из них
 * не получил единственную нужную подсказку — «выполните layero login».
 *
 * 402 — лимит тарифа (например, `max_projects` на free). Тоже обычное дело, а
 * не сбой платформы: чинится сменой тарифа или удалением проекта, и текст
 * ошибки обязан говорить именно это.
 */
export function asAccountStateError(err: unknown): LayeroError | null {
  if (!(err instanceof ApiError)) return null;

  if (err.status === 401) {
    return new LayeroError(
      "auth_expired",
      "Вход больше не действует — токен протух или сессия отозвана.",
      "выполните `layero login`",
    );
  }

  if (err.status === 402) return planLimitError(err.body);

  // 🚨 Понятный отказ сервера не имеет права превращаться в нашу поломку.
  // 409 с `reason: reserved` и текстом «имя зарезервировано платформой»
  // печатался как `code: internal` с советом «re-run with --debug for a stack
  // trace» — человек шёл искать стек вместо того, чтобы сменить имя.
  //
  // Разбираем ЛЮБОЙ 4xx с телом, а не отдельные коды: заплатка на один код
  // означала бы, что следующий понятный отказ снова станет «внутренней
  // ошибкой». 5xx сюда не попадает намеренно — это как раз наша авария.
  if (err.status >= 400 && err.status < 500) {
    const detail = detailOf(err.body);
    if (detail) {
      return new LayeroError(
        detail.code ?? `http_${err.status}`,
        detail.message,
        // Общий совет — последний: причина и лекарство чаще всего уже в тексте
        // отказа (подсказки SQL про роли и Авторизацию, T-20261025-9), и
        // «исправьте запрос» уводил агента от них.
        detail.next_action ?? detail.hint ?? nextActionFor(err.status, detail.message) ??
          "прочитайте message: в нём причина отказа сервера; поправьте команду и повторите",
      );
    }
  }

  return null;
}

/**
 * Достаёт человеческую часть отказа из тела ответа.
 *
 * FastAPI кладёт её в `detail` — либо строкой, либо объектом с `code`,
 * `reason` и `message`. Обе формы живые, и обе должны доезжать до человека.
 */
function detailOf(
  body: string,
): { code?: string; message: string; next_action?: string; hint?: string } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const detail = parsed?.detail ?? parsed;
  if (typeof detail === "string" && detail.trim()) return { message: detail };
  if (detail && typeof detail === "object") {
    const message = detail.message ?? detail.detail ?? detail.reason;
    if (typeof message === "string" && message.trim()) {
      return {
        code: typeof detail.code === "string" ? detail.code : undefined,
        message,
        next_action: typeof detail.next_action === "string" ? detail.next_action : undefined,
        // Шлюз данных кладёт подсказку в `hint` (формат PostgREST).
        hint: typeof detail.hint === "string" && detail.hint ? detail.hint : undefined,
      };
    }
  }
  return null;
}

/** Лимиты, которые сервер называет ключом без готового текста. */
const LIMIT_NAMES: Record<string, string> = {
  max_projects: "проектов",
  custom_domains: "своих доменов",
  team_orgs: "командных организаций",
};

/**
 * Что делать дальше — по рекомендации сервера (`suggested_action`).
 *
 * С 1 декабря сервер отказывает в сборке, когда квота периода исчерпана
 * (оферта 4.1, соглашение 2.3). На Pro лекарство — не смена тарифа, а
 * дополнительное потребление, бюджет или пополнение баланса: совет «смените
 * тариф» клиенту на Pro неверен.
 */
const ACTION_HINTS: Record<string, string> = {
  enable_extra_usage:
    "включите дополнительное потребление в разделе «Потребление» на app.layero.ru или дождитесь нового периода",
  raise_budget:
    "увеличьте бюджет дополнительного потребления в разделе «Потребление» на app.layero.ru или дождитесь нового периода",
  top_up: "пополните баланс на app.layero.ru/billing — и сборки продолжатся",
};

/**
 * 402 — лимит тарифа. Текст — готовая причина сервера, если она есть: она
 * точнее общего («Сборки по тарифу закончились… Новый период начнётся
 * 1 декабря»). Служебный ключ показателя (`builds.billable`) человеку не
 * показываем.
 */
export function planLimitError(body: string): LayeroError {
  let detail: {
    feature?: string;
    limit?: number;
    observed?: number;
    message?: string;
    suggested_plan?: string | null;
    suggested_action?: string | null;
  } = {};
  try {
    const parsed = JSON.parse(body) as { detail?: typeof detail };
    if (parsed.detail && typeof parsed.detail === "object") detail = parsed.detail;
  } catch {
    /* тело не JSON — обойдёмся общим текстом */
  }
  const named = detail.feature ? LIMIT_NAMES[detail.feature] : undefined;
  const counts =
    typeof detail.limit === "number" && typeof detail.observed === "number"
      ? ` (${detail.observed} при лимите ${detail.limit})`
      : "";
  const serverText = typeof detail.message === "string" && detail.message.trim() ? detail.message : null;
  const message = named
    ? `Тариф не позволяет больше ${named}${counts}.`
    : serverText ?? "Действие недоступно на текущем тарифе.";
  const action = detail.suggested_action ? ACTION_HINTS[detail.suggested_action] : undefined;
  // Дату нового периода называет текст сервера — подсказка её не повторяет.
  const hint =
    action ??
    (!named && detail.suggested_plan === "pro"
      ? "перейдите на Pro на app.layero.ru/billing"
      : "смените тариф на app.layero.ru/billing или освободите место, удалив ненужное");
  return new LayeroError("plan_limit", message, hint);
}
