#!/usr/bin/env python3
"""Потребители `layero-detection` не отстают от опубликованной спеки.

═══ ЗАЧЕМ ═══

Ядро детекта одно, а зависимость на него — СВОЯ У КАЖДОГО потребителя, и до
22.08.2026 за их синхронностью не следило ничто. В тот день это стоило двух
неверных выводов подряд:

  * выкатил исправление на бэкенд и счёл дело сделанным — а панель детектила
    СВОИМ пакетом версии 0.1.2 и продолжала показывать старый вердикт;
  * обошёл потребителей и нашёл CLI на 0.1.0 — на ЧЕТЫРЕ версии позади, при
    том что через него идёт 70% проектов платформы (замер 13.08: cli 569
    против github 224).

Дефект такого рода не виден нигде: каждый репозиторий у себя зелёный, тесты
проходят, прод отвечает. Расходятся ПРАВИЛА, и узнаётся это у пользователя.

Гейт покрывает потребителей ВНУТРИ core (сейчас `cli/`). Панель живёт в чужом
репозитории, и тянуть её сюда нельзя — состояние core не должно зависеть от
соседа. Для неё та же проверка стоит в `frontend`, цель `check-crossrepo`.

Запуск:  python3 cli/check-detection-version.py
"""
from __future__ import annotations

import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_CORE = os.path.dirname(_HERE)

# Потребители внутри core: путь к package.json → как называется зависимость.
CONSUMERS = [("cli/package.json", "layero-detection")]
SPEC_PKG = "detection/package.json"


def _read(rel: str) -> dict:
    with open(os.path.join(_CORE, rel), encoding="utf-8") as fh:
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


def main() -> int:
    spec_version = _read(SPEC_PKG)["version"]
    fails: list[str] = []

    for rel, dep in CONSUMERS:
        pkg = _read(rel)
        rng = _dep_range(pkg, dep)
        if rng is None:
            fails.append(f"{rel}: нет зависимости {dep} — потребитель отвалился от спеки")
            continue
        want = _base(rng)
        if want != spec_version:
            fails.append(
                f"{rel}: {dep}@{rng} против спеки {spec_version} — "
                f"этот потребитель детектит СТАРЫМИ правилами"
            )
        # Лок обязан совпадать: диапазон `^` разрешает больше, а ставится то,
        # что записано в локе, — именно так CLI и остался на 0.1.0.
        lock_rel = rel.replace("package.json", "package-lock.json")
        lock_path = os.path.join(_CORE, lock_rel)
        if os.path.exists(lock_path):
            with open(lock_path, encoding="utf-8") as fh:
                lock = json.load(fh)
            got = None
            for key, node in (lock.get("packages") or {}).items():
                if key.endswith("node_modules/" + dep):
                    got = node.get("version")
                    break
            if got and got != spec_version:
                fails.append(
                    f"{lock_rel}: в локе {dep}@{got}, а спека {spec_version} — "
                    f"диапазон разрешает новое, но ставится закреплённое старое"
                )

    for f in fails:
        print("  ✗", f)
    print(f"\n{'✅' if not fails else '❌'} спека {spec_version}, "
          f"потребителей {len(CONSUMERS)}, расхождений {len(fails)}")
    if fails:
        print("  Починка: npm install layero-detection@<версия> --save в каталоге потребителя")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
