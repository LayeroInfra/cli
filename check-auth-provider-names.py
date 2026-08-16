#!/usr/bin/env python3
"""Имена секретов провайдеров входа: api ↔ шлюз (DATA-31).

Зачем отдельная проверка. Провайдер включается так: api пишет пару секретов с
именами `AUTH_<ПРОВАЙДЕР>_CLIENT_ID` и `AUTH_<ПРОВАЙДЕР>_SECRET`, шлюз читает
их под теми же именами. Сервисы разные, общего кода у них нет, импортировать
друг друга они не могут — значит имена держатся на честном слове в двух местах.

🚨 Расхождение НЕ ЛОМАЕТ НИЧЕГО ЗАМЕТНОГО. Панель покажет «включён» (секреты
записаны), шлюз ответит «вход через google у этой базы не настроен» (секретов с
его именами нет), и разбираться в этом будет владелец на своей форме входа.
Тот же класс, что и остальные проверки §5.1: ломается не поведение, а
согласие двух текстов.

Запуск: python3 core/cli/check-auth-provider-names.py
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
API_SRC = ROOT / "backend" / "app" / "services" / "userdb_api.py"
GATEWAY_SRC = ROOT / "data-api" / "app" / "auth" / "providers.py"


def _providers(text: str, marker: str) -> set[str]:
    """Список провайдеров у стороны: у api это кортеж `AUTH_PROVIDERS`,
    у шлюза — ключи `_PROVIDERS`."""
    if marker == "api":
        match = re.search(r"AUTH_PROVIDERS\s*=\s*\(([^)]*)\)", text)
        return set(re.findall(r'"([a-z]+)"', match.group(1))) if match else set()
    block = re.search(r"_PROVIDERS:\s*dict\[str,\s*Provider\]\s*=\s*\{(.*?)\n\}",
                      text, re.S)
    return set(re.findall(r'\n    "([a-z]+)":', block.group(1))) if block else set()


def _pattern(text: str) -> str | None:
    """Как сторона строит имена. Обе обязаны давать одну строку."""
    match = re.search(r'f"AUTH_\{upper\}_(CLIENT_ID)".*?f"AUTH_\{upper\}_(SECRET)"',
                      text, re.S)
    return f"AUTH_<P>_{match.group(1)}|AUTH_<P>_{match.group(2)}" if match else None


def main() -> int:
    # ⚠️ Проверка читает файлы по путям — значит переезд модуля её ослепляет.
    # 15.08 так и вышло: `oauth.py` уехал в `auth/providers.py`, и сторож стал
    # падать трассировкой вместо внятного «не нашёл». Скажем прямо, что
    # проверять нечего, — молчаливого «сходится» тут быть не должно.
    for path in (API_SRC, GATEWAY_SRC):
        if not path.exists():
            print(f"✘ провайдеры входа: не нашёл {path}\n")
            print(
                "WHAT: файл, который сверяет эта проверка, не найден по пути.\n"
                "WHY:  проверка читает файлы по путям — переезд модуля её ослепляет.\n"
                "      15.08 так и вышло: oauth.py уехал в auth/providers.py, и сторож\n"
                "      стал падать трассировкой вместо внятного «не нашёл». Молчаливого\n"
                "      «сходится» здесь быть не должно.\n"
                "FIX:  поправьте API_SRC / GATEWAY_SRC в начале этого скрипта на новые\n"
                "      пути. Если модуль удалён — удалите и проверку, а не оставляйте\n"
                "      её слепой."
            )
            return 1
    api = API_SRC.read_text(encoding="utf-8")
    gateway = GATEWAY_SRC.read_text(encoding="utf-8")

    problems: list[str] = []

    api_names, gw_names = _providers(api, "api"), _providers(gateway, "gateway")
    if not api_names or not gw_names:
        problems.append("не нашёл список провайдеров — проверка ослепла, "
                        f"api={sorted(api_names)} шлюз={sorted(gw_names)}")
    elif api_names != gw_names:
        problems.append(
            f"списки провайдеров разошлись: только у api {sorted(api_names - gw_names)}, "
            f"только у шлюза {sorted(gw_names - api_names)}")

    api_pattern, gw_pattern = _pattern(api), _pattern(gateway)
    if api_pattern is None or gw_pattern is None:
        problems.append("не нашёл, как строятся имена секретов — "
                        f"api={api_pattern} шлюз={gw_pattern}")
    elif api_pattern != gw_pattern:
        problems.append(f"имена секретов разошлись: api {api_pattern}, "
                        f"шлюз {gw_pattern}")

    if problems:
        print("✘ провайдеры входа: api и шлюз не сходятся")
        for line in problems:
            print(f"  · {line}")
        print(
            "\nWHAT: api и шлюз по-разному называют провайдеров входа или их секреты.\n"
            "WHY:  имя секрета — это контракт между двумя сторонами. Разойдясь, они\n"
            "      не падают: сторона, не нашедшая переменную, просто не предлагает\n"
            "      провайдера. Пользователь видит, что вход «через Сбер» пропал,\n"
            "      а в логах ничего.\n"
            "FIX:  1) приведите списки к одному — правится там, где провайдер забыт;\n"
            "      2) шаблон имени менять только с обеих сторон разом\n"
            "         (`AUTH_<P>_CLIENT_ID` / `AUTH_<P>_SECRET`);\n"
            "      3) добавили провайдера — заведите его секреты в Lockbox\n"
            "         (`layero-prod-env`) и задеплойте, иначе он не появится на проде."
        )
        return 1
    print(f"✔ провайдеры входа сходятся: {', '.join(sorted(api_names))}; "
          f"имена секретов {api_pattern}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
