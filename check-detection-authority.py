#!/usr/bin/env python3
"""Гейт: авторитет над типом проекта не должен расползтись обратно.

Эпик DET (11.08) свёл к трём инвариантам то, что раньше было размазано:

  1. `projects.project_type` пишется ТОЛЬКО через `set_project_type`, и тот
     обязан помечать ИСТОЧНИК ('default' | 'detected' | 'user'). Без источника
     автоматика не может уточнять тип, не рискуя отменить решение владельца, —
     и именно поэтому уточнения не было вовсе, а тип устаревал месяцами.
  2. Автоматическое уточнение (`confirm_detected_project_type`) обязано
     проверять `project_type_source = 'default'`. Спорить с владельцем
     платформа перестала намеренно (cntmf, 26.07); гейт держит это решение.
  3. Правила детекта, которые ПЕРЕКЛАССИФИЦИРУЮТ, включаются только там, где
     сборка первая И тип никто не выбирал (`first_build_free` в билдере).
     Живой проект под них попадать не должен: смена вердикта меняет маршрут
     раздачи.

Плюс проверка, что имена конфигов Next нигде не захардкожены помимо спеки —
ровно этот разъезд однажды оставил все проекты на `next.config.ts`
неопознанными как SSR, и заметили это годы спустя.

Запуск:  python3 core/cli/check-detection-authority.py
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES: list[str] = []
CHECKED: list[str] = []


def read(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        FAILURES.append(f"нет файла {rel} — гейт смотрит не туда, поправьте путь")
        return ""
    return p.read_text(encoding="utf-8")


def check(ok: bool, label: str, why: str) -> None:
    CHECKED.append(label)
    if not ok:
        FAILURES.append(f"{label}: {why}")


# 1. Источник типа проекта.
q = read("backend/app/db/queries/projects.py")
check(
    "project_type_source = $3" in q,
    "set_project_type пишет источник",
    "UPDATE не проставляет project_type_source — тип снова станет неотличим "
    "от умолчания колонки, и автоматика либо замолчит, либо затрёт выбор владельца",
)
check(
    'source: str = "user"' in q,
    "умолчание источника — 'user'",
    "все существующие вызовы идут от человека; другое умолчание молча "
    "разрешило бы автоматике переписывать чужой выбор",
)

# 2. Граница автоматического уточнения.
check(
    "project_type_source = 'default'" in q,
    "уточнение проверяет, что тип никто не выбирал",
    "confirm_detected_project_type обязан отказывать при source != 'default'",
)

# 3. Правила, которые переклассифицируют, — только на первой сборке.
#
# ⚠️ Проверяем СВОЙСТВО, а не строку. Раньше здесь искалась буквальная
# `RULES_V2 if first_build_free`, и вынос условий в общую функцию (17.08, чтобы
# сдача индекса не читала переменную из чужой области видимости) покрасил гейт
# при неизменном поведении. Гейт, краснеющий на рефакторинге, учат обходить.
p = read("builder/src/pipeline.py")
_rules_fn = p.split("def build_rules(")[1].split("\ndef ")[0] if "def build_rules(" in p else ""
check(
    bool(_rules_fn)
    and "RULES_V2 if free else None" in _rules_fn
    and 'ctx.get("first_build")' in _rules_fn
    and '!= "user"' in _rules_fn
    and 'ctx.get("prebuilt"' in _rules_fn,
    "RULES_V2 включаются только на первой сборке, при неявном типе и без prebuilt",
    "правила, меняющие вердикт, не должны применяться к живому проекту",
)
check(
    "build_rules(ctx)" in p and "_dcr.RULES_V2" not in p.replace(_rules_fn, ""),
    "правила берутся ОДНОЙ функцией, а не собираются на месте",
    "вторая сборка условий рядом разъедется с первой — и молча",
)
check(
    '!= "user"' in p,
    "билдер уважает выбор владельца",
    "сборка по детекту обязана пропускать проекты, где тип выбрал человек",
)
check(
    'not ctx.get("prebuilt"' in p,
    "сборка по детекту не трогает prebuilt",
    "в prebuilt-архиве лежит готовый артефакт; ветка prebuilt стоит НИЖЕ по "
    "потоку, и без этого условия готовая статика уехала бы в рантайм-сборку",
)

# 4. Возражение при выборе типа.
r = read("backend/app/api/routes/projects.py")
check(
    "type_mismatch" in r and "status_code=409" in r,
    "POST /runtime-type возражает на расхождение",
    "молчаливая запись возвращает нас к отказу через минуты из другого сервиса",
)
check(
    "payload.force" in r,
    "возражение обходится параметром force",
    "возражение обязано быть заметным, но не запирающим — последнее слово за владельцем",
)

# 5. Имена конфигов Next — только из спеки.
_HARDCODED = re.compile(r'["\']next\.config\.(?:js|ts|mjs|cjs)["\']')
for rel in (
    "backend/app/api/routes/projects.py",
    "backend/app/services/project_snapshot.py",
    "backend/app/services/framework_detector.py",
):
    text = read(rel)
    # Разрешаем единственный фолбэк-литерал "next.config.js" (ключ для текста,
    # когда файла в листинге нет вовсе) и упоминания в комментариях.
    code = "\n".join(
        ln for ln in text.splitlines() if not ln.lstrip().startswith("#")
    )
    hits = [m.group(0) for m in _HARDCODED.finditer(code)]
    extra = [h for h in hits if h.strip("\"'") != "next.config.js"]
    check(
        not extra,
        f"{rel}: имена конфигов Next не захардкожены",
        f"найдено {extra} — список обязан браться из detection.spec.json, "
        "иначе он разъедется с тем, по которому матчит детектор",
    )

# ─────────────── 5. Умолчания фреймворка живут ТОЛЬКО в спеке ───────────────
#
# Правило 1 из `docs/BUILD-CONFIG.md`. Вторая таблица «куда фреймворк кладёт
# результат» уже существует — 10 записей из 33 в каталоге панели. Сегодня она
# совпадает со спекой во всех десяти; гейт нужен, чтобы она и дальше не
# разъехалась МОЛЧА: расхождение здесь означает, что мастер обещает один
# каталог, а билдер ищет другой, и человек читает «output dir not found»
# про путь, которого не выбирал.
import json as _json  # noqa: E402

_spec_raw = read("detection/detection.spec.json")
try:
    _spec_out = {
        f["name"]: (f.get("output_dir") or {}).get("default")
        for f in _json.loads(_spec_raw)["frameworks"]
    }
except Exception:  # noqa: BLE001 — спека нечитаема, это и есть провал
    _spec_out = {}
check(
    bool(_spec_out),
    "спека детекта читается и несёт умолчания каталогов",
    "detection.spec.json не разобрался — гейт ниже проверял бы пустоту",
)

_panel = read("../frontend/control-plane/src/lib/frameworkCatalog.ts")
_drift: list[str] = []
if _panel and _spec_out:
    _block = _panel.split("export const FRAMEWORKS")[1].split("];")[0] \
        if "export const FRAMEWORKS" in _panel else ""
    for _name, _out in re.findall(
        r'\{\s*name:\s*"([^"]+)",[^}]*?default_output_dir:\s*"([^"]*)"', _block
    ):
        if _name in _spec_out and _spec_out[_name] != _out:
            _drift.append(f"{_name}: панель {_out!r} ≠ спека {_spec_out[_name]!r}")
check(
    not _drift,
    "каталог панели не расходится со спекой по каталогам вывода",
    "; ".join(_drift) + " — умолчание фреймворка живёт в спеке, "
    "панель обязана читать его оттуда (T-20260824-6)",
)

# ─────────────── 6. Порядок старшинства выражен в одном месте ───────────────
#
# Правило 2 из `docs/BUILD-CONFIG.md`: `layero.json` > настройки > детект.
# Ветка, которая «в этом случае решит иначе», ломает предсказуемость целиком —
# и ломает молча, потому что проявится только на форме входа, попавшей в неё.
_prec = [
    "lcfg.build_cmd or ctx.get(\"build_cmd\")",
    "lcfg.output_dir or ctx.get(\"output_dir\")",
    "lcfg.install_cmd or det.pkg.install_cmd",
]
for _expr in _prec:
    check(
        p.count(_expr) == 1,
        f"старшинство выражено один раз: {_expr.split(' or ')[0]}",
        f"выражение встречается {p.count(_expr)} раз(а) вместо одного — "
        "второй порядок старшинства спорит с первым молча",
    )

print(f"проверок: {len(CHECKED)}, провалов: {len(FAILURES)}")
for f in FAILURES:
    print("  ✗", f)
if FAILURES:
    print(
        "\nWHAT: право менять тип проекта разошлось с кодом — либо появился\n"
        "      второй хозяин решения, либо список конфигов задан вручную.\n"
        "WHY:  тип проекта — решение ВЛАДЕЛЬЦА, автоопределение лишь предлагает.\n"
        "      Когда хозяев становится двое, они спорят молча: проект,\n"
        "      настроенный как Next.js, собирается как статика — и наоборот.\n"
        "      Именно так все проекты на next.config.ts однажды перестали\n"
        "      опознаваться как SSR.\n"
        "FIX:  1) источник типа — настройка проекта; автоопределение пишет\n"
        "         предложение, а не факт;\n"
        "      2) списки конфигов и фреймворков берутся из detection.spec.json,\n"
        "         руками не дублируются;\n"
        "      3) правите детектор — правьте ИСТОЧНИК в core/detection/ и зовите\n"
        "         `node detection/gen.mjs`; свежесть копий проверяет `make gen-check`;\n"
        "      4) «нет файла» значит гейт смотрит не туда — поправьте путь,\n"
        "         а не удаляйте проверку."
    )
sys.exit(1 if FAILURES else 0)
