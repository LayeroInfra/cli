#!/usr/bin/env python3
"""Опубликованная схема `layero.json` не расходится с контрактом.

═══ ЗАЧЕМ ГЕЙТ ═══

Имена ключей живут в спеке (`detection/detection.spec.json`, раздел `layero`) —
это дом, ради которого 26.08.2026 таблица алиасов туда и переезжала.
Опубликованная схема `frontend/landing/schema/layero-v2.json` — ЧЕТВЁРТАЯ
копия тех же имён, в другом репозитории, и её не сверял ничем никто.

🚨 Расхождения были уже на момент заведения гейта:

  * у обеих половин объявлен `nodeVersion`, а короткого `node` НЕТ — хотя он
    работает (`_layero_node_pin` его читает). Контракт обещает «оба набора
    имён, навсегда», схема половину обещания не знала;
  * у `backend` объявлен `build`, который не применяет НИКТО.

Схема — то, что человек видит первым: редактор подставляет её по `$schema`.
Расхождение с реальным разбором учит не доверять ни ей, ни контракту.

═══ ЧТО ИМЕННО СВЕРЯЕТСЯ ═══

В ОБЕ стороны, по каждой половине: набор свойств схемы обязан совпасть с
набором ключей этой половины из спеки плюс их canon-именами. Лишнее в схеме —
обещание, которого платформа не исполняет; недостающее — работающее имя, о
котором редактор не скажет.

⚠️ Соседний репозиторий может быть не выкачен. Тогда гейт говорит об этом
вслух и отказывает: «файла нет» значит «смотрю не туда», а не «всё хорошо».

Запуск:  python3 cli/check-layero-schema.py
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = ROOT / "detection" / "detection.spec.json"
SCHEMA = ROOT.parent / "frontend" / "landing" / "schema" / "layero-v2.json"

fails: list[str] = []


def fail(msg: str) -> None:
    fails.append(msg)


def main() -> int:
    layero = json.loads(SPEC.read_text(encoding="utf-8"))["layero"]
    aliases: dict[str, str] = layero["aliases"]
    canon_of = {short: canon for canon, short in aliases.items()}

    if not SCHEMA.exists():
        print(f"  ✗ схемы нет по пути {SCHEMA}")
        print("    Гейт смотрит в соседний репозиторий `frontend`. Нет файла —")
        print("    значит он не выкачен ЛИБО схему перенесли. Поправьте путь,")
        print("    а не удаляйте проверку.")
        return 1

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    props = schema.get("properties") or {}

    for half, keys in (layero.get("half_keys") or {}).items():
        half_props = set(((props.get(half) or {}).get("properties") or {}))
        if not half_props:
            fail(f"схема не описывает половину `{half}` вовсе")
            continue
        dolzhno = set(keys) | {canon_of[k] for k in keys if k in canon_of}
        lishnee = sorted(half_props - dolzhno)
        netu = sorted(dolzhno - half_props)
        if lishnee:
            fail(f"`{half}`: схема обещает то, чего платформа не применяет: "
                 f"{', '.join(lishnee)}")
        if netu:
            fail(f"`{half}`: работающие имена не объявлены в схеме: "
                 f"{', '.join(netu)}")

    # Верхний уровень: каждый алиас обязан быть назван, иначе редактор ругнётся
    # на канон контракта.
    verh = set(props)
    ne_nazvany = sorted(set(aliases) - verh)
    if ne_nazvany:
        fail(f"корень: алиасы контракта не объявлены: {', '.join(ne_nazvany)}")

    # Значения `layout` — оттуда же, откуда их проверяет платформа.
    layouts = set(layero.get("layouts") or ())
    v_scheme = set(((props.get("layout") or {}).get("enum") or ()))
    if layouts != v_scheme:
        fail(f"`layout`: спека знает {sorted(layouts)}, схема — {sorted(v_scheme)}")

    for f in fails:
        print("  ✗", f)
    poloviny = len(layero.get("half_keys") or {})
    print(f"\n{'✅' if not fails else '❌'} схема сверена со спекой: "
          f"половин {poloviny}, алиасов {len(aliases)}, расхождений {len(fails)}")
    if fails:
        print("\nWHAT: опубликованная схема `layero.json` разошлась с контрактом.")
        print("WHY:  схему подставляет редактор по `$schema` — это первое, что")
        print("      видит человек. Расхождение учит не доверять ни ей, ни")
        print("      контракту, и найдёт его владелец, а не мы.")
        print("FIX:  имена живут в `detection/detection.spec.json` (раздел")
        print("      `layero`). Правьте схему под них, а не наоборот.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
