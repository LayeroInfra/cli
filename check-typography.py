#!/usr/bin/env python3
"""Пятая проверка на расхождение: русская типографика в наших текстах.

Зачем. Первые четыре проверки (§5.1 CLAUDE.md) ловят расхождение обещаний с
кодом. Эта ловит другой класс — механический: неразрывные пробелы, тире,
кавычки, десятичный разделитель. Модель судит о смысле; здесь проверяется
подмножество, где судить не надо вовсе, и потому оно должно проверяться на
каждом прогоне, а не когда кто-то вспомнил.

Повод. 30.07 прогон корпуса ru-text по статус-странице показал: во всём
интерфейсе не было НИ ОДНОГО неразрывного пробела, а подсказка печатала
«доступность 99.9%» с точкой вместо запятой. Ни один глаз этого не увидел за
два месяца, потому что смотреть надо в байты, а не на макет.

Что делает. Достаёт из файла куски русской прозы — с учётом того, где они
живут: в Markdown это текст вне кода, в HTML — содержимое тегов и строковые
литералы внутри <script>, в .py/.ts/.js — строковые литералы с кириллицей.
Экранированные `\\u00a0` и HTML-сущность `&nbsp;` раскрываются до символа,
иначе проверка соврёт про уже исправленный текст.

Политика падений двухуровневая, и это осознанно. STRICT-список — поверхности,
которые уже приведены в порядок: там любая находка валит прогон. Всё
остальное печатается предупреждением: лендинг писался годами без единого
неразрывного пробела, и падать на нём сегодня значит выключить проверку
совсем. Файл переезжает в STRICT ровно тогда, когда вычищен.

Правила названы кодами ru-text (R16, R30, R36, R45, R54…), чтобы находку можно
было проверить по справочнику `skills/ru-text/references/typography.md`, а не
по этому файлу.

Запуск:
    python3 core/cli/check-typography.py                # весь набор поверхностей
    python3 core/cli/check-typography.py ПУТЬ [ПУТЬ…]   # только эти файлы
    python3 core/cli/check-typography.py --strict ПУТЬ  # валить на любой находке
"""
from __future__ import annotations

import argparse
import html as htmllib
import re
import sys
from pathlib import Path

NBSP = " "
NNBSP = " "

# Поверхности, которые уже вычищены: здесь находка = падение. Список
# расширяется по одному файлу за раз, когда файл действительно приведён в
# порядок, — иначе проверка снова станет декоративной.
STRICT = (
    "core/infra/status-page/index.html",
    "core/backend/app/services/public_status.py",
)

# Что проверяем по умолчанию, если пути не заданы явно.
SURFACES = (
    "core/infra/status-page/index.html",
    "core/backend/app/services/public_status.py",
    "frontend/landing/index.html",
)

# Единицы измерения, которые не должны отрываться от числа (R36). Список
# намеренно короткий: «с» и «ч» без него дали бы ложные срабатывания на
# предлоге и союзе, а угадывать здесь нечего.
UNITS = (
    "с", "мин", "ч", "сут", "дн", "дня", "дней", "часа", "часов", "секунд",
    "мс", "кг", "г", "м", "км", "КБ", "МБ", "ГБ", "ТБ", "кб", "мб", "гб",
    "₽", "%", "руб", "р",
)
# 03.08.2026: список сведён с `mcp/server/src/layero/copy_rules.py` — те же
# правила работают в инструменте `check_copy`, которым агенты правят чужие
# сайты. Расхождение ловит `mcp/check-copy-rules.py`.
# Однобуквенные предлоги и союзы (R30). Обе регистровые формы: проверка,
# которая не смотрит на «В» в начале предложения, слепа там, где предложения
# чаще всего и начинаются.
PREP = "вкосуиаяВКОСУИАЯ"


def spans_markdown(text: str) -> list[tuple[int, str, bool]]:
    out, fence = [], False
    for n, raw in enumerate(text.split("\n"), 1):
        if raw.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence or raw.startswith("    "):
            continue
        out.append((n, _blank_code(raw), True))
    return out


def spans_html(text: str) -> list[tuple[int, str, bool]]:
    """Текст между тегами плюс строковые литералы внутри <script>.

    Половину интерфейса статус-страницы рисует скрипт, и проверка, которая
    смотрит только на разметку, честно рапортует «чисто» о странице, где
    ни одной подписи в разметке нет.

    Комментарии — HTML, CSS и JS — вырезаются целиком. Проверяется только то,
    что произносит продукт: на этой странице комментариев больше, чем
    интерфейса, и без их вырезания находки тонут в объяснениях для нас самих.
    """
    body = _blank_regions(
        text,
        r"<!--.*?-->",
        r"<style\b.*?</style>",
        r"<script[^>]*application/ld\+json.*?</script>",
        r"<(code|pre|kbd)\b[^>]*>.*?</\1>",
        r"/\*.*?\*/",
        r"(?m)^[ \t]*//.*$",
    )
    out = []
    in_script = False
    for n, raw in enumerate(body.split("\n"), 1):
        low = raw.lower()
        if "<script" in low:
            in_script = True
        if not in_script:
            line = htmllib.unescape(re.sub(r"<[^>]*>", " ", raw))
            if re.search("[а-яА-ЯёЁ]", line):
                out.append((n, _blank_code(line), True))
        else:
            for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', raw):
                if re.search("[а-яА-ЯёЁ]", m.group(1)):
                    out.append((n, _unescape_js(m.group(1)), False))
        if "</script" in low:
            in_script = False
    return out


def _blank_regions(text: str, *patterns: str) -> str:
    """Гасим область, сохраняя переводы строк: номера строк обязаны остаться
    настоящими, иначе находку не найти в файле."""
    for pat in patterns:
        text = re.sub(pat, lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    return text


def spans_source(text: str) -> list[tuple[int, str, bool]]:
    """Строковые литералы с кириллицей. Докстроки и комментарии не в счёт:
    это разговор с собой, а не с пользователем."""
    text = _blank_regions(text, r'""".*?"""', r"'''.*?'''", r"(?m)#.*$", r"(?m)//.*$")
    out = []
    for n, raw in enumerate(text.split("\n"), 1):
        for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"' + r"|'((?:[^'\\\n]|\\.)*)'", raw):
            body = m.group(1) if m.group(1) is not None else m.group(2)
            if body and re.search("[а-яА-ЯёЁ]", body):
                out.append((n, _unescape_js(body), False))
    return out


def _unescape_js(body: str) -> str:
    return re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), body)


def _blank_code(line: str) -> str:
    """Гасим инлайн-код, ссылки и URL, сохраняя длину: `~/.claude` — это путь,
    а дефис внутри команды — не тире."""
    line = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)
    line = re.sub(r"\]\([^)]*\)", lambda m: " " * len(m.group(0)), line)
    line = re.sub(r"https?://\S+", lambda m: " " * len(m.group(0)), line)
    return line


def findings(span: str, from_markup: bool = False) -> list[tuple[str, str]]:
    """from_markup — текст получен вычёркиванием тегов. Тогда двойные пробелы и
    «пробел перед точкой» смотреть нельзя: их создаёт само вычёркивание
    (`<code>x</code>.` даёт ` x .`), а в исходнике их нет."""
    out = []
    for m in re.finditer("—", span):
        if from_markup and not span[:m.start()].strip():
            continue
        if m.start() and span[m.start() - 1] == " ":
            out.append(("R16/R44", "обычный пробел перед длинным тире"))
    for m in re.finditer(r"(?<![А-Яа-яЁё])([%s]) (?=[А-Яа-яЁё0-9«])" % PREP, span):
        out.append(("R30", "однобуквенный предлог «%s» отрывается от слова" % m.group(1)))
    for m in re.finditer(r"\d ([А-Яа-яЁё]+|[₽%%])" % (), span):
        if m.group(1) in UNITS:
            out.append(("R36", "число отрывается от единицы «%s»" % m.group(1)))
    if re.search(r"\d\.\d", span) and not re.search(r"\d\.\d+\.\d|[A-Za-z]\.\d", span):
        out.append(("R54", "десятичный разделитель — точка, а не запятая"))
    if re.search(r'"[^"]*[А-Яа-яЁё]', span):
        out.append(("R1/R2", "прямые кавычки вокруг русского текста"))
    if "..." in span:
        out.append(("R45", "три точки вместо символа многоточия"))
    if not from_markup:
        if re.search(r"\S  +\S", span):
            out.append(("—", "двойной пробел"))
        if re.search(r"\s[,.;:!?]", span):
            out.append(("R40", "пробел перед знаком препинания"))
    return out


def check(path: Path, root: Path, strict: bool) -> tuple[int, int]:
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".md",):
        spans = spans_markdown(text)
    elif path.suffix in (".html", ".htm"):
        spans = spans_html(text)
    else:
        spans = spans_source(text)

    rel = str(path.relative_to(root)) if root in path.parents else str(path)
    hard = strict or rel in STRICT
    errors = warns = 0
    for line, span, from_markup in spans:
        for rule, what in findings(span, from_markup):
            mark = "✗" if hard else "·"
            print(f"  {mark} {rel}:{line}  {rule} — {what}")
            print(f"      {span.strip()[:100]}")
            if hard:
                errors += 1
            else:
                warns += 1
    return errors, warns


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--strict", action="store_true", help="валить на любой находке")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    paths = [Path(p).resolve() for p in args.paths] or [root / s for s in SURFACES]

    errors = warns = 0
    for p in paths:
        if not p.exists():
            print(f"  ✗ файл отсутствует: {p}")
            errors += 1
            continue
        e, w = check(p, root, args.strict)
        errors += e
        warns += w

    if errors:
        print(f"\nнарушений на вычищенных поверхностях: {errors}"
              + (f"; предупреждений: {warns}" if warns else ""))
        return 1
    if warns:
        print(f"\nвычищенные поверхности чисты; предупреждений на остальных: {warns}")
        return 0
    print("типографика сходится с правилами ru-text")
    return 0


if __name__ == "__main__":
    sys.exit(main())
