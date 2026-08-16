#!/usr/bin/env python3
"""Гейт: ветвления по строковым значениям типа проекта могут только УБЫВАТЬ.

`project_type`, `runtime_kind` и `framework_hint` — три пересекающиеся оси,
и плоский список значений смешивает четыре независимых измерения: как
раздавать (`spa` — способ раздачи), чем запускать (`python_web` — язык),
какой фреймворк (`ssr_next`, `streamlit`, `flask`). Отсюда несопоставимые
члены в одном перечислении и `flask ⊂ python_web` в живых данных.

Пока каждый потребитель ветвится по этим строкам сам, новый фреймворк с
сервером (Nuxt SSR, Remix, SvelteKit на adapter-node) нельзя завести без
нового члена перечисления и правки во всех местах разом. Целевая модель —
`BuildUnit`/`BuildPlan`, они уже написаны и заперты внутри детекта.

ЧТО РАЗРЕШЕНО. Ветвление по значениям — дело МОДУЛЯ МОДЕЛИ (`detection/`):
там оно и должно быть, это его предмет. Всем остальным — потолок, который
опускают, переводя потребителя на модель.

🚨 ПОТОЛОК ОПУСКАЮТ, СНЯВ ВЕТВЛЕНИЕ, А НЕ ПОДНЯВ ЧИСЛО. Правка, которой
нужно новое ветвление по строке типа, — это правка, которой нужна модель.

Файлы фронтенда лежат в ДРУГОМ репозитории (`LayeroInfra/frontend`). В CI
ядра их нет, и гейт про них честно печатает «не проверен», а не молчит:
непроверенная поверхность, о которой не сказано вслух, читается как
проверенная — на этом мы уже обожглись с cursor.directory.

Запуск:  python3 core/cli/check-type-branching.py
"""
from __future__ import annotations

import pathlib
import re
import sys

CEILING_HELP = (
    "\nWHAT: прямых входов стало больше, чем разрешает потолок в CEILINGS.\nWHY:  это храповик, а не запрет. Он не даёт числу обходных путей расти:\n      каждый новый прямой вход — ещё одно место, где решение принимается\n      мимо единственного хозяина, и расхождение всплывает не здесь,\n      а на чужом проекте, собранном не тем способом.\nFIX:  1) новый вход не нужен — зовите модель, а не источник напрямую;\n      2) вход обоснован — обсудите и поднимите потолок в CEILINGS ЯВНО,\n         отдельной строкой с комментарием почему;\n      3) видите «потолок снят не до конца» — опустите число в CEILINGS:\n         невычищенный потолок перестаёт что-либо значить."
)

CORE = pathlib.Path(__file__).resolve().parent.parent
WORKSPACE = CORE.parent

# Значения трёх осей. `static` и `generic` не берём: это не тип приложения,
# а имена фреймворков-заглушек, и они живут в спеке как данные.
_VALUES = (
    "spa", "ssr_next", "ssr_node", "node_web", "python_web",
    "streamlit", "gradio", "flask",
)
_LITERAL = re.compile(r"""["'](""" + "|".join(_VALUES) + r""")["']""")

# Потолки. Замер 15.08.2026, счётчик литералов в КОДЕ (без комментариев).
CEILINGS: dict[str, int] = {
    "core/builder/src/pipeline.py": 45,
    "frontend/control-plane/src/pages/Project/Settings.tsx": 21,
    "frontend/control-plane/src/pages/ProjectSetup.tsx": 14,
    "core/backend/app/api/routes/projects.py": 9,
    "core/backend/app/services/framework_detector.py": 1,
}

# Модуль модели: здесь ветвление по значениям — предмет файла, а не протечка.
ALLOWED = (
    "core/detection/",
    "core/backend/app/_detection/",
    "core/builder/src/_detection/",
    "core/runtime/builder/app/_detection/",
)

_COMMENT_PREFIXES = ("#", "//", "*", "/*")


def _count(path: pathlib.Path) -> int:
    code = "\n".join(
        ln for ln in path.read_text(encoding="utf-8").splitlines()
        if not ln.lstrip().startswith(_COMMENT_PREFIXES)
    )
    return len(_LITERAL.findall(code))


def main() -> int:
    failures: list[str] = []
    unchecked: list[str] = []
    lowered: list[str] = []
    total = 0

    for rel, ceiling in sorted(CEILINGS.items(), key=lambda kv: -kv[1]):
        path = WORKSPACE / rel
        if not path.exists():
            unchecked.append(rel)
            continue
        got = _count(path)
        total += got
        if got > ceiling:
            failures.append(
                f"{rel}: ветвлений по строковым типам {got}, потолок {ceiling}. "
                "Новое ветвление — заявка на новый член перечисления; "
                "решение принимает модель (core/detection), а не потребитель"
            )
        elif got < ceiling:
            lowered.append(f"{rel}: {ceiling} → {got}")

    print(f"ветвлений по строковым типам вне модели: {total}")
    for rel in unchecked:
        print(f"  ? не проверен (другой репозиторий): {rel}")
    for line in lowered:
        print(f"  ↓ потолок снят не до конца — {line}; обновите CEILINGS")
    for line in failures:
        print(f"  ✗ {line}")
    if ALLOWED and not any((WORKSPACE / a).exists() for a in ALLOWED):
        print(
            "  ✗ ни одного каталога модели не найдено — гейт смотрит не туда\n"
            "\nWHAT: каталоги из ALLOWED отсутствуют на диске.\n"
            "WHY:  проверка ослепла: не найдя предмет, она перестаёт мерить и\n"
            "      при этом легко выглядит успешной. Молча усохший охват —\n"
            "      тихая потеря гейта.\n"
            "FIX:  модуль переехал — поправьте ALLOWED в начале скрипта;\n"
            "      запускать из рабочего корня."
        )
        return 1
    if failures:
        print(CEILING_HELP)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
