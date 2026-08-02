/**
 * Версия CLI и то, как она представляется платформе.
 *
 * WHY (02.08.2026): до этого CLI не сообщал о себе НИЧЕГО — ни `User-Agent`,
 * ни своего заголовка. На вопрос «на какой версии сидят люди» из прода ответить
 * было нельзя, а он не праздный: нагон версии не работал ни в одном релизе
 * (запрос к реестру возвращал 406 и глотался), и сколько машин осталось на
 * старом коде, мы не знали даже порядково. На рабочем ноутбуке при этом стоял
 * глобальный 0.8.11 при опубликованном 0.8.20.
 *
 * Версия читается из package.json пакета, а не хардкодится: единственный
 * источник правды — тот же файл, который публикуется в npm.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function readVersion(): string {
  try {
    // dist/version.js → корень пакета на уровень выше.
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
  } catch {
    // Пакет собран необычно или файл недоступен. Версия — не то, ради чего
    // стоит валить команду: отдаём заглушку и работаем дальше.
    return "0.0.0-unknown";
  }
}

export const CLI_VERSION = readVersion();

/**
 * Строка для `User-Agent`. Ни имени пользователя, ни путей, ни токена — только
 * то, что нужно, чтобы отличить сборочные окружения друг от друга при разборе
 * отказов: своя версия, версия Node и платформа.
 */
export function userAgent(): string {
  return `layero-cli/${CLI_VERSION} node/${process.versions.node} ${process.platform}-${process.arch}`;
}
