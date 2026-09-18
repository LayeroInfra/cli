#!/usr/bin/env python3
"""CLI не отстаёт от опубликованной спеки детекта (`layero-detection`).

═══ ЗАЧЕМ ═══

Ядро детекта одно (`core/detection`, npm-пакет `layero-detection`), а
зависимость на него — СВОЯ У КАЖДОГО потребителя, и до 22.08.2026 за их
синхронностью не следило ничто. В тот день это стоило двух неверных выводов
подряд:

  * выкатил исправление на бэкенд и счёл дело сделанным — а панель детектила
    СВОИМ пакетом версии 0.1.2 и продолжала показывать старый вердикт;
  * обошёл потребителей и нашёл CLI на 0.1.0 — на ЧЕТЫРЕ версии позади, при
    том что через него идёт 70% проектов платформы (замер 13.08: cli 569
    против github 224).

Дефект такого рода не виден нигде: каждый репозиторий у себя зелёный, тесты
проходят, прод отвечает. Расходятся ПРАВИЛА, и узнаётся это у пользователя.

═══ ГДЕ ИСТОЧНИК ═══

Версия спеки — `detection/package.json` в соседнем чекауте `../core`
(репозиторий `LayeroInfra/core`, приватный). Без него берётся то, что
опубликовано в npm (`npm view layero-detection version`) — это и есть версия,
которую потребители могут поставить. Нет ни того, ни другого — пропуск
С ПОМЕТКОЙ, не молчаливый зелёный.

Панель — та же проверка со своей стороны:
`frontend/control-plane/check-detection-version.py`.

Запуск:  python3 check-detection-version.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_CORE_SPEC = os.path.join(os.path.dirname(_HERE), "core", "detection", "package.json")

DEP = "layero-detection"


def _read(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _dep_range(pkg: dict, name: str) -> str | None:
    for block in ("dependencies", "devDependencies"):
        val = (pkg.get(block) or {}).get(name)
        if val:
            return val
    return None


def _base(spec_range: str) -> str:
    """`^0.1.4` → `0.1.4`. Диапазон нас не интересует, интересует нижняя граница."""
    return re.sub(r"^[\^~>=<\s]*", "", spec_range).strip()


def _spec_version() -> tuple[str, str] | None:
    if os.path.exists(_CORE_SPEC):
        return _read(_CORE_SPEC)["version"], "../core/detection/package.json"
    try:
        res = subprocess.run(
            ["npm", "view", DEP, "version"],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    got = res.stdout.strip()
    if res.returncode != 0 or not got:
        return None
    return got, f"npm view {DEP} version"


def main() -> int:
    src = _spec_version()
    if src is None:
        print("  — ни соседнего чекаута ../core, ни ответа npm: версия спеки не сверена")
        return 0
    spec_version, origin = src
    fails: list[str] = []

    pkg = _read(os.path.join(_HERE, "package.json"))
    rng = _dep_range(pkg, DEP)
    if rng is None:
        fails.append(f"package.json: нет зависимости {DEP} — CLI отвалился от спеки")
    else:
        want = _base(rng)
        if want != spec_version:
            fails.append(
                f"package.json: {DEP}@{rng} против спеки {spec_version} — "
                f"CLI детектит СТАРЫМИ правилами"
            )
    # Лок обязан совпадать: диапазон `^` разрешает больше, а ставится то,
    # что записано в локе, — именно так CLI и остался на 0.1.0.
    lock_path = os.path.join(_HERE, "package-lock.json")
    if os.path.exists(lock_path):
        lock = _read(lock_path)
        got = None
        for key, node in (lock.get("packages") or {}).items():
            if key.endswith("node_modules/" + DEP):
                got = node.get("version")
                break
        if got and got != spec_version:
            fails.append(
                f"package-lock.json: в локе {DEP}@{got}, а спека {spec_version} — "
                f"диапазон разрешает новое, но ставится закреплённое старое"
            )

    for f in fails:
        print("  ✗", f)
    print(f"\n{'✅' if not fails else '❌'} спека {spec_version} ({origin}), "
          f"расхождений {len(fails)}")
    if fails:
        print(f"  Починка: npm install {DEP}@{spec_version} --save")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
