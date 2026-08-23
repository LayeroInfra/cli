#!/usr/bin/env python3
"""Форма индекса изменилась — значит `INDEX_VERSION` обязан вырасти.

═══ ЗАЧЕМ ═══

`_index_is_current` сверяет `index_version`. Не подняли — старая строка
переиспользуется как годная, нового поля в ней нет НИКОГДА, и функция, которую
выкатили, не работает ни у одного существующего проекта. При этом всё зелёное:
код есть, тесты проходят, прод отвечает.

Ровно так `FIDELITY_FULL` был объявлен и не производился ни разу. И ровно так
23.08.2026 я забыл поднять версию ТРИЖДЫ за одну сессию: `taken_by`,
`signals.match`, `signals.env_committed`. Каждый раз это ловилось замером
вручную, а два раза — уже после пуша.

Дисциплина здесь не работает, потому что поле добавляют в одном файле, а
версию держат в другом. Сторож считает ФОРМУ индекса — набор ключей, который
реально производит `_index_fields`, — и требует, чтобы при её изменении
поднялась версия.

Запуск:  python3 cli/check-index-version.py [--update]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_CORE = os.path.dirname(_HERE)
_LOCK = os.path.join(_HERE, "index-shape.lock.json")

sys.path.insert(0, os.path.join(_CORE, "backend"))


def _shape() -> tuple[int, str]:
    """Версия формы и хеш набора ключей, который производит индекс."""
    from app._detection import detect_core as dc
    from app.services import analyze

    snap = dc.snapshot_from_inputs(
        package_json={"devDependencies": {"vite": "5"}, "scripts": {"build": "vite build"}},
        files=["package.json", "vite.config.ts", "index.html", ".env.example"],
        dirs=["src"],
        config_texts={"vite.config.ts": "export default {}"},
        env_example="API_KEY=x\nVITE_URL=y",
    )
    plan = analyze.plan_from_snapshot(snap, None, analyze.WIZARD_RULES)
    # 🚨 Кандидат ОБЯЗАН быть непустым. Первая редакция гейта передавала
    # `candidates=[]`, и ключи внутри элементов списка в форму не попадали
    # вовсе: 23.08.2026 кандидаты получили `framework`/`project_kind`/
    # `build_cmd`/`output_dir`, а сторож промолчал. Сторож со слепым пятном
    # хуже отсутствующего: на него полагаются.
    idx = analyze._index_fields(
        snap, plan, root="", tree={"dirs": []},
        candidates=[analyze.candidate_facts(snap, analyze.WIZARD_RULES) | {"root": "apps/web"}],
        rules=analyze.WIZARD_RULES,
    )

    def keys(prefix: str, obj) -> list[str]:
        """Ключи формы, включая содержимое элементов списков.

        Списки обходятся по ПЕРВОМУ элементу: форма у элементов одна, а
        обходить все — значит поставить хеш в зависимость от того, сколько
        кандидатов нашлось в образце.
        """
        out: list[str] = []
        if isinstance(obj, dict):
            for k in sorted(obj):
                out.append(f"{prefix}{k}")
                out += keys(f"{prefix}{k}.", obj[k])
        elif isinstance(obj, list) and obj:
            out += keys(f"{prefix}[].", obj[0])
        return out

    # Ключи, а не значения: индекс меняет ЗНАЧЕНИЯ на каждом проекте, а форму —
    # только правкой кода. Версия про форму.
    raw = "\n".join(keys("", idx))
    return analyze.INDEX_VERSION, hashlib.sha256(raw.encode()).hexdigest()[:16]


_CLONE_INDEX = os.path.join(_CORE, "builder", "src", "clone_index.py")


def _builder_version() -> int | None:
    """`INDEX_VERSION` из копии билдера — чтением текста, а не импортом.

    Импортировать нельзя: модуль билдера тянет относительные импорты своего
    пакета, а гейт живёт в `cli/`. Регулярка здесь достаточна — константа
    объявлена одной строкой и вычисляемой быть не может.
    """
    try:
        with open(_CLONE_INDEX, encoding="utf-8") as fh:
            m = re.search(r"^INDEX_VERSION\s*=\s*(\d+)\s*$", fh.read(), re.M)
    except OSError:
        return None
    return int(m.group(1)) if m else None


def main() -> int:
    version, digest = _shape()

    # 🚨 ВЕРСИЯ ЖИВЁТ В ДВУХ ФАЙЛАХ. Индекс пишут два входа: API
    # (`services/analyze.py`) и билдер на клоне (`builder/src/clone_index.py`).
    # Бэкенд сверяет годность по СВОЕЙ версии — значит копия билдера, отставшая
    # на единицу, делает КАЖДЫЙ индекс с флота вечно протухшим: мастер будет
    # перезаказывать анализ при каждом открытии, а нового поля так и не увидит.
    #
    # Гейт про это знал и раньше — но только в тексте подсказки: он СОВЕТОВАЛ
    # поднять обе, не проверяя вторую. Совет, который не проверяется, держится
    # ровно до первой спешки.
    builder_version = _builder_version()
    if builder_version is None:
        print(f"  ✗ не нашёл INDEX_VERSION в {_CLONE_INDEX}")
        return 1
    if builder_version != version:
        print(f"  ✗ INDEX_VERSION разъехался: backend={version}, "
              f"builder={builder_version}")
        print("    Индексы с флота бэкенд будет считать протухшими ВСЕГДА:")
        print("    мастер перезакажет анализ на каждом открытии, а поле не")
        print("    появится ни в одном снимке. Поднимите обе копии.")
        return 1

    if "--update" in sys.argv:
        with open(_LOCK, "w", encoding="utf-8") as fh:
            json.dump({"index_version": version, "shape_sha256": digest}, fh, indent=2)
            fh.write("\n")
        print(f"✅ лок записан: INDEX_VERSION={version}, форма {digest}")
        return 0

    if not os.path.exists(_LOCK):
        print(f"  ✗ нет {_LOCK} — запустите с --update")
        return 1
    with open(_LOCK, encoding="utf-8") as fh:
        lock = json.load(fh)

    if lock.get("shape_sha256") == digest and lock.get("index_version") == version:
        print(f"✅ INDEX_VERSION={version}, форма индекса не менялась")
        return 0

    if lock.get("shape_sha256") != digest and lock.get("index_version") == version:
        print("  ✗ ФОРМА индекса изменилась, а INDEX_VERSION — нет.")
        print(f"      было {lock.get('shape_sha256')}, стало {digest}, версия осталась {version}")
        print("    Сохранённые индексы останутся «годными», нового поля в них не")
        print("    появится никогда, и выкаченная функция не заработает ни у одного")
        print("    существующего проекта — при полностью зелёном прогоне.")
        print("    Починка: поднимите INDEX_VERSION в backend/app/services/analyze.py")
        print("    И в builder/src/clone_index.py (копии обязаны совпадать), затем --update.")
        return 1

    print(f"  ✗ INDEX_VERSION поднят до {version}, а лок ещё на "
          f"{lock.get('index_version')} — запустите --update")
    return 1


if __name__ == "__main__":
    sys.exit(main())
