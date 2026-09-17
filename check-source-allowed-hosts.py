#!/usr/bin/env python3
"""Зашитый список хостов источников один на все три места.

ПОЧЕМУ ОНА ЕСТЬ. Хосты, откуда сборщикам можно забирать код, решает строка
`platform_config.LAYERO_SOURCE_ALLOWED_HOSTS`. Но у каждого участника есть
зашитый запасной список на случай, когда строки нет или ключ не доехал:

  * backend/app/core/config.py          (layero_source_allowed_hosts)
  * builder/src/config.py               (статический сборщик)
  * runtime/builder/app/source_plan.py  (сборщик приложений)

К 17.09.2026 их было три, и все РАЗНЫЕ: четыре хоста без SourceCraft, четыре,
пять — и ни в одном не было api.github.com, хоста архивного шага GitHub
(T-20260917-23). Расхождение запасного списка — отложенный отказ: он ждёт
момента, когда строка пропадёт или ключ не доедет, и срабатывает у одного
сборщика, но не у другого (core AGENTS.md, ограничение 7).

Проверка ищет каждый список по его месту и требует совпадения МНОЖЕСТВ, плюс
обязательный минимум: хосты клона и архивных шагов провайдеров, которые
платформа поддерживает из коробки. Пропавшее место — отказ, а не пропуск.

Запуск: python3 core/cli/check-source-allowed-hosts.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]

#: файл → выражение, чья первая группа — список через запятую.
PLACES = {
    "backend/app/core/config.py":
        r'layero_source_allowed_hosts:\s*str\s*=\s*"([^"]*)"',
    "builder/src/config.py":
        r'"LAYERO_SOURCE_ALLOWED_HOSTS",\s*(?:#[^\n]*\n\s*)*"([^"]*)"',
    "runtime/builder/app/source_plan.py":
        r'_DEFAULT_ALLOWED_HOSTS\s*=\s*"([^"]*)"',
}

#: Без этих хостов сборка с провайдера «из коробки» начинается с отказа.
REQUIRED = {
    "github.com", "api.github.com",   # клон и архив GitHub
    "gitlab.com",                     # клон и архив GitLab
    "gitverse.ru", "gitflic.ru", "git.sourcecraft.dev",
}


def main() -> int:
    found: dict[str, set[str]] = {}
    errors: list[str] = []
    for rel, pattern in PLACES.items():
        path = CORE / rel
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"{rel}: не прочитать ({exc})")
            continue
        m = re.search(pattern, text)
        if not m:
            errors.append(f"{rel}: зашитый список хостов не найден — место переехало?")
            continue
        found[rel] = {h.strip().lower() for h in m.group(1).split(",") if h.strip()}

    for rel, hosts in found.items():
        missing = REQUIRED - hosts
        if missing:
            errors.append(f"{rel}: нет обязательных хостов {sorted(missing)}")
    if len({frozenset(h) for h in found.values()}) > 1:
        errors.append("списки расходятся:")
        for rel, hosts in found.items():
            errors.append(f"    {rel}: {','.join(sorted(hosts))}")

    if errors:
        print("❌ check-source-allowed-hosts:")
        for e in errors:
            print("  " + e)
        return 1
    print(f"✅ check-source-allowed-hosts: {len(found)} места, список один")
    return 0


if __name__ == "__main__":
    sys.exit(main())
