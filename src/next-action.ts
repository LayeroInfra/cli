/**
 * Что делать дальше — по известным отказам сервера (T-20261025-33, п. 2).
 *
 * Сервер отдаёт эти отказы строкой без подсказки, а агент читает именно
 * `next_action`: общий совет «исправьте и повторите» уводил его искать
 * опечатку там, где база ещё создаётся. Таблица — по тексту отказа, потому
 * что кода у этих отказов нет; новый текст на сервере без строки здесь
 * получит общий совет, а не неверный.
 */
export function nextActionFor(status: number, message: string): string | undefined {
  const m = message.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/не найдена или не активна/,
      "если базу только что создали — она ещё готовится: дождитесь status active в layero db list " +
        "и повторите; иначе проверьте имя базы там же"],
    [/у организации уже есть/,
      "общая база одна на организацию: используйте её (layero db list) или заведите выделенный " +
        "инстанс в панели"],
    [/relation .* does not exist|таблиц[аы] .* не найден/,
      "таблицы нет: проверьте имя и схему — SELECT schemaname, tablename FROM pg_tables " +
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')"],
    [/schema .* does not exist/,
      "схемы нет: создайте её (CREATE SCHEMA …) или уберите имя схемы из запроса"],
    [/permission denied/,
      "у роли запроса нет прав: выполните его владельцем базы (layero db sql) или выдайте GRANT"],
    [/syntax error/,
      "синтаксическая ошибка в SQL — поправьте запрос по месту, указанному в сообщении"],
    [/(лимит|тариф)/,
      "смените тариф на app.layero.ru/billing или освободите место, удалив ненужное"],
  ];
  for (const [re, action] of rules) if (re.test(m)) return action;
  return status === 404 ? "проверьте имя или идентификатор: layero db list / layero list покажут, что есть" : undefined;
}
