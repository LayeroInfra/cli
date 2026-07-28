#!/usr/bin/env python3
"""Сверяет коды ошибок, описанные в документации, с теми, что CLI реально выдаёт.

Зачем. 28.07 выяснилось, что семь кодов (`not_logged_in`, `project_unlinked`,
`username_missing`, `org_membership_missing`, `no_organization`, `deploy_error`,
`deploy_timed_out`) не выдаются ниоткуда: они были в ранней версии CLI, их
убрали, а документация за этим не пошла. Одновременно около четырнадцати
реальных кодов не были описаны вовсе. Агент, написавший обработку по нашим
текстам, не попадал ни в одну ветку и пропускал всё, что происходит.

Список продублирован в десяти местах — от `llms.txt` до страницы npm и правила
в чужом репозитории, — поэтому расхождение и держалось: правили одну копию.

Что делает. Достаёт фактический набор из конструкторов `LayeroError` в `src/`
и ищет в текстовых поверхностях коды, которых в этом наборе нет.

Политика падений узкая: валим только на коде из явного списка мёртвых. Любой
незнакомый идентификатор — предупреждение: тексты пишут люди, и «bad_format»
в прозе не обязано быть кодом.

⚠️ Отдельная грабля: правя список, не забудьте пример рядом. За одну ночь
трижды случалось, что перечень исправлен, а JSON-пример под ним остался со
старым кодом — копируют как раз пример.

Запуск: python3 check-error-codes.py [--root ПУТЬ_К_РАБОЧЕЙ_ПАПКЕ]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Коды, которых точно не существует. Их наличие в тексте — ошибка, а не
# незнакомое слово: проверено по `src/` 28.07.2026.
DEAD = {
    "not_logged_in",
    "project_unlinked",
    "username_missing",
    "org_membership_missing",
    "no_organization",
    "deploy_error",
    "deploy_timed_out",
}

# Строки, в которых мёртвый код упомянут НАМЕРЕННО — как предупреждение
# «такого кода нет». Их пропускаем, иначе проверка ругается на саму себя.
WINDOW = 4  # строк вверх и вниз, где ищем маркер намеренного упоминания

ALLOW_MARKERS = (
    "не существует", "НЕ существует", "не существует",
    "do not exist", "does not exist",
    "there is no", "There is no",
    "не выдаётся", "не выдаются",
)

# Поверхности относительно корня рабочей папки. Отсутствие любой из них —
# ОТКАЗ, а не пропуск: список выверен, и молча уменьшившийся охват опаснее
# честного падения (см. комментарий в main).
SURFACES = (
    "layero-docs/docs/cli/json-events.md",
    "layero-docs/docs/cli/agents.md",
    "layero-docs/i18n/en/docusaurus-plugin-content-docs/current/cli/json-events.md",
    "layero-docs/i18n/en/docusaurus-plugin-content-docs/current/cli/agents.md",
    "frontend/landing/llms.txt",
    "frontend/landing/llms-full.txt",
    "frontend/landing/cursorrules",
    "core/cli/README.md",
    "core/cli/src/commands/init.ts",
)


def real_codes(cli_src: Path) -> set[str]:
    """Коды из конструкторов LayeroError. Многострочные ловятся тоже."""
    pat = re.compile(r'new LayeroError\(\s*"([a-z_]+)"', re.S)
    found: set[str] = set()
    for path in cli_src.rglob("*.ts"):
        found |= set(pat.findall(path.read_text(encoding="utf-8", errors="ignore")))
    # deploy_<status> собирается динамически; статусов у деплоя четыре.
    found |= {"deploy_failed", "deploy_cancelled", "internal"}
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    args = ap.parse_args()
    root = Path(args.root)

    cli_src = Path(__file__).resolve().parent / "src"
    if not cli_src.is_dir():
        print(f"не найден {cli_src} — запускать из core/cli", file=sys.stderr)
        return 2

    codes = real_codes(cli_src)
    print(f"кодов в CLI: {len(codes)}")

    failures = 0
    checked = 0
    for rel in SURFACES:
        path = root / rel
        if not path.is_file():
            # НЕ пропуск. SURFACES — выверенный список; если файл переехал или
            # удалён, охват проверки молча падает, а она продолжает рапортовать
            # успех. 28.07 так и вышло: `layero-docs/static/llms.txt` удалён при
            # переходе на генератор, поверхностей стало 9 вместо 10, выход 0.
            print(f"  ✗ поверхность отсутствует: {rel} — обновите SURFACES")
            failures += 1
            continue
        checked += 1
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        for num, line in enumerate(lines, 1):
            # Маркер ищем в ОКНЕ, а не в строке: предупреждение «таких кодов
            # нет» переносится на несколько строк, и коды в нём стоят выше
            # самой фразы. Построчная проверка ругалась на саму себя — ровно
            # та ошибка, против которой этот скрипт и написан.
            lo, hi = max(0, num - 1 - WINDOW), min(len(lines), num + WINDOW)
            window = " ".join(lines[lo:hi])
            if any(m in window for m in ALLOW_MARKERS):
                continue
            for dead in sorted(DEAD):
                if dead in line:
                    print(f"  ✗ {rel}:{num} — код `{dead}` не выдаётся CLI")
                    failures += 1

    print(f"проверено поверхностей: {checked}")

    # Обратное направление: код есть в CLI, но не описан в справочнике.
    #
    # Проверка была односторонней и ловила только мёртвые коды. 28.07 я добавил
    # `rollback_unsupported` — и она смолчала: новый код нигде не описан, а
    # претензий нет. То есть инструмент против расхождения списка с
    # реальностью не видел расхождения ровно того вида, ради которого писался.
    #
    # Сверяем с одним справочником (страница JSON-событий), а не со всеми
    # десятью поверхностями: llms.txt и правила для агентов перечисляют коды
    # выборочно, и требовать от них полноты неправильно.
    reference = root / "layero-docs/docs/cli/json-events.md"
    if reference.is_file():
        doc = reference.read_text(encoding="utf-8", errors="ignore")
        undocumented = sorted(
            c for c in codes if not re.search(rf"`{re.escape(c)}`", doc)
        )
        if undocumented:
            for code in undocumented:
                print(f"  ✗ {reference.name} — код `{code}` выдаётся CLI, но не описан")
            failures += len(undocumented)
    else:
        print(f"  ✗ справочник отсутствует: {reference}")
        failures += 1

    if failures:
        print(f"\nрасхождений: {failures}")
        return 1
    print("список кодов сходится с CLI в обе стороны")
    return 0


if __name__ == "__main__":
    sys.exit(main())
