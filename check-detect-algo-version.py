#!/usr/bin/env python3
"""Правка кода детекта не проезжает мимо `ALGO_VERSION`.

═══ ЗАЧЕМ ═══

`spec_version()` хеширует сигналы фреймворков из спеки — и это ровно ПОЛОВИНА
правил. Вторая половина живёт в коде `detect_core.py`: порядок ветвлений,
откаты, что попадает в поле `framework` у фуллстека. Правка кода спеку не
двигает, сохранённый индекс остаётся «годным» и вечно отдаёт СТАРЫЙ вердикт.

22.08.2026 это поймано на себе: правка «ось платформы уходит из имени
фреймворка у фуллстека» не меняла спеку ни на байт. Четыре живых проекта
продолжали бы показывать человеку `node_web` — правка выкачена и при этом не
работает, то есть «выкатили» неотличимо от «не работает».

Отсюда `ALGO_VERSION`. Но у ручного номера есть ровно одно возражение, и оно
записано в `test_spec_version_follows_the_rules_not_a_hand_written_number`:
номер, который двигают руками, забудут именно тогда, когда он важен. Гейт
существует, чтобы забыть было НЕЛЬЗЯ.

═══ КАК ═══

Считается хеш КОДА `detect_core.py` — по AST, без докстрок и комментариев:
переписанный комментарий не должен обесценивать 650 сохранённых индексов, а
переставленная ветка должна. Записанное значение лежит в `algo-lock.json`
рядом с `ALGO_VERSION`.

Разошлось — два честных выхода, и оба осознанные:
  · вердикт мог поменяться → поднять `ALGO_VERSION` и перезаписать лок;
  · правка косметическая (переименование, форматирование) → только
    перезаписать лок, оставив версию.

    python3 cli/check-detect-algo-version.py --update

Запуск:  python3 cli/check-detect-algo-version.py
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_CORE = os.path.dirname(_HERE)
_SRC = os.path.join(_CORE, "detection", "detect_core.py")
_LOCK = os.path.join(_CORE, "detection", "algo-lock.json")


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    """Докстроки — документация, а не поведение. Иначе разбор «почему так»
    (а его тут пишут много) обесценивал бы каждый сохранённый индекс."""
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef,
                                 ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if (body and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            node.body = body[1:] or [ast.Pass()]
    return tree


def code_hash() -> str:
    with open(_SRC, encoding="utf-8") as fh:
        src = fh.read()
    tree = _strip_docstrings(ast.parse(src))
    return hashlib.sha256(ast.dump(tree).encode()).hexdigest()[:16]


def algo_version() -> int:
    with open(_SRC, encoding="utf-8") as fh:
        m = re.search(r"^ALGO_VERSION\s*=\s*(\d+)", fh.read(), re.M)
    if not m:
        print("  ✗ в detect_core.py нет ALGO_VERSION")
        raise SystemExit(1)
    return int(m.group(1))


def main() -> int:
    got, ver = code_hash(), algo_version()

    if "--update" in sys.argv:
        with open(_LOCK, "w", encoding="utf-8") as fh:
            json.dump({"algo_version": ver, "code_sha256": got}, fh, indent=2)
            fh.write("\n")
        print(f"✅ лок записан: ALGO_VERSION={ver}, код {got}")
        return 0

    if not os.path.exists(_LOCK):
        print(f"  ✗ нет {_LOCK} — запустите с --update")
        return 1
    with open(_LOCK, encoding="utf-8") as fh:
        lock = json.load(fh)

    if lock.get("code_sha256") == got and lock.get("algo_version") == ver:
        print(f"✅ ALGO_VERSION={ver}, код детекта не менялся с последней записи")
        return 0

    if lock.get("code_sha256") != got and lock.get("algo_version") == ver:
        print("  ✗ КОД детекта изменился, а ALGO_VERSION — нет.")
        print(f"      было {lock.get('code_sha256')}, стало {got}, версия осталась {ver}")
        print("    Сохранённые индексы (сейчас их ~650) останутся «годными» и")
        print("    будут вечно отдавать СТАРЫЙ вердикт. Правка выкатится и не")
        print("    заработает — ровно то, ради чего гейт заведён.")
        print("    Починка:")
        print("      · вердикт мог поменяться → поднимите ALGO_VERSION в")
        print("        detection/detect_core.py, затем --update;")
        print("      · правка косметическая → просто --update, версию не трогая.")
        return 1

    print(f"✅ ALGO_VERSION поднят до {ver} — записываю новый лок командой --update")
    print(f"  ✗ лок ещё не обновлён (в нём версия {lock.get('algo_version')})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
