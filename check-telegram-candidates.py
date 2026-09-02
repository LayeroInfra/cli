#!/usr/bin/env python3
"""Список запасных адресов Bot API на узле не разошёлся с эталоном.

🚨 ЗАЧЕМ ГЕЙТ. Копий списка две, и обе нужны. Эталон — `FALLBACK_IPS` в
`backend/app/core/telegram_net.py`: по нему ходит бэкенд. Вторая живёт в
`deploy/setup-telegram-route.sh`, потому что рантайм-нода до
репозитория не дотягивается, а тащить туда бэкенд ради кортежа из четырёх
строк дороже, чем сторожить расхождение.

Ограничение 7 в AGENTS.md запрещает не копию как таковую, а НЕОХРАНЯЕМУЮ
копию: она не ломается сразу, а ждёт момента, когда понадобится. Здесь этот
момент — «адрес из DNS лёг»: пока он жив, обе копии не используются вовсе, и
расхождение никак себя не проявляет. То есть проявится оно ровно в аварию.

Ловит: адрес добавили/убрали/поправили в одном месте и не в другом.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "backend/app/core/telegram_net.py"
COPY = ROOT / "deploy/setup-telegram-route.sh"


def эталон() -> list[str]:
    tree = ast.parse(SRC.read_text(encoding="utf-8"))
    for node in tree.body:
        targets = getattr(node, "targets", None) or (
            [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        for t in targets:
            if isinstance(t, ast.Name) and t.id == "FALLBACK_IPS":
                return list(ast.literal_eval(node.value))
    raise SystemExit(f"✗ в {SRC.relative_to(ROOT)} не нашёл FALLBACK_IPS")


def копия() -> list[str]:
    m = re.search(r'^CANDIDATES="([^"]*)"', COPY.read_text(encoding="utf-8"), re.M)
    if not m:
        raise SystemExit(f"✗ в {COPY.relative_to(ROOT)} не нашёл CANDIDATES=\"…\"")
    return m.group(1).split()


def main() -> int:
    # Отсутствие файла — это ПЕРЕИМЕНОВАНИЕ, а не экзотика: пара «эталон и его
    # копия» переживает переезды, и гейт обязан сказать об этом словами, а не
    # стектрейсом. Проверено на себе — скрипт переименовали через час.
    for path in (SRC, COPY):
        if not path.exists():
            print(f"✗ не нашёл {path.relative_to(ROOT)} — файл переименован "
                  f"или переехал; поправьте путь в этом гейте", file=sys.stderr)
            return 1
    want, got = эталон(), копия()
    if want == got:
        print(f"check-telegram-candidates: ok — {len(want)} адресов, копия совпадает")
        return 0

    print("✗ список запасных адресов Bot API разошёлся\n", file=sys.stderr)
    print(f"  эталон {SRC.relative_to(ROOT)}:\n    {' '.join(want)}", file=sys.stderr)
    print(f"  копия  {COPY.relative_to(ROOT)}:\n    {' '.join(got)}\n", file=sys.stderr)
    only_src = [ip for ip in want if ip not in got]
    only_copy = [ip for ip in got if ip not in want]
    if only_src:
        print(f"  нет на узле:      {' '.join(only_src)}", file=sys.stderr)
    if only_copy:
        print(f"  лишние на узле:   {' '.join(only_copy)}", file=sys.stderr)
    if not only_src and not only_copy:
        print("  состав тот же, разошёлся ПОРЯДОК — а он значимый: "
              "проба идёт по списку до первого живого", file=sys.stderr)
    print("\n  FIX: приведите CANDIDATES к FALLBACK_IPS и прогоните "
          "setup-runtime-node-telegram.sh на узле — иначе правка списка "
          "доедет только до бэкенда.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
