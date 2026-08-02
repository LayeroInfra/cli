#!/usr/bin/env python3
"""Шестая проверка: `npx layero` в текстах обязан быть с `@latest`.

ПОЧЕМУ ОНА ЕСТЬ. `npx layero` без версии НЕ ходит в реестр — он запускает уже
установленную копию: локальную из `node_modules`, а если её нет, глобальную.
Человек, скопировавший команду из наших текстов один раз, годами запускает то,
что поставил тогда.

02.08.2026 это перестало быть теорией:
  * на рабочем ноутбуке стоял глобальный `layero@0.8.11` при опубликованном
    0.8.20 — и `npx layero` десять версий подряд запускал именно его;
  * пользователь сидел на `0.1.x` (версия читает поле `me.handle`,
    переименованное 05.05) — деплой у него не работал в принципе, а
    сообщение отправляло чинить то, что не сломано;
  * нагон версии, который должен был обо всём этом предупредить, не работал
    ни в одном релизе.

Проверка механическая и смотрит в байты, а не в смысл: ищет `npx layero`, за
которым НЕ следует `@`. Исключения — только там, где отсутствие версии
объясняется в самом тексте (объяснение обязано содержать `@latest` рядом) и
в блоках локальной установки, где `npx layero` берёт версию из node_modules
намеренно.

Запуск: python3 core/cli/check-npx-pin.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Каталоги ОПУБЛИКОВАННЫХ поверхностей. Список выверенный: пропавший каталог —
# отказ, а не тихий пропуск (грабля 28.07, см. check-error-codes.py).
SURFACES = (
    "layero-docs/docs",
    "layero-docs/i18n",
    "frontend/landing",
    "core/cli/README.md",
    "mcp/server/prompts",
    "mcp/README.md",
    "mcp/docs",
)

SUFFIXES = {".md", ".mdx", ".txt", ".html", ".json"}

# Поверхности, на которых расхождение = ОТКАЗ. Остальное печатается
# предупреждением, и файл переезжает сюда, когда вычищен (та же схема, что у
# check-typography.py). Лендинг пока в предупреждениях: там 275 вхождений и
# идёт переработка локалей — правку делать после неё, одним проходом.
STRICT = (
    "layero-docs/docs",
    "layero-docs/i18n",
    "core/cli/README.md",
    "mcp/server/prompts",
    "mcp/README.md",
    "mcp/docs",
)

# `npx layero`, за которым НЕ идёт `@`.
PAT = re.compile(r"npx\s+layero(?!@)")

# Места, где отсутствие версии — предмет объяснения, а не ошибка. Смотрим
# ОКРЕСТНОСТЬ, а не строку: объяснение обычно занимает абзац, а перенос строки
# в markdown ставят по ширине. Требование `@latest` рядом оставляет исключение
# привязанным к тексту, который его оправдывает.
def is_explained(lines: list[str], idx: int, window: int = 4) -> bool:
    lo = max(0, idx - window)
    hi = min(len(lines), idx + window + 1)
    return any("@latest" in lines[j] for j in range(lo, hi))


# Блок локальной установки: `npx layero` там берёт версию из node_modules, и
# `@latest` в нём был бы враньём. Признак — соседство с `npm install -D`.
def is_local_install(line: str) -> bool:
    return "npm install -D layero" in line or "npm i -D layero" in line


def main() -> int:
    findings: list[tuple[str, int, str]] = []
    checked = 0
    missing: list[str] = []

    for rel in SURFACES:
        path = ROOT / rel
        if not path.exists():
            missing.append(rel)
            continue
        files = [path] if path.is_file() else [
            p for p in path.rglob("*") if p.suffix in SUFFIXES and p.is_file()
        ]
        for f in files:
            # Собранные артефакты Docusaurus — копия исходников; ловить их
            # значит удваивать вывод на том же дефекте.
            if "/build/" in str(f) or "/node_modules/" in str(f):
                continue
            checked += 1
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            lines = text.splitlines()
            for i, line in enumerate(lines):
                if not PAT.search(line):
                    continue
                if is_explained(lines, i) or is_local_install(line):
                    continue
                findings.append((str(f.relative_to(ROOT)), i + 1, line.strip()[:100]))

    print(f"проверено файлов: {checked}")

    if missing:
        for rel in missing:
            print(f"  ✗ поверхность отсутствует: {rel} — обновите SURFACES")
        return 1

    strict = [f for f in findings if f[0].startswith(STRICT)]
    soft = [f for f in findings if not f[0].startswith(STRICT)]

    if soft:
        by_file: dict[str, int] = {}
        for rel, _, _ in soft:
            by_file[rel] = by_file.get(rel, 0) + 1
        print(f"\n⚠ вне STRICT: {len(soft)} в {len(by_file)} файлах (предупреждение)")
        for rel, n in sorted(by_file.items(), key=lambda x: -x[1])[:10]:
            print(f"    {n:4}  {rel}")
        if len(by_file) > 10:
            print(f"    … ещё {len(by_file) - 10} файлов")

    if not strict:
        print("\nна строгих поверхностях везде `npx layero@latest`")
        return 0

    print(f"\n✗ без @latest на строгих поверхностях: {len(strict)}\n")
    for rel, line_no, snippet in strict[:40]:
        print(f"  {rel}:{line_no}  {snippet}")
    if len(strict) > 40:
        print(f"  … ещё {len(strict) - 40}")
    print(
        "\n`npx layero` без версии запускает уже установленную копию и в реестр "
        "не ходит.\nПишите `npx layero@latest`."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
