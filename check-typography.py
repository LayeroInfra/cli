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
    # 05.08.2026: вычищена целиком при добавлении раздела о переезде домена
    # с другого хостинга. Страница длинная и её читают, когда что-то уже не
    # получилось, — пусть остаётся чистой.
    "layero-docs/docs/deploys/custom-domains.md",
    # 10.08.2026: файл маленький и целиком состоит из подписей под полем —
    # ровно та поверхность, ради которой проверка писалась. Заведён чистым,
    # пусть таким и остаётся.
    "frontend/control-plane/src/lib/authRealm.ts",
    # 12.08.2026: раздел «Базы данных» вычищен целиком. Поводом стала вычитка
    # по ru-text: во всех пяти экранах раздела было НОЛЬ неразрывных пробелов
    # при том, что соседние файлы того же каталога их используют — то есть
    # соглашение в кодовой базе есть, а раздел прошёл мимо него. Тот же класс,
    # что со статус-страницей 30.07: смотреть надо в байты, а не на макет.
    # 🚨 05.09.2026: ЧЕТЫРЕ из этих путей указывали в никуда. `Create.tsx`,
    # `Connection.tsx`, `Projects.tsx` и `CreateDialog.tsx` давно переименованы,
    # и строгая проверка просто не находила их среди просмотренных файлов —
    # молча, потому что совпадение искалось по имени. Список охранял четыре
    # экрана, которых нет, а их преемники три недели жили без охраны.
    # Ниже — преемники; сторож против повторения стоит в `main`.
    "frontend/control-plane/src/pages/Database/CreatePage.tsx",
    "frontend/control-plane/src/pages/Database/ConnectDialog.tsx",
    "frontend/control-plane/src/pages/Database/Backups.tsx",
    "frontend/control-plane/src/pages/Database/List.tsx",
    "frontend/control-plane/src/pages/Database/ProjectsSettings.tsx",
    "frontend/control-plane/src/pages/Database/NetworkSettings.tsx",
    "frontend/control-plane/src/pages/Database/Settings.tsx",
    "frontend/control-plane/src/pages/Project/DatabaseCard.tsx",
    # 15.08.2026: `Api.tsx` в тот список не попал, хотя это самая текстовая
    # карточка раздела — «во всех пяти экранах» оказалось не про все экраны
    # каталога. Нашлось вычиткой DATA-31: в файле было НОЛЬ неразрывных
    # пробелов, включая свежие подписи провайдеров входа.
    "frontend/control-plane/src/pages/Database/Api.tsx",
    # 08.09.2026: страница «API» разъехалась на три файла (ARCH-11) —
    # список открытого, список вызовов и общие части разговора про RLS.
    # Заводятся в STRICT сразу: тексты писались по правилам, и вычищать
    # их потом стоило бы дороже, чем не пустить нарушение сейчас.
    "frontend/control-plane/src/pages/Database/ApiExposed.tsx",
    "frontend/control-plane/src/pages/Database/ApiCalls.tsx",
    "frontend/control-plane/src/pages/Database/policy-parts.tsx",
    # 17.08.2026: вычищены при разборе T-20260816-9. Поводом стало то, что три
    # строки этих файлов оставались со старым пробелом в ЖИВОМ бандле, когда
    # строгие поверхности уже были зелёными: проверка их просто не смотрела.
    #
    # 🚨 ЧЕСТНО О ГАРАНТИИ. Нахождение в этом списке охраняет строковые литералы
    # и JSX-текст, стоящий между тегами в ОДНОЙ строке. Текст на отдельной
    # строке внутри многострочного элемента — подписи кнопок, абзацы описаний —
    # проверка не видит вовсе (T-20260817-5). Проверено мутацией: возврат
    # обычного пробела в литерал роняет проверку, в подпись кнопки — нет.
    # То есть список даёт МЕНЬШЕ, чем обещает, пока дыра открыта.
    "frontend/control-plane/src/pages/CliDeviceAuth.tsx",
    "frontend/control-plane/src/pages/DebugPanel.tsx",
    # 05.09.2026: раздел вырос с двенадцати экранов до двадцати девяти, а
    # список охраняемых остался прежним — новые поверхности жили без охраны.
    # Нашло независимое ревью (T-20260905-12).
    #
    # 🚨 ВНОСИМ ТОЛЬКО ВЫЧИЩЕННЫЕ, И ЭТО ПРАВИЛО САМОГО СКРИПТА. Из шестнадцати
    # неохраняемых экранов чисты четыре; у остальных долг от одного нарушения
    # (`Tables.tsx`) до двадцати одного (`Sql.tsx`). Внести их сейчас значит
    # сделать проверку красной с первого дня — а такую проверку отключают.
    # Долг вынесен в T-20260816-9, вносить по мере вычитки.
    "frontend/control-plane/src/pages/Database/CreateTableDialog.tsx",
    "frontend/control-plane/src/pages/Database/TablesPage.tsx",
    "frontend/control-plane/src/pages/Database/dialogs.tsx",
    "frontend/control-plane/src/pages/Database/skeletons.tsx",
    # 06.09.2026: вычищены вместе с закрытием T-20260905-12 — те самые экраны,
    # на которых ревью и нашло нарушения (`ResourceSettings.tsx:219`,
    # `Extensions.tsx:217`). Правок было четырнадцать на три файла: этого мало
    # для отдельного тикета и достаточно, чтобы вносить каждый экран сюда сразу
    # после вычитки, а не «когда дойдут руки до всего раздела».
    "frontend/control-plane/src/pages/Database/ResourceSettings.tsx",
    "frontend/control-plane/src/pages/Database/Extensions.tsx",
    "frontend/control-plane/src/pages/Database/Policies.tsx",
    # Модули без разметки, заведённые этим же эпиком. Текстов в них немного, но
    # это подписи колонок и названия расширений — то, что человек читает.
    "frontend/control-plane/src/pages/Database/extensionColumns.ts",
    "frontend/control-plane/src/pages/Database/introspect.ts",
)

# Что проверяем по умолчанию, если пути не заданы явно.
#
# 🚨 До 07.08 здесь было ЧЕТЫРЕ файла, и проверка отрабатывала зелёным, ничего
# не зная про целые языки. CLAUDE.md §5.2 при этом перечисляет как проверяемые
# «тексты ошибок деплоя, CLI, письма email-движка» и подписи панели — то есть
# обещание было шире набора ровно на всё, что произносит продукт в работе.
# Живая проверка: в `app/api/routes/billing.py` НОЛЬ неразрывных пробелов при
# девяти сообщениях с длинным тире. ИБ-ревью 07.08.2026, T-20260807-59.
#
# Каталог разворачивается рекурсивно (см. `_expand`). Новые поверхности дают
# ПРЕДУПРЕЖДЕНИЯ, а не падение: иначе проверка встанет красной на тысячах строк
# и её отключат в тот же день. Файл переезжает в STRICT, когда вычищен.
SURFACES = (
    "core/infra/status-page/index.html",
    "core/backend/app/services/public_status.py",
    "frontend/landing/index.html",
    "layero-docs/docs/deploys/custom-domains.md",
    # Тексты, которые человек читает, когда у него что-то не получилось.
    "core/backend/app/api/routes",
    "core/backend/app/services/deploy_error.py",
    "core/backend/app/services/log_humanize.py",
    "core/backend/app/services/email",
    "core/backend/app/billing",
    "core/cli/src",
    # Подписи панели: кнопки, пустые состояния, ошибки.
    "frontend/control-plane/src",
)

# Какие расширения вообще имеет смысл открывать при развороте каталога.
_SCANNABLE = {".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".html", ".htm"}

# Каталоги, в которые не спускаемся: там не тексты продукта.
_SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "__pycache__", ".venv",
    "tests", "test", "__tests__", "migrations", "generated",
}

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
        r"(?m)^[ \t]*//[^\n]*$",
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
    настоящими, иначе находку не найти в файле.

    🚨 Все шаблоны компилируются с `re.S`, то есть `.` матчит и перевод строки.
    Однострочные шаблоны обязаны писаться через `[^\\n]*`, а НЕ `.*`: с `re.S`
    выражение `(?m)#.*$` жадно доходит до конца ФАЙЛА и гасит всё после первого
    же комментария. Ровно это и происходило: `spans_source` возвращала ноль
    литералов на `routes/billing.py` (78 строк с длинным тире), а
    `public_status.py` числился вычищенной STRICT-поверхностью, будучи
    непроверенным. ИБ-ревью 07.08.2026, T-20260807-59.
    """
    for pat in patterns:
        text = re.sub(pat, lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    return text


#: Области, где текст — разговор с собой: докстроки и комментарии.
DOCSTRING_DQ = r'"""' + r".*?" + r'"""'
DOCSTRING_SQ = r"'''" + r".*?" + r"'''"
PY_COMMENT = r"(?m)#[^\n]*$"
JS_COMMENT = r"(?m)//[^\n]*$"
#: Строковый литерал в кавычках любого вида, с учётом экранирования.
STRING_LITERAL = (r'"((?:[^"\\\n]|\\.)*)"' + r"|'((?:[^'\\\n]|\\.)*)'")

#: Атрибут JSX/HTML: `title="…"`, `placeholder="…"`, `aria-label="…"`.
#:
#: 🚨 ЗДЕСЬ escape-ПОСЛЕДОВАТЕЛЬНОСТЬ — ЭТО БУКВЫ, А НЕ ПРОБЕЛ. Значение
#: атрибута в двойных кавычках JSX разбирает как ТЕКСТ, а не как строковый
#: литерал JavaScript: запись вида «обратный слэш, u, 00A0» не раскрывается и
#: уезжает на экран дословно. Проверка при этом её раскрывала и говорила
#: «чисто».
#:
#: Так и вышло 06.09.2026: вычищая типографику раздела баз, я поставил такую
#: запись в `title` настройки ресурсов — и в демо-панели на БОЕВОМ адресе
#: заголовок читался с шестью лишними символами посреди слова. Семь мест в
#: трёх файлах, и все семь проверка пропустила, потому что смотрела на
#: результат собственного раскрытия, а не на то, что увидит человек.
_JSX_ATTR = re.compile(r'[A-Za-z-]+="([^"\n]*)"')

def spans_source(text: str) -> list[tuple[int, str, bool]]:
    """Строковые литералы с кириллицей. Докстроки и комментарии не в счёт:
    это разговор с собой, а не с пользователем."""
    text = _blank_regions(text, DOCSTRING_DQ, DOCSTRING_SQ, PY_COMMENT, JS_COMMENT)
    out = []
    for n, raw in enumerate(text.split("\n"), 1):
        # Сначала атрибуты: их значение НЕ раскрываем, потому что и браузер
        # его не раскроет.
        attrs = []
        for m in _JSX_ATTR.finditer(raw):
            value = m.group(1)
            if value and re.search("[а-яА-ЯёЁ]", value):
                attrs.append((m.start(1), m.end(1)))
                out.append((n, value, False))
        for m in re.finditer(STRING_LITERAL, raw):
            value = m.group(1) if m.group(1) is not None else m.group(2)
            if not value or not re.search("[а-яА-ЯёЁ]", value):
                continue
            start = m.start(1) if m.group(1) is not None else m.start(2)
            if any(a <= start < b for a, b in attrs):
                continue  # уже взяли как атрибут, дважды не считаем
            out.append((n, _unescape_js(value), False))
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
        # Неразрывный пробел СЛЕВА означает, что буква — не предлог, а единица
        # измерения, уже привязанная к числу: «2 с назад», «5 м ниже». Правило
        # R30 связывает предлог с ПОСЛЕДУЮЩИМ словом, и здесь ему делать нечего.
        # Найдено на статус-странице при снятии слепоты проверки: `" с
        # назад"` числилось нарушением на STRICT-поверхности, будучи верным.
        if m.start() and span[m.start() - 1] in (NBSP, NNBSP):
            continue
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
    # 🚨 ESCAPE В ТЕКСТЕ, КОТОРЫЙ НИКТО НЕ РАСКРОЕТ. Значение атрибута JSX
    # разбирается как ТЕКСТ: запись «обратный слэш, u, четыре цифры» уезжает на
    # экран дословно. Ни одно правило выше её не ловит — там ведь нет ни
    # пробела, ни тире, только буквы, — и 06.09.2026 в демо-панели на боевом
    # адресе заголовок настройки читался с шестью лишними символами посреди
    # слова. Семь мест в трёх файлах, все семь эта проверка пропустила.
    if re.search(r"\\u00[0-9a-fA-F]{2}", span):
        out.append(("ESC", "escape-последовательность попадёт на экран как есть"))
    if not from_markup:
        if re.search(r"\S  +\S", span):
            out.append(("—", "двойной пробел"))
        if re.search(r"\s[,.;:!?]", span):
            out.append(("R40", "пробел перед знаком препинания"))
    return out


def spans_jsx(text: str) -> list[tuple[int, str, bool]]:
    """Строковые литералы ПЛЮС текст между тегами JSX.

    Известная дыра того же класса, что и «не смотрит .py»: в `.tsx` половина
    подписей — не литералы, а текстовые узлы разметки (`<p>Сайт публикуется</p>`),
    и проверка, читающая только строки в кавычках, честно рапортует «чисто» о
    файле, где ни одна видимая подпись не проверена.
    ИБ-ревью 07.08.2026, T-20260807-59.

    Текстовый узел помечается `from_markup=True`: двойные пробелы и «пробел
    перед точкой» в нём смотреть нельзя — их создаёт перенос строки и отступ
    самой разметки, а не автор текста.
    """
    out = list(spans_source(text))
    body = _blank_regions(
        text, r'""".*?"""', r"(?m)//[^\n]*$", r"/\*.*?\*/",
        # Литералы уже собраны выше; гасим их, чтобы не считать дважды.
        r'"(?:[^"\\\n]|\\.)*"', r"'(?:[^'\\\n]|\\.)*'", r"`(?:[^`\\]|\\.)*`",
    )
    for n, raw in enumerate(body.split("\n"), 1):
        # Текст ПОСЛЕ закрывающей `>` и ДО следующей `<`. Выражения `{…}`
        # гасим: `{count} проектов` — текст здесь только вторая половина.
        for m in re.finditer(r">([^<>{}]+)(?=<|\{|$)", raw):
            span = m.group(1)
            if re.search("[а-яА-ЯёЁ]", span):
                out.append((n, _blank_code(span), True))
    return out


def check(path: Path, root: Path, strict: bool) -> tuple[int, int]:
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".md",):
        spans = spans_markdown(text)
    elif path.suffix in (".html", ".htm"):
        spans = spans_html(text)
    elif path.suffix in (".tsx", ".jsx"):
        spans = spans_jsx(text)
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


def _expand(p: Path) -> list[Path]:
    """Файл — сам собой; каталог — все текстовые файлы под ним.

    Разворот нужен потому, что поверхности из CLAUDE.md §5.2 — не файлы, а
    области: «тексты ошибок деплоя», «подписи панели». Перечислять их файлами
    значило бы завести пятый список, который отстанет от кода на первой же
    новой ручке.
    """
    if p.is_file():
        return [p]
    out: list[Path] = []
    for f in sorted(p.rglob("*")):
        if f.suffix not in _SCANNABLE or not f.is_file():
            continue
        if any(part in _SKIP_DIRS for part in f.relative_to(p).parts):
            continue
        out.append(f)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--strict", action="store_true", help="валить на любой находке")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    paths = [Path(p).resolve() for p in args.paths] or [root / s for s in SURFACES]

    # 🚨 ПУТЬ ИЗ STRICT ОБЯЗАН СУЩЕСТВОВАТЬ, и это не придирка к аккуратности.
    #
    # Совпадение ищется по имени (`rel in STRICT`), поэтому переименованный
    # экран выпадает из-под охраны БЕСШУМНО: проверка остаётся зелёной, а файл,
    # который её и породил, больше никто не смотрит. К 05.09.2026 так выпали
    # четыре из двадцати пяти — почти шестая часть списка.
    #
    # Проверяем ДО обхода: иначе сообщение утонет в двух тысячах предупреждений.
    dead = [s for s in STRICT if not (root / s).exists()]
    if dead:
        for s_ in dead:
            print(f"  ✗ STRICT указывает на несуществующий файл: {s_}")
        print(
            f"\nSTRICT-путей в никуда: {len(dead)}.\n"
            "\nWHAT: список вычищенных поверхностей отстал от кодовой базы.\n"
            "WHY:  совпадение ищется по ИМЕНИ, поэтому переименованный экран\n"
            "      выпадает из-под охраны молча — проверка зелёная, файл без\n"
            "      присмотра. Так уже выпали четыре экрана раздела «Базы».\n"
            "FIX:  найдите преемника (файл, куда переехал экран), вычистите его\n"
            "      и поставьте на место старого пути. Если экран удалён совсем —\n"
            "      уберите строку и напишите рядом, куда делся текст.\n"
        )
        return 1

    errors = warns = 0
    scanned = 0
    for p in paths:
        if not p.exists():
            print(f"  ✗ файл отсутствует: {p}")
            errors += 1
            continue
        for f in _expand(p):
            scanned += 1
            e, w = check(f, root, args.strict)
            errors += e
            warns += w

    if errors:
        print(f"\nнарушений на вычищенных поверхностях: {errors}"
              + (f"; предупреждений: {warns}" if warns else ""))
        print(
            "\nWHAT: типографика разошлась с правилами на поверхности из STRICT.\n"
            "WHY:  проверка смотрит в БАЙТЫ, а не на макет, и это принципиально:\n"
            "      поводом её завести стал прогон статус-страницы, где во всём\n"
            "      интерфейсе не было НИ ОДНОГО неразрывного пробела, а подсказка\n"
            "      печатала «доступность 99.9%». Два месяца этого не видел никто —\n"
            "      глазами такое не ловится.\n"
            "FIX:  1) неразрывный пробел (U+00A0) — после однобуквенных предлогов\n"
            "         и между числом и единицей: «в\u00a0проекте», «90\u00a0дней»;\n"
            "      2) тире — длинное (—) с неразрывным пробелом перед ним;\n"
            "      3) кавычки — «ёлочки», внутри „лапки“;\n"
            "      4) в дробях запятая, не точка: 99,9\u00a0%;\n"
            "      5) поверхность вычищена не до конца — не добавляйте её в STRICT,\n"
            "         пока не вычистили: список STRICT задаётся в этом скрипте."
        )
        return 1
    if warns:
        print(f"\nвычищенные поверхности чисты; предупреждений на остальных: {warns}")
        return 0
    print("типографика сходится с правилами ru-text")
    return 0


if __name__ == "__main__":
    sys.exit(main())
