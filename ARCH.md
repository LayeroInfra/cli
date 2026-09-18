# cli — npm-пакет `layero`

TypeScript, публикуется в npm как `layero` (на 18.09.2026 — `0.10.5`,
совпадает с `latest`). Второй вход в платформу помимо привязки репозитория:
пакует папку, заливает и запускает тот же конвейер сборки минус клонирование.
С 0.10.0 умеет и первый вход — `projects create --repo` заводит проект из
репозитория подключённого провайдера, `sources connect` подключает
провайдера по токену.

Репозиторий `LayeroInfra/cli` — **источник** (с 18.09.2026; до того CLI
жил подпапкой `cli/` приватного `LayeroInfra/core`, а этот репозиторий был
зеркалом `git subtree`). Зеркало — `gitverse.ru/layero/cli`
(`mirror-gitverse.yml`). Платформа целиком — `../core/ARCH.md` (приватный
репозиторий).

## Устройство

| Файл | Что |
|---|---|
| `src/bin/layero.ts` | точка входа, разбор аргументов |
| `src/commands/` | 25 команд: `deploy`, `login`, `projects`, `sources`, `envs`, `claim`, `domains`, `env`, `data`, … |
| `src/exit-codes.ts` | класс выхода по коду ошибки: 2 вход, 3 не найдено, 4 ввод, 5 удалённо |
| `src/api.ts` | клиент control-plane API |
| `src/auth.ts` | device flow, хранение токена |
| `src/pack.ts` | упаковка каталога в архив |
| `src/detect.ts` | локальное определение типа приложения поверх `layero-detection` |
| `src/agent.ts` | режим JSON-lines для агентов |
| `src/generated/api-types.ts` | типы API из OpenAPI бэкенда; править не здесь — `make gen-sdk` |
| `test/fixtures/framework-detect/` | копия канона `core/tests/fixtures/framework-detect` — см. «Стыки» |
| `check-*.py` | гейты текстов, см. «Свои проверки» |

## Правила, из которых здесь всё

1. **`npx layero` без `@latest` — пин на годы.** `npx` **не ходит в реестр**,
   если пакет уже стоит локально или глобально: он запускает то, что есть.
   Нашлись ноутбук на `0.8.11` при опубликованном `0.8.20` и пользователь на
   `0.1.x`, у которого деплой не работал в принципе. Во всех текстах —
   только `npx layero@latest`. Ловит `check-npx-pin.py`.
2. **Внутри агента вывод переключается на JSON-lines** автоматически
   (`CURSOR_AGENT`, `CLAUDECODE` или не-TTY), и это касается **каждой**
   команды: с 0.10.0 `whoami`, `projects`, `orgs`, `link`, `hooks`, `logout`,
   `init` тоже идут через `emit()`. Событие `ready` несёт живой адрес — его
   и показывать, **не собирая имя хоста по шаблону**: адреса живут в зоне
   `layero.app`, а непереехавшие организации — ещё на `layero.ru`.
3. **`deploy` публикует на апекс.** Прямые загрузки автопромоутятся; `--prod`
   и отдельный `promote` не нужны. Способа выложить «просто посмотреть» из
   CLI нет: архивы всегда ложатся в зарезервированное окружение `cli`, и
   `--branch` с 0.10.0 **отклоняется** кодом `branch_unsupported` (до этого
   принимался и молча игнорировался — агент считал, что выложил превью, а
   заменил живой сайт). Хотите превью — нужен подключённый репозиторий и
   push в ветку: `projects create --repo`.
4. **Токен на диске — `~/.layero/config.json`, chmod 600.** Plain JSON без
   keytar: кроссплатформенно и без нативных модулей.
5. **Коды ошибок — контракт.** Документированный, но не выдаваемый код —
   отдельный класс дефекта, семь таких уже находили. Сверяет
   `check-error-codes.py`.
6. **Коды выхода — по классам, а не `exit 1` на всё.** 2 вход, 3 не
   найдено, 4 неверный ввод, 5 удалённая ошибка, 1 прочее. Класс берётся из
   кода ошибки (`src/exit-codes.ts`), то есть новый код обязан попасть в
   список, иначе выйдет единицей.
7. **Claimable — сайт без аккаунта** (`deploy --claim`): временный проект на
   72 часа и токен на него; токен — в `~/.layero/config.json`, код заявки —
   в `.layero/project.json`. Принять заявку может только человек в панели.
   В CI автоматически не включается: забытый `LAYERO_TOKEN` должен быть
   отказом, а не сайтом на исчезающем адресе. Песочница — только для
   **нового** проекта: с `--project` или в папке, привязанной к проекту
   аккаунта, без токена идёт вход (`auth_required`), а `--claim --project`
   отклоняется кодом `claim_with_project`. До 0.10.5 авто-режим включался и
   тут, и платформа отвечала `username_required` про держателя песочницы.

## Стыки с другими репозиториями

Правило размещения: гейт живёт рядом с тем, что сверяет; сверка двух
репозиториев ходит в соседний чекаут (`../core`, `../layero-docs`,
`../frontend`, `../mcp`) и без него **пропускает с пометкой**, не молча.

| Стык | Кто источник | Где гейт | Без соседа |
|---|---|---|---|
| `src/generated/api-types.ts` ↔ схема API | бэкенд в `../core` (`scripts/export-openapi.py`, схема из приложения, не с прода) | `make gen-check` здесь; `contract.yml` в core клонирует этот репозиторий и сверяет на каждой правке ручки | пропуск |
| `layero-detection` в `package.json`/локе ↔ версия спеки | `../core/detection/package.json`, иначе `npm view` | `check-detection-version.py` (в `make check` и `ci.yml`) | npm |
| `test/fixtures/framework-detect` ↔ канон в core | `../core/tests/fixtures/framework-detect` | `make check-fixtures` (в `make check`) | пропуск |
| входы детекта в `src/` | — | `core/checks/check-detect-call-sites.py` читает `../cli` | пропуск там |
| коды ошибок, `npx layero@latest`, типографика в текстах доков/лендинга/панели/MCP | код CLI (`LayeroError`) | `check-error-codes.py`, `check-npx-pin.py`, `check-typography.py` — `make check-texts`; те же скрипты зовут `layero-docs/Makefile`, `frontend/Makefile`, `mcp/check-copy-rules.py`, `core/Makefile check-typography` как `../cli/check-*.py` | отказ (охват выверен) |

Живой `https://api.layero.ru/openapi.json` источником типов **не** служит:
он не отфильтрован (84 межсервисных маршрута из 235), а второй копии фильтра
быть не должно. Поэтому `make gen-sdk` требует `../core`.

## Свои проверки

```bash
make check            # build + test + check-detection + check-fixtures + gen-check
make check-texts      # три гейта текстов по соседним репозиториям
python3 check-error-codes.py           # коды ↔ конструкторы LayeroError
python3 check-npx-pin.py               # `npx layero` ↔ `@latest`
python3 check-typography.py            # неразрывные пробелы, тире, кавычки (читает core, frontend, docs)
python3 check-detection-version.py     # layero-detection ↔ спека
```

## Команды

```bash
npm run build     # tsc
npm test
npm run dev
```

## Выкатка

Публикацию ведёт `.github/workflows/publish.yml` по тегу `vX.Y.Z`
(до 18.09.2026 — `cli-vX.Y.Z` в core). Версия поднимается в `package.json`
на `main`, тег обязан с ней совпасть (шаг проверяет). Аутентификация —
npm Trusted Publishing (OIDC); **trusted publisher пакета надо перепривязать
на этот репозиторий** (шаг человека, см. шапку `publish.yml`), запасной путь
— секрет `NPM_TOKEN`. После публикации **проверять живым** —
`npx layero@latest --version` из чистого окружения, а не `npm view`.

## Чего CLI НЕ делает

Не собирает локально (сборка на платформе), не создаёт проект без явного
имени или каталога, не умеет публиковать не затрагивая живой адрес.

## Дальше читать

* `AGENTS.md` — правила репозитория, Definition of Done
* `../core/ARCH.md` — общая карта платформы (приватный репозиторий)
* `../core/docs/TEXT-CHECKS.md` — зачем заведена каждая проверка текстов
* `README.md` — пользовательское описание пакета
* `../layero-docs/docs/cli/` — документация команд
