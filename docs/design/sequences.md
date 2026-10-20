# Sequence-диаграммы

Версия 0.3. Вызовы и коды совпадают с [OpenAPI](../api/openapi.yaml), интеграции — с [amoCRM](../integrations/amocrm.md) и [Telegram](../integrations/telegram.md), правила базы — с [моделью данных](data-model.md).

| Диаграмма | Что разбирает |
|---|---|
| [SD-1. Заявка из amoCRM](#sd-1-заявка-из-amocrm) | Вебхук как сигнал, дубли, устаревшие события |
| [SD-2. Окно откликов и честный выбор](#sd-2-окно-откликов-и-честный-выбор) | D-11, пересечения, ручное назначение во время окна |
| [SD-3. Сводка и подтверждение выхода](#sd-3-сводка-и-подтверждение-выхода) | US-08, US-09, эскалация «Нет подтверждения» |
| [SD-4. Отписка клиенту](#sd-4-отписка-клиенту) | US-10, крайний срок, смена гида после отписки |
| [SD-5. Сбои Telegram](#sd-5-сбои-telegram) | 429, 403, повтор обновления |

## SD-1. Заявка из amoCRM

amoCRM ждёт ответ не дольше 2 секунд, поэтому вебхук только сохраняется. Данные сделки берутся из API: вебхук — сигнал, а не источник правды ([ADR-001](../decisions/adr/ADR-001-webhook-as-signal.md)).

```mermaid
sequenceDiagram
  autonumber
  participant CRM as amoCRM
  participant D as Диспетчер
  participant DB as База
  participant W as Обработчик событий
  CRM->>D: POST /integrations/amocrm/webhook, leads[update][0][id]
  D->>DB: сохранить тело, ключ сделка + действие + last_modified
  alt ключ уже есть
    DB-->>D: дубль
  else новое событие
    DB-->>D: сохранено
  end
  D-->>CRM: 200 быстрее 2 с
  W->>DB: взять необработанные события
  W->>CRM: GET /api/v4/leads/{id}?with=contacts
  CRM-->>W: сделка, updated_at, поля, контакт
  W->>DB: применить сделку, сравнить updated_at
  alt сделка новая
    DB-->>W: CREATED, группы 14, 13, 13
    W->>W: запустить поиск гида для каждой группы
  else updated_at новее сохранённого
    DB-->>W: UPDATED, правила BR-21 и BR-22
  else updated_at не новее
    DB-->>W: STALE, событие только отмечается
  end
  Note over CRM,W: если вебхуки не приходят, раз в 15 мин сверка по filter[updated_at]
```

## SD-2. Окно откликов и честный выбор

Скорость доставки уведомлений Telegram у гидов разная, поэтому порядок нажатий в окне не важен ([ADR-002](../decisions/adr/ADR-002-response-window.md)).

```mermaid
sequenceDiagram
  autonumber
  participant D as Диспетчер
  participant TG as Telegram
  participant A as Гид А
  participant B as Гид Б
  participant DB as База
  D->>TG: предложение свободным гидам, окно до 11:10
  TG->>B: предложение, доставлено через 2 с
  TG->>A: предложение, доставлено через 15 с
  B->>TG: «Хочу взять»
  TG->>D: callback_query от Б
  D->>DB: отклик Б
  D->>TG: answerCallbackQuery «Вы в числе кандидатов»
  A->>TG: «Хочу взять»
  TG->>D: callback_query от А
  D->>DB: отклик А
  Note over D,DB: 11:10, окно закрылось
  D->>DB: select_guide: у А 3 группы на неделе, у Б 5
  alt у А нет пересечения
    DB-->>D: назначен А
  else у А появилась группа на это время
    DB-->>D: исключающее ограничение, назначен Б
  end
  D->>TG: назначенному — «Группа ваша»
  D->>TG: остальным — editMessageText «Группу получил другой гид»
  Note over D,DB: если администратор назначил гида вручную до 11:10, select_guide ничего не делает
```

## SD-3. Сводка и подтверждение выхода

```mermaid
sequenceDiagram
  autonumber
  participant P as Планировщик
  participant DB as База
  participant TG as Telegram
  participant G as Гид
  participant ADM as Дежурный
  P->>DB: 19:00, группы на завтра по гидам
  P->>DB: уведомление с ключом digest:гид:дата
  Note over P,DB: повторный запуск не создаст вторую сводку, ключ уникален
  P->>TG: сводка на завтра
  TG->>G: ваши группы на завтра
  P->>TG: 12:00, за 2 ч до группы в 14:00
  TG->>G: «Подтвердить выход» и «Попросить замену»
  alt гид подтвердил
    G->>TG: «Подтвердить выход»
    TG->>P: callback_query
    P->>DB: ASSIGNED в CONFIRMED
  else нет ответа к 13:00
    P->>DB: эскалация «Нет подтверждения»
    P->>TG: сообщение дежурному с кнопкой «Взять в работу»
    TG->>ADM: эскалация
    Note over P,ADM: 15 минут без реакции — эскалацию получают все администраторы
  end
```

## SD-4. Отписка клиенту

```mermaid
sequenceDiagram
  autonumber
  participant P as Планировщик
  participant DB as База
  participant ADM as Администратор
  participant C as Клиент
  P->>DB: 12:00 накануне, все гиды заявки назначены?
  alt все назначены
    P->>DB: отписка PENDING с текстом, картой, фото и телефонами гидов
  else кого-то нет
    P->>P: ждать назначения, но не позже 18:00
  end
  ADM->>DB: GET /v1/notices
  ADM->>C: текст в Telegram по ссылке на чат
  ADM->>DB: POST /v1/notices/{id}/sent, канал TELEGRAM
  Note over P,ADM: к 18:00 не отмечено — сообщение всем администраторам
  Note over DB,C: гид сменился после отправки — новая отписка GUIDE_CHANGED с контактом нового гида
```

## SD-5. Сбои Telegram

```mermaid
sequenceDiagram
  autonumber
  participant Q as Очередь отправки
  participant TG as Telegram
  participant DB as База
  participant ADM as Дежурный
  Q->>TG: sendMessage
  TG-->>Q: 429, retry_after 7
  Q->>Q: пауза 7 с
  Q->>TG: sendMessage, повтор
  TG-->>Q: 200, message_id
  Q->>TG: sendMessage гиду В
  TG-->>Q: 403, bot was blocked by the user
  Q->>DB: bot_blocked_at, гид исключён из предложений
  Q->>DB: эскалация «Гид заблокировал бота» по его группам
  Q->>ADM: эскалация
  TG->>Q: обновление update_id 734119021
  TG->>Q: то же обновление повторно
  Q->>Q: update_id уже обработан, второй раз не применяется
```
