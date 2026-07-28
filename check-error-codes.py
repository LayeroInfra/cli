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

# Поверхности относительно корня рабочей папки. Отсутствующие пропускаем:
# репозитории лежат рядом, но не у всех они склонированы.
SURFACES = (
    "layero-docs/docs/cli/json-events.md",
    "layero-docs/docs/cli/agents.md",
    "layero-docs/i18n/en/docusaurus-plugin-content-docs/current/cli/json-events.md",
    "layero-docs/i18n/en/docusaurus-plugin-content-docs/current/cli/agents.md",
    "layero-docs/static/llms.txt",
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
            print(f"  · пропуск (нет файла): {rel}")
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
    if failures:
        print(f"\nмёртвых кодов в текстах: {failures}")
        return 1
    print("мёртвых кодов не найдено")
    return 0


if __name__ == "__main__":
    sys.exit(main())
