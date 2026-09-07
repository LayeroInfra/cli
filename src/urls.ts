/**
 * Адреса панели, выведенные из адреса API.
 *
 * 🚨 ОДНО МЕСТО, А НЕ ПО КОПИИ НА КОМАНДУ. Правило простое — `api.` меняется на
 * `app.`, — и ровно поэтому его тянет переписать заново там, где понадобилось.
 * Вторая копия разошлась бы на первом же стенде: переменную `LAYERO_DASHBOARD_URL`
 * читала бы одна команда, а вторая уводила бы человека на боевую панель.
 */
export function dashboardOrigin(apiUrl: string): string {
  const override = process.env.LAYERO_DASHBOARD_URL;
  if (override) return override.replace(/\/+$/, "");
  try {
    const u = new URL(apiUrl);
    u.hostname = u.hostname.replace(/^api\./, "app.");
    return u.origin;
  } catch {
    return "https://app.layero.ru";
  }
}
