#!/usr/bin/env python3
"""Проверка: тег образа активатора объявлен на узле РОВНО в одном файле.

ПОЧЕМУ ОНА ЕСТЬ. До 17.09.2026 тег лежал на rt-prod-1 дважды:
`/etc/layero/runtime-node.env` (его правит `swap-activator.sh`, и он же идёт в
`compose --env-file`) и `/opt/layero/deploy/.env` (его писал провижининг). Живой
тег менялся только в первом, второй отстал на месяцы: `farm-622a1723` против
`gc-in-use-1`. Ни на что это не влияло ровно до тех пор, пока все команды
передавали `--env-file`. Любой `docker compose up` из каталога рядом с compose
без флага поднял бы агента на образе многомесячной давности — и вывод команды
выглядел бы совершенно обычным (`T-20260917-36`).

Класс — «вторая копия значения = отложенный тихий отказ», жёсткое ограничение №7
в core/AGENTS.md. Копию убрали; эта проверка стережёт, чтобы её не завели снова,
и заодно то, что делает промах громким: подстановку `${LAYERO_ACTIVATOR_TAG:?…}`
без фолбэка в compose. Без `:?` пустая переменная снова вырождалась бы в `latest`.

Проверка статическая: читает файлы репозитория, прода не касается. Живое
состояние узла сверяет проверка тикета T-20260917-36.

Запуск: python3 core/cli/check-activator-tag-source.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

COMPOSE = ROOT / "deploy" / "docker-compose.runtime-node.yml"
SWAP = ROOT / "deploy" / "swap-activator.sh"
ENV_PATH = "/etc/layero/runtime-node.env"

SCAN_DIRS = (ROOT / "deploy", ROOT / "runtime", ROOT / "infra")
SCAN_SUFFIXES = {".sh", ".yml", ".yaml", ".py", ".service", ".timer"}
SCAN_SKIP = ("node_modules", ".venv", "/build/", "/.git/", "/.claude/")

# Запись тега в файл: `LAYERO_ACTIVATOR_TAG=` уезжает куда-то через `>`/`>>`
# или tee. Разрешена ровно одна цель — ENV_PATH.
WRITE_RE = re.compile(
    r"LAYERO_ACTIVATOR_TAG=[^\n]*?(?:>>?\s*|\|\s*(?:sudo\s+)?tee\s+(?:-a\s+)?)(\S+)"
)
# Правка на месте (sed -i) того же ключа — тоже объявление тега.
SED_RE = re.compile(r"sed\s+-i[^\n]*LAYERO_ACTIVATOR_TAG[^\n]*")

problems: list[str] = []


def _files():
    for d in SCAN_DIRS:
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*")):
            if not p.is_file() or p.suffix not in SCAN_SUFFIXES:
                continue
            s = str(p)
            if any(skip in s for skip in SCAN_SKIP):
                continue
            yield p


for path in _files():
    text = path.read_text(encoding="utf-8", errors="replace")
    rel = path.relative_to(ROOT)
    for m in WRITE_RE.finditer(text):
        target = m.group(1).strip('"\'')
        if target != ENV_PATH:
            problems.append(
                f"{rel}: тег пишется ещё и в {target} — это вторая копия значения"
            )
    for m in SED_RE.finditer(text):
        if ENV_PATH not in m.group(0) and "$ENV_FILE" not in m.group(0):
            problems.append(f"{rel}: правка тега мимо {ENV_PATH}: {m.group(0)[:90]}")

# Сам источник обязан существовать: без него проверка выше зелена «потому что
# писать тег вообще перестали».
if not SWAP.is_file() or ENV_PATH not in SWAP.read_text(encoding="utf-8"):
    problems.append(
        f"deploy/swap-activator.sh больше не правит {ENV_PATH} — единственный источник пропал"
    )

# Громкость промаха. `:-latest` здесь означал бы, что забытый `--env-file`
# ставит на узел неизвестный образ вместо внятного отказа.
compose_text = COMPOSE.read_text(encoding="utf-8") if COMPOSE.is_file() else ""
if "${LAYERO_ACTIVATOR_TAG:?" not in compose_text:
    problems.append(
        "deploy/docker-compose.runtime-node.yml: подстановка тега без `:?` — "
        "промах мимо --env-file снова стал бы тихим"
    )

if problems:
    print("\n".join(f"  ✗ {p}" for p in problems))
    print(
        "\nWHAT: тег образа активатора объявлен больше чем в одном месте "
        "(или промах перестал быть громким)."
        f"\nWHY:  вторая копия правится не тем, кто меняет живой тег, и отстаёт молча."
        f"\n      17.09.2026 копия отстала на месяцы, и любой compose без --env-file"
        f"\n      поднял бы агента на образе многомесячной давности (T-20260917-36)."
        f"\nFIX:  единственный источник — {ENV_PATH}; менять его "
        "`swap-activator.sh`,\n      а командам compose передавать --env-file."
    )
    sys.exit(1)

print(f"тег активатора объявлен только в {ENV_PATH}, промах громкий")
