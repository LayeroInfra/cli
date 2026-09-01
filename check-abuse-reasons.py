#!/usr/bin/env python3
"""Причины жалобы на странице и в ручке — один список, а не два.

Форма приёма жалоб живёт на статическом лендинге (`frontend/landing/abuse.html`),
а закрытый список причин — в `backend/app/api/routes/abuse.py`. Это ДВА
исполнителя одного правила в разных репозиториях, и разъезжаются такие пары
тихо: страница продолжает показывать причину, которую ручка уже отвергает 400-м,
и человек, сообщающий о фишинге, получает отказ вместо приёма.

Класс не гипотетический. У платформы он повторялся: панель показывала адрес,
который сервер отвергал блок-листом; мастер держал две карточки одного
приложения с параллельными пропсами; правило выбора папки жило в трёх местах.
Каждый раз ломался СТЫК, а каждая сторона по отдельности отвечала верно.

Кросс-репозиторная проверка: читает соседний `frontend`. Если его нет рядом —
пропускаем, а не падаем: в CI выкачивают один репозиторий.
"""
from __future__ import annotations

import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
CORE = HERE.parent
API = CORE / "backend" / "app" / "api" / "routes" / "abuse.py"
PAGE = CORE.parent / "frontend" / "landing" / "abuse.html"


def _from_api(src: str) -> list[str]:
    m = re.search(r"REASONS: dict\[str, str\] = \{(.*?)\n\}", src, re.S)
    if not m:
        return []
    return re.findall(r'"([a-z_]+)":', m.group(1))


def _from_page(html: str) -> list[str]:
    m = re.search(r'<select[^>]*name="reason".*?</select>', html, re.S)
    if not m:
        return []
    # Пустой value — это placeholder «Выберите причину», он не причина.
    return [v for v in re.findall(r'<option value="([^"]*)"', m.group(0)) if v]


def main() -> int:
    if not API.exists():
        print(f"✗ нет {API} — сверять список причин не с чем")
        return 2
    if not PAGE.exists():
        print("· frontend рядом нет — проверка причин жалобы пропущена")
        return 0

    api = _from_api(API.read_text(encoding="utf-8"))
    page = _from_page(PAGE.read_text(encoding="utf-8"))

    if not api:
        print("✗ в ручке не нашёлся словарь REASONS — проверка выродилась бы в «ок»")
        return 2
    if not page:
        print("✗ на странице не нашёлся <select name=\"reason\"> — та же беда")
        return 2

    if api == page:
        print(f"причины жалобы: {len(api)}, страница и ручка совпадают")
        return 0

    only_page = [r for r in page if r not in api]
    only_api = [r for r in api if r not in page]

    print("\n✗ список причин разъехался\n")
    print(f"  в ручке:   {api}")
    print(f"  на странице: {page}")
    if only_page:
        print(f"\n  показываем, но не примем (ручка ответит 400): {only_page}")
    if only_api:
        print(f"  примем, но не показываем (выбрать нечем): {only_api}")
    if not only_page and not only_api:
        print("\n  состав совпадает, разошёлся ПОРЯДОК — человек читает про"
              "\n  нарушения в одном порядке, а выбирает в другом")
    print(
        "\nWHAT: <select name=\"reason\"> на layero.ru/abuse.html и REASONS в\n"
        "      backend/app/api/routes/abuse.py — разные списки.\n"
        "WHY:  ручка отвергает причину не из списка 400-м. Расхождение значит,\n"
        "      что часть жалоб отбивается на отправке, а отправитель видит\n"
        "      «выберите причину из списка», выбрав её из списка.\n"
        "FIX:  правьте ОБА места одной правкой, в одном порядке. Порядок тоже\n"
        "      сверяется: он совпадает с разделом «Что считается нарушением»\n"
        "      на той же странице."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
