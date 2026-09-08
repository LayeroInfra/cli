#!/usr/bin/env python3
"""Процессы шлюза данных перечислены одинаково во ВСЕХ местах — ARCH-06.

🚨 ЗАЧЕМ. Шлюз работает в несколько процессов отдельными контейнерами, и их
список сегодня живёт в ПЯТИ местах:

  * `deploy/docker-compose.data.yml` — сами контейнеры (свой проект,
    вынесен 08.09.2026 ради дешёвого переезда, см. `docs/DATA-PLANE-MOVE.md`);
  * `infra/nginx/layero.conf.template` — upstream, куда edge раздаёт трафик;
  * `infra/monitoring/vmagent.yml.template` — цели скрейпа (метрики живут в
    памяти процесса, поэтому каждый скрейпится сам по себе);
  * `deploy/ci-deploy-data.sh` — порядок выкатки по одному;
  * `deploy/setup-edge-api-reloader.sh` — за какими контейнерами следит вотчер,
    перезагружающий edge при смене их docker-IP.

Расхождение любого из них не ломает ничего немедленно — и в этом вся беда.
Забыли добавить процесс в upstream — он поднят, обновлён, но трафика не видит;
забыли в vmagent — половина занятости пула и половина счётчика ответов просто
не существуют, а графики выглядят правдоподобно; забыли в скрипте выкатки — он
остаётся на старом образе, и «работает через раз» никто не связывает с ним.

Это тот же класс, что жёсткое ограничение №7 в AGENTS.md: список
провижининга узла разошёлся по четырём местам и ждал момента, когда
понадобится замена узла. Сработало при пустом флоте, простой полтора часа.

⚠️ Гейт НЕ делает число процессов параметром — он делает расхождение
невозможным. Полная генерация из одного источника при двух процессах стоила бы
дороже, чем даёт; когда процессов станет больше двух, это станет следующим
шагом, и гейт к тому времени уже будет знать, где искать.

🚨 ПЯТОЕ МЕСТО НАЙДЕНО ТОЛЬКО 08.09.2026, спустя месяц после четырёх первых, —
и это главный урок про такие гейты. Список «всех мест» сам был неполон: вотчер
перезагрузки edge знал один процесс из двух, а гейт, сводивший четыре места,
считал себя исчерпывающим. Заводя проверку на расхождение копий, ищи копии
ЗАНОВО при каждом касании темы, а не доверяй списку из шапки.

Выход: 0 — списки сходятся; 1 — нет.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def from_compose() -> set[str]:
    """Контейнеры, поднятые из образа шлюза."""
    src = (ROOT / "deploy" / "docker-compose.data.yml").read_text(encoding="utf-8")
    names: set[str] = set()
    block: list[str] = []
    for line in src.splitlines():
        if re.match(r"^  \w[\w-]*:\s*$", line):
            if any("layero-data:" in x for x in block):
                for x in block:
                    m = re.search(r"container_name:\s*(\S+)", x)
                    if m:
                        names.add(m.group(1))
            block = []
        block.append(line)
    if any("layero-data:" in x for x in block):
        for x in block:
            m = re.search(r"container_name:\s*(\S+)", x)
            if m:
                names.add(m.group(1))
    return names


def from_nginx() -> set[str]:
    src = (ROOT / "infra" / "nginx" / "layero.conf.template").read_text(encoding="utf-8")
    block = re.search(r"upstream\s+layero_data\s*\{(.+?)\}", src, re.S)
    if not block:
        return set()
    return set(re.findall(r"server\s+([\w-]+):\d+", block.group(1)))


def from_vmagent() -> set[str]:
    src = (ROOT / "infra" / "monitoring" / "vmagent.yml.template").read_text(encoding="utf-8")
    block = re.search(r"job_name:\s*layero-data\b(.+?)(?=\n  - job_name:|\Z)", src, re.S)
    if not block:
        return set()
    return set(re.findall(r"targets:\s*\['([\w-]+):\d+'\]", block.group(1)))


def from_deploy() -> set[str]:
    """Имена СЕРВИСОВ compose из цикла выкатки — приводим к именам контейнеров."""
    src = (ROOT / "deploy" / "ci-deploy-data.sh").read_text(encoding="utf-8")
    loop = re.search(r"for svc in ([\w\s-]+); do", src)
    if not loop:
        return set()
    return {f"layero-{name}" for name in loop.group(1).split()}


def from_reloader() -> set[str]:
    """Контейнеры, за стартом которых следит вотчер перезагрузки edge.

    🚨 ПЯТОЕ МЕСТО, И ОНО САМОЕ ТИХОЕ ИЗ ПЯТИ. Вотчер перезагружает edge, когда
    контейнер из upstream рождается заново: без этого edge держит старый
    docker-IP и отдаёт 502. До 08.09.2026 в списке был только `layero-data`, а
    `layero-data-2` — нет. Дыра не проявлялась потому, что скрипт выкатки
    всегда пересоздаёт ОБА, и reload прилетал от первого: защита работала как
    побочный эффект порядка выкатки, а не как правило.

    ⚠️ Здесь СВЕРХМНОЖЕСТВО: вотчер следит ещё и за цветами api. Поэтому
    сравнение не на равенство, а на вхождение — требовать равенства значило бы
    заставить его забыть про api.
    """
    src = (ROOT / "deploy" / "setup-edge-api-reloader.sh").read_text(encoding="utf-8")
    return set(re.findall(r'--filter\s+"container=([\w-]+)"', src))


def main() -> int:
    места = {
        "compose": from_compose(),
        "nginx upstream": from_nginx(),
        "vmagent": from_vmagent(),
        "скрипт выкатки": from_deploy(),
    }
    пустые = [имя for имя, набор in места.items() if not набор]
    if пустые:
        for имя in пустые:
            print(f"  ✘ {имя}: список процессов не найден — разбор сломан "
                  "или файл переименован", file=sys.stderr)
        return 1

    эталон = места["compose"]
    беды = []

    # Вотчер проверяется вхождением, а не равенством, — см. `from_reloader`.
    вотчер = from_reloader()
    if not вотчер:
        print("  ✘ вотчер перезагрузки edge: список контейнеров не найден — "
              "разбор сломан или файл переименован", file=sys.stderr)
        return 1
    забыты = эталон - вотчер
    if забыты:
        беды.append(
            f"вотчер перезагрузки edge не следит за [{', '.join(sorted(забыты))}]: "
            "пересоздание такого процесса оставит edge со старым docker-IP, "
            "и он будет отдавать 502 на его долю запросов"
        )

    for имя, набор in места.items():
        if набор != эталон:
            лишние = ", ".join(sorted(набор - эталон)) or "—"
            нет = ", ".join(sorted(эталон - набор)) or "—"
            беды.append(f"{имя}: лишние [{лишние}], отсутствуют [{нет}]")

    if беды:
        print("  ✘ списки процессов шлюза разошлись (эталон — compose: "
              f"{', '.join(sorted(эталон))})", file=sys.stderr)
        for беда in беды:
            print(f"    · {беда}", file=sys.stderr)
        return 1

    print(f"check-data-processes: ok — {len(эталон)} процесса, все пять "
          f"мест сходятся ({', '.join(sorted(эталон))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
