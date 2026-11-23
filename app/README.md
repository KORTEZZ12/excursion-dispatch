# MVP релиза 1

Диспетчер экскурсий по [спецификации](../docs): API панели, обработчик бота, приём событий amoCRM, планировщик и очередь отправки в одном процессе на Node 22 и PostgreSQL 16. Отчёт итерации и находки — [docs/mvp](../docs/mvp/README.md), протокол приёмки — [docs/mvp/acceptance.md](../docs/mvp/acceptance.md).

## Что входит

Релиз 1 по [D-12](../docs/decisions/decision-log.md): «расписание без переписки».

| История | Что работает |
|---|---|
| US-01 | Вебхук amoCRM как сигнал, сделка из API, переходное правило полей, группы по BR-02, повторы, перестановки, сверка раз в 15 мин, «Требует внимания» |
| US-06 | Ручное назначение и снятие гида с `Idempotency-Key` и `If-Match`, пересечения запрещает база, замена, позднее назначение |
| US-07 | «Мои группы» и карточка в боте, звонок клиенту через подменный номер |
| US-08 | Сводка в 19:00, сообщение о группе, назначенной после сборки сводки, тревога, если сводка не ушла к 19:05 |
| US-09 | Один запрос подтверждения на день, тихие часы, ранние группы, эскалации «Нет подтверждения» и «Гид просит замену» |
| US-11 | Отмена из amoCRM и аварийная отмена в панели, «Повторить в amoCRM» |
| US-12 | Перенос из amoCRM: «Подтвердить новое время», срок P-13 вне тихих часов, пересечение — в поиск |
| US-17 | Доска на день с фильтром «Требуют внимания», назначение прямо с доски |
| US-21 | Приглашение, телефон и согласие в боте, подтверждение администратором, деактивация, отзыв согласия |

Предложений и окна откликов, отписок, передачи партнёру, графика дежурств в панели и заявок из панели в релизе 1 нет: это релиз 2. Эскалации без графика дежурств уходят сразу всем администраторам (BR-25).

## Как устроено

| Модуль | Контейнер архитектуры | Что делает |
|---|---|---|
| [`src/api.mjs`](src/api.mjs) | API диспетчера | Операции панели по [OpenAPI](../docs/api/openapi.yaml), ключи действий, версии, каталог ошибок, вебхуки |
| [`src/bot.mjs`](src/bot.mjs) | Обработчик бота | Обновления Telegram, дубли по `update_id`, кнопки из [интеграции](../docs/integrations/telegram.md) |
| [`src/crm.mjs`](src/crm.mjs) | Обработчик событий amoCRM | Вебхук → сделка из API → заявка и группы ([ADR-001](../docs/decisions/adr/ADR-001-webhook-as-signal.md)), сверка |
| [`src/scheduler.mjs`](src/scheduler.mjs) | Планировщик заданий | Проходы с именами задач из BPMN: `collect-digests`, `request-confirmation`, `create-escalation`, `notify-all-admins` ([ADR-003](../docs/decisions/adr/ADR-003-scheduler-not-camunda.md)) |
| [`src/outbox.mjs`](src/outbox.mjs) | Очередь отправки | Тихие часы, срок годности, 429, 5xx, 403 (NFR-08, BR-14) |
| [`src/domain.mjs`](src/domain.mjs) | — | Назначение, снятие, отмена, перенос, число участников, эскалации поверх модели данных |
| [`public/board.html`](public/board.html) | Панель администратора | Доска групп |

Схема базы — [`docs/design/ddl.sql`](../docs/design/ddl.sql) и схема приложения [`sql/001-mvp.sql`](sql/001-mvp.sql): состояние работы, которого нет в модели данных. Состояние планировщика лежит в базе, поэтому перезапуск ничего не теряет (NFR-03).

![Доска групп](../docs/mvp/board.png)

## Запуск

```bash
cd app && npm ci
DATABASE_URL=postgres://… TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
AMOCRM_API_BASE=https://<поддомен>.amocrm.ru AMOCRM_TOKEN=… AMOCRM_WEBHOOK_SECRET=… AMOCRM_SUBDOMAIN=… \
ADMIN_TOKENS='{"<токен>":"<id администратора>"}' npm start
```

| Переменная | Что это |
|---|---|
| `DATABASE_URL` | PostgreSQL 16. Схема создаётся при первом запуске |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | Бот и секрет `setWebhook` (NFR-09) |
| `AMOCRM_API_BASE`, `AMOCRM_TOKEN`, `AMOCRM_WEBHOOK_SECRET`, `AMOCRM_SUBDOMAIN` | API amoCRM, секрет в адресе вебхука, проверка `account[subdomain]` |
| `AMOCRM_FIELDS`, `AMOCRM_STATUSES` | Идентификаторы полей сделки и этапов «Отменена», «Проведена» — у каждого аккаунта свои |
| `ADMIN_TOKENS` | Токены администраторов панели. Вход по учётной записи — вопрос Q-07 |
| `PROXY_PHONE` | Подменный номер для звонка клиенту, пока не выбран провайдер (Q-06) |
| `TICK_MS` | Шаг планировщика, по умолчанию 15 с |

Вебхуки: `POST /integrations/amocrm/webhook/<секрет>` в настройках amoCRM, `POST /integrations/telegram/webhook` в `setWebhook`. Панель — `/panel`.

## Тесты и демо

```bash
TEST_PG=postgres://postgres:postgres@localhost:5432 npm test      # 70 тестов, у каждого теста своя база
node test/acceptance.mjs                                           # протокол приёмки: каждый сценарий бэклога → тест
TEST_PG=… npm run demo                                             # панель с данными дня и подменами Telegram и amoCRM
```

Тесты идут против настоящего PostgreSQL и подмен Telegram Bot API и API amoCRM — HTTP-серверов, к которым диспетчер ходит теми же клиентами, что и в проде ([`test/fakes.mjs`](test/fakes.mjs)). Часы управляемые: сценарий «гид не ответил до 13:00» проходит без ожидания. Каждый ответ API сверяется с OpenAPI, незадокументированные поля запрещены ([`test/contract.mjs`](test/contract.mjs)).
