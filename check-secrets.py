#!/usr/bin/env python3
"""Седьмая проверка на расхождение: секреты в репозитории.

Зачем. ИБ-ревью 07.08.2026 (SEC-12, T-20260807-11) нашло, что ни в одном из
трёх репозиториев нет ни проверки зависимостей, ни поиска секретов, ни
статического анализа. Единственные упоминания `audit` в CI — это флаги
`--no-audit`, то есть проверка была выключена явно.

Почему свой сканер, а не gitleaks. Универсальный сканер тянет бинарь из сети
(лишнее звено в цепочке поставки на машине, где живут ключи прода) и на нашем
коде даёт шум: в репозитории лежат примеры конфигов, тестовые фикстуры и
докстроки, где формы токенов упоминаются намеренно. Здесь ищутся ФОРМЫ ИМЕННО
НАШИХ секретов — их список конечен и известен, а список исключений можно
объяснить построчно. Правило то же, что у остальных проверок §5.1: проверка
должна кусаться, а не декорировать.

Что ищется — по префиксам и формам, а не по энтропии: энтропийный поиск на
минифицированном JS и хэшах даёт больше ложных, чем настоящих.

Запуск:
    python3 core/cli/check-secrets.py            # рабочее дерево
    python3 core/cli/check-secrets.py --staged   # только проиндексированное
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# (имя, регулярка, почему это важно)
PATTERNS: list[tuple[str, re.Pattern, str]] = [
    ("YC static key", re.compile(r"\bYCAJ[A-Za-z0-9_\-]{30,}"),
     "статический ключ сервисного аккаунта Yandex Cloud"),
    ("YC IAM token", re.compile(r"\bt1\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{50,}"),
     "IAM-токен YC"),
    ("YC OAuth", re.compile(r"\by[0-3]_[A-Za-z0-9_\-]{40,}"),
     "OAuth-токен Яндекса"),
    ("AWS-style key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
     "ключ S3-совместимого доступа"),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
     "токен GitHub — доступ к репозиториям и Actions"),
    ("Telegram bot", re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_\-]{32,}"),
     "токен бота Telegram — полный контроль над ботом поддержки"),
    ("YooKassa secret", re.compile(r"\blive_[A-Za-z0-9_\-]{30,}"),
     "боевой ключ ЮKassa — движение денег"),
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),
     "приватный ключ целиком"),
    # Хост ОБЯЗАН быть внешним. Строка к localhost / имени сервиса compose —
    # это конфиг разработчика, а не секрет: пароль там сплошь и рядом равен
    # имени пользователя (`layero:layero@localhost`). Первая версия правила
    # ловила 18 таких на одном репозитории и ни одной настоящей — проверка,
    # которая кричит всегда, перестаёт что-либо значить.
    # 🚨 Зарезервированные RFC 2606 имена — НЕ хост. `example.com/.net/.org`,
    # `.example`, `.invalid`, `.test` существуют ровно для документации и
    # тестов и не резолвятся ни во что: строка подключения туда физически
    # никуда не ведёт, то есть по определению не может быть утечкой.
    # Повод: 12.08 гейт покраснел на `mask_dsn("postgresql://bob:s3cret@
    # db.example.com/shop")` — тесте, который проверяет ЗАМАЗЫВАНИЕ пароля.
    # Пометить строку маркером было можно, но это лечит один случай, а
    # фикстуры с фиктивным DSN будут появляться и дальше.
    ("Postgres URL с паролем", re.compile(
        r"postgres(?:ql)?://[^\s:@/]+:[^\s:@/]{6,}@"
        r"(?!localhost|127\.0\.0\.1|postgres[:/]|db[:/]|host\.docker\.internal)"
        r"(?![A-Za-z0-9.\-]*\.(?:example\.(?:com|net|org)|example|invalid|test)(?:[:/]|$))"
        r"[A-Za-z0-9.\-]+\.[A-Za-z0-9.\-]+"),
     "строка подключения к ВНЕШНЕМУ хосту с паролем"),
]

# Пути, которые не сканируются, и почему. Список короткий намеренно: каждая
# строка здесь — это дыра, через которую секрет может проехать незамеченным.
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "__pycache__", ".venv",
    ".next", "coverage", ".mypy_cache", ".pytest_cache",
}
SKIP_SUFFIXES = {
    ".lock", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz", ".br",
    ".mmdb", ".wasm", ".map",
}

# Точечные исключения: файл + причина. Не каталоги — файлы, чтобы новый файл
# рядом не унаследовал молчание.
ALLOWLIST: dict[str, str] = {
    # Сам этот файл содержит все формы в виде регулярок.
    "core/cli/check-secrets.py": "определения форм, а не значения",
}

_MARKER = "check-secrets: ok"  # пометка в строке = осознанное исключение


def scan_text(rel: str, text: str) -> list[tuple[int, str, str]]:
    out = []
    for n, line in enumerate(text.split("\n"), 1):
        if _MARKER in line:
            continue
        for name, rx, why in PATTERNS:
            if rx.search(line):
                out.append((n, name, why))
    return out


def iter_files(root: Path, staged: bool) -> list[Path]:
    """Только то, что РЕПОЗИТОРИЙ действительно несёт.

    Первая версия обходила рабочее дерево целиком и дала 341 находку, из
    которых настоящих — ноль: плейсхолдеры `postgres://user:password@` в
    `.env.example`, шесть копий репозитория в `.agent-wt/` и локальный
    `fleetview/.tg.env` с боевым токеном бота — файл под `.gitignore`, правами
    0600 и вне индекса, то есть обработанный ПРАВИЛЬНО.

    Отсюда вывод, ради которого стоит помнить: секрет опасен там, где он
    ЗАКОММИЧЕН. `git ls-files` — это и есть точная граница, а заодно
    бесплатное уважение к `.gitignore` и отсутствие лишних правил-исключений,
    каждое из которых само по себе дыра.
    """
    cmd = (["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"]
           if staged else ["git", "ls-files"])
    res = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"  ✗ не git-репозиторий: {root}", file=sys.stderr)
        return []
    out = []
    for rel in res.stdout.split("\n"):
        rel = rel.strip()
        if not rel:
            continue
        p = root / rel
        if not p.is_file() or p.is_symlink():
            continue
        if any(part in SKIP_DIRS for part in Path(rel).parts):
            continue
        if p.suffix.lower() in SKIP_SUFFIXES:
            continue
        out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--staged", action="store_true")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    findings = 0
    scanned = 0
    for path in iter_files(root, args.staged):
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel = str(path.relative_to(root)) if root in path.parents else str(path)
        scanned += 1
        if any(rel.endswith(k.split("/")[-1]) and k in f"core/{rel}" or rel == k
               for k in ALLOWLIST):
            continue
        for n, name, why in scan_text(rel, text):
            print(f"  ✗ {rel}:{n}  {name} — {why}")
            findings += 1

    findings += _check_gateway_spec(root)

    if findings:
        print(f"\nнайдено похожего на секреты: {findings}")
        print(
            "\nWHAT: в репозитории строка, похожая на настоящий секрет.\n"
            "WHY:  секрет, попавший в git, считается скомпрометированным с момента\n"
            "      коммита — удалить его потом нельзя, история остаётся. Прод-значения\n"
            "      живут в YC Lockbox (`layero-prod-env`) и рендерятся при деплое;\n"
            "      в репозитории им места нет ни в каком виде.\n"
            "FIX:  1) это настоящий секрет — НЕ коммитьте, заведите его в Lockbox\n"
            "         (`yc lockbox secret add-version`) и задеплойте; если он уже\n"
            "         в истории — считайте утёкшим и ротируйте;\n"
            "      2) это пример или тестовая фикстура — держите её очевидно\n"
            "         ненастоящей и опишите в .env.example;\n"
            f"      3) заведомо не секрет — допишите в строку `{_MARKER}`\n"
            "         и объясните рядом, почему."
        )
        return 1
    print(f"секретов не найдено (просмотрено файлов: {scanned})")
    return 0


def _check_gateway_spec(root) -> int:
    """Спека шлюза обязана нести ПЛЕЙСХОЛДЕР, а не подставленный секрет.

    🚨 Общие шаблоны сюда не годятся: `API_GW_SHARED_SECRET` — случайный hex
    без префикса, и ни одна из девяти форм его не опознаёт. А цена коммита
    отрендеренной спеки высокая: значение заголовка `X-Layero-Gw` — это всё,
    что отделяет доверие к `X-Forwarded-For` от «доверяем кому угодно».
    Поэтому проверка точечная и по месту. Ревю 08.08.2026.
    """
    spec = root / "infra/api-gateway/layero-api-gateway.openapi.yaml"
    if not spec.exists():
        return 0
    bad = 0
    for n, line in enumerate(spec.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped.startswith("X-Layero-Gw:"):
            continue
        value = stripped.split(":", 1)[1].strip().strip('"').strip("'")
        if value != "${API_GW_SHARED_SECRET}":
            rel = spec.relative_to(root)
            print(f"  ✗ {rel}:{n}  X-Layero-Gw — подставленный секрет вместо "
                  f"плейсхолдера ${{API_GW_SHARED_SECRET}}")
            bad += 1
    return bad



if __name__ == "__main__":
    sys.exit(main())
