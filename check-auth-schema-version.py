#!/usr/bin/env python3
"""Версия схемы-пакета `auth` — ОДНО число в двух файлах. Сторожим равенство.

🚨 Копия числа, от которой зависит выкатка, — отложенный отказ, а не
неряшливость. `runtime/userdb-agent/agent.py` говорит, что агент УМЕЕТ
разложить, а `backend/app/services/userdb_api.py` — чего догоняющий воркер
ДОБИВАЕТСЯ. Разъедутся:

* цель ниже умения — новые функции не доедут ни до одной базы, и узнает об
  этом посетитель, нажавший «забыли пароль?»;
* цель выше умения — воркер будет ходить на шард по кругу вечно, каждый раз
  записывая «догнали» неправдой; в логе это `userdb.auth_schema_agent_behind`,
  которого никто не читает, пока что-нибудь не сломается.

Проверка сравнивает ЧИСЛА, а не тексты: комментарии вокруг них живут своей
жизнью и расходиться им можно.

⚠️ Равенство здесь — про репозиторий, а не про прод. Агент едет на узел
руками (`deploy/setup-userdb-agent.sh`), и на узле может стоять прежний: это
ловит `deploy/check-data-api-dry-run.sh` по md5. Две разные проверки на два
разных расхождения.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = {
    "агент (что умеет разложить)": ROOT / "runtime/userdb-agent/agent.py",
    "api (чего добивается догоняющий)": ROOT / "backend/app/services/userdb_api.py",
}
PATTERN = re.compile(r"^AUTH_SCHEMA_VERSION\s*=\s*(\d+)\s*$", re.MULTILINE)


def main() -> int:
    found: dict[str, int] = {}
    for name, path in SOURCES.items():
        if not path.exists():
            print(f"✘ нет файла {path}")
            return 1
        matches = PATTERN.findall(path.read_text())
        if len(matches) != 1:
            print(f"✘ в {path.relative_to(ROOT)} объявлений AUTH_SCHEMA_VERSION: "
                  f"{len(matches)}, а должно быть ровно одно")
            return 1
        found[name] = int(matches[0])

    if len(set(found.values())) != 1:
        print("✘ версия схемы `auth` разъехалась:")
        for name, value in found.items():
            print(f"    {value} — {name}")
        print("  Поднимать обязательно ОБА, и агент выкатывать ПЕРВЫМ:")
        print("  bash deploy/setup-userdb-agent.sh, затем git push (api).")
        return 1

    version = next(iter(found.values()))
    print(f"✔ версия схемы `auth` сходится: {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
