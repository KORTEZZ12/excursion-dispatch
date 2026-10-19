# Диспетчер экскурсий

Сервис координации гидов для экскурсионного агентства. Заявка превращается в группы, гиды получают предложения в Telegram-боте, система напоминает им о группах, накануне готовит отписку для клиента и алертит  администратора, когда что-то пошло не так.

Доменные правила взяты из моего опыта работы гидом и интервью с коллегами. [как устроена работа](docs/00-process.md).

**Статус:** итерации 1 и 2 из 4 — исследование, требования, системный дизайн. Следующий шаг — MVP. [CHANGELOG](CHANGELOG.md).

## Проблема

Группы доходят до гидов через общий Telegram-чат и личные сообщения администраторов. Сообщения теряются в ленте, гиды забывают про группы, а уточнить детали не всегда есть у кого. [AS-IS](docs/research/as-is.md).

## Что показало исследование

Группы теряются в личной переписке с администратором. А администраторам вечерние сообщения гидам уходит 2–2,5 часа в день. Около 6 групп в месяц передают партнёрам, потому что гид не нашёлся. Подробно в [итогах исследования](docs/research/findings.md).

![AS-IS](docs/bpmn/as-is-dispatch.svg)

Документация API в браузере: [kortezz12.github.io/excursion-dispatch/api](https://kortezz12.github.io/excursion-dispatch/api/).

## Карта артефактов

| Артефакт | Где | Статус |
|---|---|---|
| Как устроена работа | [docs/00-process.md](docs/00-process.md) | v0.1 |
| AS-IS и боли | [docs/research/as-is.md](docs/research/as-is.md), [схема](docs/bpmn/as-is-dispatch.bpmn) | v0.1 |
| Гипотезы, гайд, итоги и протоколы интервью | [docs/research](docs/research) | v0.2 |
| Видение, метрики, границы MVP | [docs/requirements/vision.md](docs/requirements/vision.md) | v0.1 |
| Бизнес-правила и параметры | [docs/requirements/business-rules.md](docs/requirements/business-rules.md) | v0.1 |
| Процессы TO-BE (Camunda 8) | [docs/bpmn](docs/bpmn) | v0.1 |
| Бэклог с критериями приёмки | [docs/requirements/backlog.md](docs/requirements/backlog.md) | v0.1 |
| Нефункциональные требования | [docs/requirements/nfr.md](docs/requirements/nfr.md) | v0.1 |
| Глоссарий | [docs/requirements/glossary.md](docs/requirements/glossary.md) | v0.1 |
| Журнал решений | [docs/decisions/decision-log.md](docs/decisions/decision-log.md) | v0.1 |
| Статусная модель группы | [docs/design/group-states.md](docs/design/group-states.md) | v0.3 |
| Модель данных, DDL, проверки | [docs/design/data-model.md](docs/design/data-model.md) | v0.3 |
| Sequence-диаграммы | [docs/design/sequences.md](docs/design/sequences.md) | v0.3 |
| OpenAPI и каталог ошибок | [docs/api](docs/api) | v0.3 |
| Интеграции: amoCRM, Telegram | [docs/integrations](docs/integrations) | v0.3 |
| ADR | [docs/decisions/adr](docs/decisions/adr) | v0.3 |
| MVP | — | итерация 3 |
