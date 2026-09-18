#!/usr/bin/env bash
# Перегенерировать `src/generated/api-types.ts` из OpenAPI-схемы бэкенда.
#
# Единственный генератор живёт в core (`scripts/gen-sdk.sh` репозитория
# `LayeroInfra/core`): схема берётся ИЗ ПРИЛОЖЕНИЯ, а не с прода, и из неё
# вырезаны межсервисные и браузерные маршруты. Живой
# `https://api.layero.ru/openapi.json` для генерации не годится — он не
# отфильтрован (84 внутренних маршрута из 235), а вторая копия фильтра здесь
# была бы тем самым «списком в двух местах». Поэтому нужен соседний чекаут
# `../core` (приватный репозиторий, доступ у команды платформы).
#
#   bash scripts/gen-sdk.sh          # сгенерировать
#   bash scripts/gen-sdk.sh --check  # сверить закоммиченное со схемой
#
# Внешнему контрибьютору генератор не нужен: типы уже закоммичены, а их
# свежесть сторожит `contract.yml` в core на каждой правке ручки.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${CORE_DIR:-$HERE/../core}"

if [ ! -x "$CORE/scripts/gen-sdk.sh" ] && [ ! -f "$CORE/scripts/gen-sdk.sh" ]; then
  if [ "${1:-}" = "--check" ]; then
    echo "— соседний чекаут core не найден ($CORE); типы SDK не сверены (их сторожит contract.yml в core)." >&2
    exit 0
  fi
  echo "✗ нужен соседний чекаут LayeroInfra/core: $CORE" >&2
  exit 2
fi

CLI_DIR="$HERE" exec bash "$CORE/scripts/gen-sdk.sh" "$@"
