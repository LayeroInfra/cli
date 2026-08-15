#!/usr/bin/env python3
"""Гейт: мест, где запускается детект, может стать только МЕНЬШЕ.

«Единый артефакт для анализа кода» — цель плана ANALYZE-STAGE-PLAN, но ни
один его этап не делает артефакт единым сам по себе: этап A артефакт
создаёт (потребителей ноль, работа в тени), этап B переводит мастер, этап C
— билдер. Пока это счётчик, свойство остаётся намерением, а намерения у нас
уже трижды оставались абстракцией с одним потребителем.

СЕГОДНЯ ПЯТЬ НЕЗАВИСИМЫХ ВХОДОВ, каждый на своём снимке разной полноты:

  1. `_type_objection` — снимок `project_snapshot` (root_only / archive);
  2. `framework_detector` — свои чтения из ручек мастера;
  3. билдер — ПОЛНЫЙ клон на диске;
  4. рантайм-билдер — свой проход;
  5. CLI (`cli/src/detect.ts`) — диск пользователя, копия ядра на TypeScript,
     и она же пишет тип проекта обратно. Это 70% проектов, и ни один этап
     плана её не касается.

Расходятся не правила — правила общие (`detection/`, гейт `detection-check`
держит копии байт-в-байт). Расходятся ВХОДЫ. Отсюда весь класс «мастер
сказал одно, билдер другое»: `detect/type_mismatch` — 31 отказ на 19
проектах за три недели.

🚨 ЧИСЛО ПАДАЕТ, КОГДА ПОТРЕБИТЕЛЬ ПЕРЕХОДИТ НА ГОТОВЫЙ ПЛАН, а не когда
кто-то правит эту цифру. Цель этапа C — ноль вне модуля анализа.

Запуск:  python3 core/cli/check-detect-call-sites.py
"""
from __future__ import annotations

import pathlib
import re
import sys

CORE = pathlib.Path(__file__).resolve().parent.parent

# ЗАПУСК детекта, а не его определение, не упоминание в докстроке и не
# `SomeFramework.detect()` — последнее у билдера своя, старая механика проб
# по фреймворкам, а не вход анализа.
_CALLS = re.compile(
    r"(?<!def )(?<!function )(?:"
    r"(?:_dc|_dcr|detect_core)\.detect\("
    r"|(?<![.\w])detect\("
    r"|(?<![.\w])detectProject\("
    r")"
)

# Блочные комментарии TypeScript. Для Python строки и комментарии снимает
# `tokenize` — регулярка на тройных кавычках ломается о `"""` внутри обычной
# строки и молча съедает код вместе с докстрокой.
_TS_BLOCK = re.compile(r"/\*.*?\*/", re.S)

# Где сегодня стоят входы. Ключ — файл, значение — сколько запусков в нём
# допустимо. Замер 15.08.2026.
#
# 🚨 ЧИСЛО РОСЛО ДВАЖДЫ ЗА ОДИН ДЕНЬ: 7 → 8 → 9. Записано здесь, а не
# замолчано, и это единственная причина, по которой гейт вообще чего-то стоит.
#
# Оба раза — входы этапа A, по одному на источник: `archive_snapshot.py`
# считает вердикт на полном снимке АРХИВА, `clone_index.py` — на полном КЛОНЕ.
# Оба существуют потому, что полного снимка не было ни у кого, и оба —
# кандидаты остаться единственными.
#
# ⚠️ УСЛОВИЕ СДЕЛКИ, и его надо проверить, а не запомнить: два новых входа
# держат потолок 1 каждый, а СТАРЫЕ обязаны падать до нуля по мере перехода
# потребителей на вмороженный план (этап C). Если через месяц сумма не ниже
# девяти — сделка не выполнена, и видно это прямо отсюда. Третий подъём без
# падения старых означает, что гейт превратился в журнал роста.
CEILINGS: dict[str, int] = {
    "backend/app/services/archive_snapshot.py": 1,    # этап A: снимок архива
    "builder/src/clone_index.py": 1,                  # этап A: снимок клона
    "backend/app/api/routes/projects.py": 1,      # возражение при выборе типа
    "backend/app/services/framework_detector.py": 2,  # мастер: вердикт + фуллстек
    "builder/src/pipeline.py": 1,                 # сборка
    "builder/src/runtime_detect.py": 1,           # сборка, рантайм-ветка
    "cli/src/commands/deploy.ts": 1,              # 🚨 диск пользователя, 70% проектов
    "cli/src/commands/init.ts": 1,
}

# Модуль модели: внутри него detect() и определён, и зовётся сам собой.
SKIP_DIRS = ("_detection", "detection", "node_modules", ".venv", "dist", "__pycache__")

_COMMENT_PREFIXES = ("#", "//", "*", "/*")


def _code_only(path: pathlib.Path) -> str:
    """Исходник без строк и комментариев — чтобы объяснения были бесплатными."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix == ".py":
        import io
        import tokenize
        lines = text.splitlines(keepends=True)
        try:
            spans = [
                (t.start, t.end)
                for t in tokenize.generate_tokens(io.StringIO(text).readline)
                if t.type in (tokenize.STRING, tokenize.COMMENT)
            ]
        except (tokenize.TokenError, IndentationError, SyntaxError):
            # Нечитаемый файл — не повод пропустить его молча: считаем как есть,
            # то есть строже, а не мягче.
            return text
        # Затираем НА МЕСТЕ, сохраняя раскладку файла. Склейка токенов через
        # пробел разорвала бы `_dc.detect(` на три части, а через пустую строку
        # слепила бы `def` с `detect(` — вызов и определение стали бы
        # неразличимы. Позиции не врут ни там, ни там.
        for (sr, sc), (er, ec) in spans:
            if sr == er:
                ln = lines[sr - 1]
                lines[sr - 1] = ln[:sc] + " " * (ec - sc) + ln[ec:]
            else:
                lines[sr - 1] = lines[sr - 1][:sc] + "\n"
                for row in range(sr, er - 1):
                    lines[row] = "\n"
                lines[er - 1] = " " * ec + lines[er - 1][ec:]
        return "".join(lines)
    text = _TS_BLOCK.sub("", text)
    return "\n".join(
        ln for ln in text.splitlines() if not ln.lstrip().startswith(_COMMENT_PREFIXES)
    )


def _count(path: pathlib.Path) -> int:
    return len(_CALLS.findall(_code_only(path)))


def main() -> int:
    failures: list[str] = []
    lowered: list[str] = []
    total = 0

    for rel, ceiling in sorted(CEILINGS.items()):
        path = CORE / rel
        if not path.exists():
            failures.append(f"нет файла {rel} — гейт смотрит не туда, поправьте путь")
            continue
        got = _count(path)
        total += got
        if got > ceiling:
            failures.append(
                f"{rel}: запусков детекта {got}, потолок {ceiling}. "
                "Ещё один вход анализа — ещё один снимок своей полноты; "
                "читайте готовый план, а не запускайте детект заново"
            )
        elif got < ceiling:
            lowered.append(f"{rel}: {ceiling} → {got}")

    # Новый файл с детектом мимо списка — это ровно то, что список должен
    # ловить: без обхода он проверял бы только известное.
    known = set(CEILINGS)
    for path in sorted(CORE.rglob("*.py")) + sorted(CORE.rglob("*.ts")):
        rel = path.relative_to(CORE).as_posix()
        if rel in known or any(part in SKIP_DIRS for part in path.parts):
            continue
        if rel.startswith(("cli/test/", "backend/tests/")) or "/test" in rel:
            continue
        got = _count(path)
        if got:
            failures.append(
                f"{rel}: детект запускается в файле, которого нет в списке "
                f"({got}). Либо это новый вход анализа — тогда он не нужен, "
                "либо список устарел"
            )

    print(f"запусков детекта вне модуля модели: {total}")
    for line in lowered:
        print(f"  ↓ вход снят — {line}; обновите CEILINGS")
    for line in failures:
        print(f"  ✗ {line}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
