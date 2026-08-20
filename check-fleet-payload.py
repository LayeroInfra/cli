#!/usr/bin/env python3
"""Проверка: список провижининга сборочного узла цел и остался единственным.

ПОЧЕМУ ОНА ЕСТЬ. 20.08.2026 сборки всей платформы стояли полтора часа, и
причиной был не отказ железа, а разошедшиеся копии одного списка файлов.

Список нужен в двух местах: `cmd_add` в builder-fleet.sh собирает из него
тарбол для нового узла, а setup-fleet-controller.sh раскатывает тот же срез на
core-VM — иначе контроллеру нечем этот тарбол собрать. Пока список был
скопирован в оба скрипта, 18.08 файл `runner-image-updater.sh` добавили в
первый и забыли про второй.

Дальше важна не сама опечатка, а КОГДА она стреляет. Пока жив хоть один узел,
расхождение не проявляется ничем: `add` не вызывается. Оно ждёт момента, когда
YC прервёт узел (машины прерываемые by design) и контроллер пойдёт поднимать
замену, — то есть срабатывает ровно тогда, когда флот уже пуст. `tar` упал с
кодом 2 ДО создания VM, и предохранитель по деньгам этого не заметил: он
считает ПОДНЯТЫЕ машины, а их не создавалось ни одной.

Список сведён в deploy/fleet-payload.txt, и расхождение стало невозможным по
построению. Эта проверка стережёт то, что построением не закрывается:

  1. каждый путь из списка существует на диске — файл могли переименовать или
     удалить, не тронув список, и это тот же отказ с другой стороны;
  2. оба скрипта по-прежнему читают список ИЗ ФАЙЛА, а не завели свою копию
     заново — иначе через полгода мы вернёмся туда же;
  3. список не пуст.

Проверка статическая: смотрит в байты скриптов и в файловую систему, прода не
касается. Живой срез на core-VM сверяет deploy/check-fleet-slice.sh.

Запуск: python3 core/cli/check-fleet-payload.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PAYLOAD = ROOT / "deploy" / "fleet-payload.txt"
FLEET = ROOT / "deploy" / "builder-fleet.sh"
SETUP = ROOT / "deploy" / "setup-fleet-controller.sh"
# 🚨 ТРЕТЬЕ МЕСТО, И САМОЕ ОПАСНОЕ. Именно этот workflow держит копию среза на
# core-VM свежей при каждом push. Его список был ТРЕТЬЕЙ копией и отставал
# сильнее прочих: в нём не было `runner-image-updater.sh` — файла, без
# которого 20.08 подъём узла падал. Хуже того, он синхронизирует
# builder-fleet.sh, но не синхронизировал бы сам список: правка одного лишь
# списка на прод не доезжала бы вовсе, а новый builder-fleet.sh уехал бы туда
# без файла, который ему нужен для работы.
SYNC = ROOT / ".github" / "workflows" / "sync-fleet-provisioning.yml"

# Признаки того, что скрипт берёт список из файла, а не носит свою копию.
# Ищем ровно те конструкции, которые ставят список на место в тарболе:
# пропадёт любая — значит список снова захардкожен или тарбол собирают мимо.
WIRING = (
    (FLEET, "payload_preflight", "вызов проверки списка перед сборкой тарбола"),
    (FLEET, '"${PAYLOAD[@]}"', "тарбол узла собирается из прочитанного списка"),
    (SETUP, "fleet-payload.txt", "установщик читает единый список"),
    (SETUP, '"${SLICE[@]}"', "срез контроллера собирается из прочитанного списка"),
    (SYNC, "fleet-payload.txt", "синхронизация на core-VM читает единый список"),
)


# Где ищем копии. Каталоги сборки и чужие зависимости пропускаем.
SCAN_SUFFIXES = {".sh", ".yml", ".yaml"}
SCAN_SKIP = ("node_modules", ".venv", "/build/", "/.git/")

# Сколько путей из списка в одном файле считаем «перечислением». Два — это
# ещё может быть пара ссылок в тексте; три подряд уже список.
ENUMERATOR_MIN_HITS = 3

# ПОТРЕБИТЕЛИ — не копии списка, и требовать от них чтения fleet-payload.txt
# бессмысленно. setup-builder-node.sh перечисляет файлы потому, что каждому
# нужен СВОЙ путь установки (`источник:назначение`), а не потому, что решает,
# что везти.
#
# 🚨 НО СВЯЗЬ С НИМИ ЖЁСТЧЕ, ЧЕМ У КОПИЙ, И ЛОМАЕТСЯ ТИШЕ. Файл, который
# потребитель ставит, но список не везёт, приедет на узел отсутствующим — и
# провижининг либо промолчит, либо упадёт уже на живой машине. Ровно это и
# было: setup-builder-node.sh ставил runner-image-updater.sh (строка 114), а
# запечка образа его не везла. Поэтому у потребителей сверяется ОТНОШЕНИЕ:
# всё, что они берут из своего каталога, обязано быть в списке.
CONSUMERS = ("deploy/setup-builder-node.sh",)

# `"$HERE/имя:...` и `"$HERE/../infra/.../имя` — то, что скрипт берёт рядом с
# собой, то есть из привезённого среза.
CONSUMER_REF = re.compile(r'\$HERE/((?:\.\./)?[\w./-]+)')


def _enumerators(paths: list[str]):
    """Файлы, которые перечисляют пути провижининга своим списком.

    Возвращает (файл, сколько путей найдено). Сам fleet-payload.txt и эта
    проверка исключены: они и есть источник и его сторож.
    """
    out = []
    for f in sorted(ROOT.rglob("*")):
        if f.suffix not in SCAN_SUFFIXES or not f.is_file():
            continue
        sf = str(f)
        if any(skip in sf for skip in SCAN_SKIP):
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = str(f.relative_to(ROOT))
        if rel in CONSUMERS:
            continue
        hits = sum(1 for p in paths if p in text)
        if hits >= ENUMERATOR_MIN_HITS:
            out.append((f, hits))
    return out


def _consumer_problems(paths: list[str]) -> list[str]:
    """Берёт ли потребитель из среза что-то, чего список не везёт."""
    problems: list[str] = []
    shipped = set(paths)
    for rel in CONSUMERS:
        f = ROOT / rel
        if not f.exists():
            problems.append(f"нет потребителя {rel} — список CONSUMERS устарел")
            continue
        base = Path(rel).parent  # deploy
        for m in CONSUMER_REF.finditer(f.read_text(encoding="utf-8")):
            ref = (base / m.group(1)).as_posix()
            # Нормализуем `deploy/../infra/...` → `infra/...`
            ref = Path(ref).resolve().relative_to(ROOT.resolve()).as_posix() \
                if (ROOT / ref).exists() else ref
            if ref in shipped:
                continue
            # Покрыт ли каталогом из списка (deploy/builder-node/foo.sh).
            if any(ref.startswith(p + "/") for p in shipped):
                continue
            problems.append(
                f"{rel}: берёт из среза «{ref}», но fleet-payload.txt его не везёт — "
                "на узле файла не будет"
            )
    return problems


def _covered_by_paths(trigger_text: str, rel: str) -> bool:
    """Покрыт ли путь списком `paths:` — буквально или глобом-префиксом.

    Глоб `infra/modules/builder_vm/**` покрывает всё под каталогом; писать
    каждый файл отдельно там не нужно и вредно.
    """
    if f"'{rel}'" in trigger_text or f'"{rel}"' in trigger_text:
        return True
    for line in trigger_text.splitlines():
        line = line.strip().lstrip("-").strip().strip("'\"")
        if line.endswith("/**"):
            base = line[:-3]  # без "/**"
            # Каталог покрыт и сам по себе: `deploy/builder-node/**` в триггере
            # означает, что push внутрь каталога запустит workflow, а строка
            # списка при этом — сам каталог, без завершающего слеша.
            if rel == base or rel.startswith(base + "/"):
                return True
    return False


def read_payload() -> list[str]:
    out: list[str] = []
    for line in PAYLOAD.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def main() -> int:
    problems: list[str] = []

    if not PAYLOAD.exists():
        print(
            f"✗ нет файла {PAYLOAD.relative_to(ROOT)}\n\n"
            "WHAT: пропал единый список провижининга.\n"
            "WHY:  без него `add` не знает, что класть на узел, и флот\n"
            "      перестанет пополняться при первом же прерывании узла.\n"
            "FIX:  вернуть файл из git."
        )
        return 1

    paths = read_payload()
    print(f"путей в списке: {len(paths)}")

    if not paths:
        problems.append("список пуст — узел собирать не из чего")

    missing = [p for p in paths if not (ROOT / p).exists()]
    for p in missing:
        problems.append(f"путь из списка не существует: {p}")

    # Триггер workflow — отдельная история: даже читая список из файла, он не
    # запустится, если путь не перечислен в `paths:`. Push с правкой такого
    # файла пройдёт молча, а копия на core-VM останется старой.
    if SYNC.exists():
        sync_text = SYNC.read_text(encoding="utf-8")
        head = sync_text.split("jobs:", 1)[0]  # триггер, не тело job'ы
        for rel in paths + ["deploy/fleet-payload.txt"]:
            if _covered_by_paths(head, rel):
                continue
            problems.append(
                f"sync-fleet-provisioning.yml: путь не в триггере paths: {rel}"
            )

    # 🚨 САМОЕ ВАЖНОЕ ЗДЕСЬ: КОПИИ ИЩУТСЯ, А НЕ ПЕРЕЧИСЛЯЮТСЯ ПОИМЁННО.
    # Первая редакция этой проверки знала три места и считала, что все. Их
    # оказалось ЧЕТЫРЕ: build-builder-image.sh пёк golden image со своим
    # перечислением — и, разумеется, без `runner-image-updater.sh`, как и все
    # прочие копии. Проверка, знающая места поимённо, стережёт вчерашний день:
    # пятая копия появится и не будет замечена ровно так же.
    #
    # Признак копии механический: файл, в котором встречается НЕСКОЛЬКО путей
    # из списка, этот список перечисляет. Значит обязан читать его из файла.
    problems.extend(_consumer_problems(paths))

    for path, hits in _enumerators(paths):
        if "fleet-payload.txt" in path.read_text(encoding="utf-8"):
            continue
        rel = path.relative_to(ROOT)
        problems.append(
            f"{rel}: перечисляет {hits} путей провижининга, но не читает "
            "fleet-payload.txt — это ещё одна копия списка"
        )

    for path, needle, what in WIRING:
        if not path.exists():
            problems.append(f"нет скрипта {path.relative_to(ROOT)}")
            continue
        if needle not in path.read_text(encoding="utf-8"):
            problems.append(
                f"{path.relative_to(ROOT)}: пропало «{needle}» — {what}"
            )

    if not problems:
        print("список цел, оба скрипта читают его из одного файла")
        return 0

    print(f"\n✗ проблем: {len(problems)}\n")
    for p in problems:
        print(f"  {p}")
    print(
        "\nWHAT: список файлов провижининга сборочного узла неполон либо снова\n"
        "      разъехался по двум скриптам.\n"
        "WHY:  это НЕ косметика. Отказ проявится не сейчас, а в момент, когда\n"
        "      YC прервёт узел и контроллер пойдёт поднимать замену, — то есть\n"
        "      когда флот уже пуст и сборки платформы стоят. Предохранитель по\n"
        "      деньгам такое не ловит: он считает поднятые машины, а их в этом\n"
        "      сценарии не создаётся ни одной. Так встали сборки 20.08.2026.\n"
        "FIX:  1) путь не существует — вернуть файл либо убрать строку из\n"
        "         deploy/fleet-payload.txt;\n"
        "      2) пропала связка — не заводите список заново в скрипте: он\n"
        "         обязан читаться из deploy/fleet-payload.txt обоими;\n"
        "      3) после правки — bash core/deploy/setup-fleet-controller.sh,\n"
        "         иначе срез на core-VM отстанет от репозитория."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
