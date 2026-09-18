# AGENTS.md — cli

Публичный репозиторий `LayeroInfra/cli`: npm-пакет `layero`, CLI платформы
Layero. **Источник, не зеркало** (с 18.09.2026; раньше — подпапка `cli/`
приватного `LayeroInfra/core`). **Push в `main` виден всем** — секретов,
внутренних адресов и черновиков здесь не бывает.

Сначала прочитай корневой `../AGENTS.md` (необратимые запреты платформы),
затем `ARCH.md` — устройство, правила и стыки с другими репозиториями.

## Команды

```bash
make check         # build + vitest + сверки без соседей — «готово или нет»
make check-texts   # коды ошибок, npx-пин, типографика по ../layero-docs, ../frontend, ../mcp, ../core
make gen-sdk       # перегенерировать src/generated/api-types.ts (нужен ../core)
npm run dev        # tsc --watch
```

`make check` обязателен перед пушем. `make check-texts` — перед релизом и
после любой правки текстов пользователю (кодов ошибок, README, `init.ts`).

## Definition of Done

1. `make check` зелёный.
2. Правил код ошибки или текст — `make check-texts` зелёный
   (`check-typography` на 18.09.2026 красный из-за семи устаревших STRICT-путей
   в панели — чужой долг, не маскировать своим).
3. Новое поведение покрыто тестом в `test/` — весь сьют гоняется в CI,
   выбранных списков нет.
4. Если правился `package.json`/лок — `check-detection-version.py` зелёный.
5. Релиз: версия в `package.json` поднята на `main`, тег `vX.Y.Z` запушен,
   `publish.yml` зелёный, **`npx layero@latest --version` из чистого
   окружения** показывает новую версию. `npm view` не считается.

## Жёсткие ограничения

1. **MUST NOT** править `src/generated/api-types.ts` руками — только
   `make gen-sdk`. Свежесть сторожит `contract.yml` в core: ручка поменялась
   → типы перегенерированы и запушены СЮДА → потом push в core. Обратный
   порядок держит выкатку api красной.
2. **MUST** — `npx layero` в любом тексте только с `@latest`.
3. **MUST** — новый код ошибки попадает в `src/exit-codes.ts` (класс выхода)
   и в `layero-docs/docs/cli/json-events.md` (обе локали); ловит
   `check-error-codes.py`.
4. **MUST NOT** — заводить второй источник для того, что уже есть в core:
   фильтр OpenAPI, спека детекта, список фикстур. Копия фикстур
   `test/fixtures/framework-detect` допустима только байт-в-байт с каноном
   (`make check-fixtures`); правится в core и копируется сюда.
5. **MUST NOT** — подключать self-hosted раннер флота к workflow этого
   репозитория: публичный репозиторий исполняет код чужих PR.
6. **MUST NOT** — публиковать в npm руками с ноутбука. Только `publish.yml`.

## Публикация

`publish.yml`, тег `vX.Y.Z`, ubuntu-latest, npm Trusted Publishing (OIDC).

🚨 **Шаг человека, без него релиз не пройдёт:** trusted publisher пакета
`layero` на npmjs.com привязан к `LayeroInfra/core` + `publish-cli.yml`,
которых больше нет. Перепривязать: npmjs.com → `layero` → Settings →
Trusted Publisher → GitHub Actions: org `LayeroInfra`, repo `cli`, workflow
`publish.yml`. Запасной путь — секрет `NPM_TOKEN` в этом репозитории
(granular token с publish на `layero`): если задан, `publish.yml` идёт по
нему. Версия 0.10.2 опубликована из core; новый номер нужен только при
изменении кода пакета (гейты и workflow в тарболл не входят).

Зеркало на GitVerse (`gitverse.ru/layero/cli`) — `mirror-gitverse.yml` на
push в `main`, секреты организации `GITVERSE_LOGIN`/`GITVERSE_TOKEN`.

## Гейты и где они живут

Правило платформы: гейт живёт рядом с тем, что сверяет. Здесь — сверки
текстов с кодом CLI и CLI со спекой детекта; сверки частей core между собой
— в `core/checks/`. Соседние репозитории зовут наши скрипты как
`../cli/check-*.py` (`layero-docs/Makefile`, `frontend/Makefile`,
`mcp/check-copy-rules.py`, `core/Makefile check-typography`). Переименовал
скрипт — поправь их в тот же заход.

## Соседи

Рабочий корень со всеми репозиториями: `../core` (приватный — бэкенд,
генератор SDK, канон фикстур), `../layero-docs`, `../frontend`, `../mcp`,
`../layero-agents`. Без соседа гейт пропускает с пометкой (`gen-check`,
`check-fixtures`, `check-detection-version` → npm) или честно отказывает
(`check-texts`: охват поверхностей выверен, усохший список опаснее красного).
