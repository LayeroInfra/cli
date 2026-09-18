.PHONY: help build test check check-texts check-detection check-fixtures gen-sdk gen-check

help:
	@echo "layero CLI — репозиторий LayeroInfra/cli"
	@echo ""
	@echo "  make check           — build + test + сверки, не требующие соседей (ответ «готово или нет»)"
	@echo "  make build           — tsc → dist/"
	@echo "  make test            — vitest (весь сьют, 17 файлов)"
	@echo "  make check-texts     — коды ошибок, npx-пин, типографика по соседним репозиториям"
	@echo "  make check-detection — зависимость layero-detection ↔ версия спеки (../core или npm)"
	@echo "  make check-fixtures  — копия фикстур детекта == ../core/tests/fixtures (если сосед есть)"
	@echo "  make gen-sdk         — перегенерировать src/generated/api-types.ts (нужен ../core)"
	@echo "  make gen-check       — сверить типы со схемой (нужен ../core; без него — пропуск)"

# `npm ci`, а не `npm install`: лок — часть контракта (см. check-detection —
# именно лок держал CLI на layero-detection 0.1.0 при свежем диапазоне).
node_modules: package-lock.json
	npm ci --no-audit --no-fund

build: node_modules
	npx tsc -p tsconfig.json

test: node_modules
	npx vitest run

# ── Сверки ──────────────────────────────────────────────────────────────────
#
# Правило: гейт живёт рядом с тем, что сверяет. Здесь — то, что сверяет
# ТЕКСТЫ с кодом CLI и сам CLI со спекой детекта. Всё, что сверяет части core
# между собой, живёт в `core/checks/`.
#
# Гейт, которому нужен соседний репозиторий, ходит в соседний чекаут
# (`../core`, `../layero-docs`, `../frontend`, `../mcp`) и без него
# пропускает С ПОМЕТКОЙ — молчаливый зелёный хуже красного.

# Версия спеки берётся из ../core/detection/package.json, а без соседа — из
# npm (`npm view layero-detection version`). Нет ни того, ни другого — пропуск.
check-detection:
	python3 check-detection-version.py

# Фикстуры детекта — КОПИЯ канона core/tests/fixtures/framework-detect: у
# публичного репозитория нет доступа к приватному core, а `npm test` обязан
# работать на чистом клоне. Копия обязана совпадать байт в байт — править в
# core и копировать сюда.
check-fixtures:
	@if [ -d ../core/tests/fixtures/framework-detect ]; then \
	  diff -r ../core/tests/fixtures/framework-detect test/fixtures/framework-detect \
	    && echo "✓ фикстуры детекта совпадают с ../core"; \
	else echo "— соседнего чекаута ../core нет: копия фикстур не сверена"; fi

# Тексты соседних репозиториев ↔ код CLI. Все три требуют соседей
# (layero-docs, frontend, mcp, core); отсутствие поверхности у первых двух —
# ОТКАЗ, не пропуск (охват выверен). В `check` не входят — в CI выкачан один
# этот репозиторий. Гонять перед выкаткой текстов и релизом.
check-texts:
	python3 check-error-codes.py
	python3 check-npx-pin.py
	python3 check-typography.py

# Типы SDK порождаются схемой бэкенда (единственный генератор — в core).
gen-sdk:
	bash scripts/gen-sdk.sh

gen-check:
	bash scripts/gen-sdk.sh --check

check: build test check-detection check-fixtures gen-check
	@echo ""
	@echo "✅ ALL CHECKS PASSED"
