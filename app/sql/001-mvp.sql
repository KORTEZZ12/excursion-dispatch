-- Схема приложения MVP релиза 1. Применяется после docs/design/ddl.sql.
-- Модель данных — исполнимая спецификация правил, а сервису нужно ещё состояние работы: что уже отправлено,
-- какие сроки идут, какие ключи действий использованы. Каждая таблица здесь — находка итерации 3:
-- её нужно перенести в модель данных или оставить деталью реализации (docs/mvp/README.md, раздел «Находки»).

-- Очередь отправки: в модели у сообщения нет тела, отправлять было нечего (находка M-01).
-- group_id и assignment_id — чтобы снятие, замена и отмена помечали сообщения неактуальными
-- (задача invalidate-guide-messages в to-be-preparation.bpmn)
ALTER TABLE dispatch.notification
    ADD COLUMN body           jsonb,
    ADD COLUMN group_id       uuid REFERENCES dispatch.excursion_group (id),
    ADD COLUMN assignment_id  uuid,
    ADD COLUMN created_at     timestamptz,
    ADD COLUMN sent_at        timestamptz;
CREATE INDEX notification_by_assignment ON dispatch.notification (assignment_id) WHERE status = 'QUEUED';
CREATE INDEX notification_by_group ON dispatch.notification (group_id) WHERE status = 'QUEUED';

-- Ключи действий администратора: повтор возвращает сохранённый ответ первого выполнения, ключ живёт 24 ч
CREATE TABLE dispatch.idempotency_key (
    admin_id      uuid NOT NULL REFERENCES dispatch.admin (id),
    key           uuid NOT NULL,
    request_hash  text NOT NULL,
    status        integer NOT NULL,
    headers       jsonb NOT NULL,
    body          jsonb,
    created_at    timestamptz NOT NULL,
    PRIMARY KEY (admin_id, key)
);

-- Обновления Telegram обрабатываются по update_id один раз
CREATE TABLE dispatch.telegram_update (
    update_id    bigint PRIMARY KEY,
    received_at  timestamptz NOT NULL
);

-- Подключение гида по шагам: приглашение → телефон → согласие (US-21). Гид появляется в базе только с согласием
CREATE TABLE dispatch.bot_session (
    telegram_user_id  bigint PRIMARY KEY,
    chat_id           bigint NOT NULL,
    step              text NOT NULL CHECK (step IN ('WAIT_CONTACT', 'WAIT_CONSENT', 'WAIT_REVOKE_CONFIRM')),
    token             text REFERENCES dispatch.guide_invitation (token),
    full_name         text,
    username          text,
    phone_e164        text,
    updated_at        timestamptz NOT NULL
);

-- Запрос подтверждения выхода — один на гида и день, перед первой группой (BR-13, D-15)
CREATE TABLE dispatch.confirmation_request (
    guide_id      uuid NOT NULL REFERENCES dispatch.guide (id),
    day           date NOT NULL,
    requested_at  timestamptz NOT NULL,
    PRIMARY KEY (guide_id, day)
);

-- Запрос «Подтвердить новое время» после переноса (BR-21). Срок P-13 считается вне тихих часов
CREATE TABLE dispatch.new_time_request (
    assignment_id  uuid PRIMARY KEY,
    group_id       uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    requested_at   timestamptz NOT NULL,
    due_at         timestamptz NOT NULL,
    confirmed_at   timestamptz,
    closed_at      timestamptz
);

-- Срок поиска гида для раунда (BR-08): когда создать эскалацию «Гид не найден»
CREATE TABLE dispatch.search_timer (
    group_id      uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    search_round  integer NOT NULL,
    started_at    timestamptz NOT NULL,
    due_at        timestamptz NOT NULL,
    escalated_at  timestamptz,
    PRIMARY KEY (group_id, search_round)
);

-- «Требует внимания»: заявки, которые нельзя обработать автоматически (US-01, BR-04, BR-32, BR-36).
-- В модели данных такого раздела не было, а у части заявок нет даже записи booking (находка M-03)
CREATE TABLE dispatch.attention (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id   uuid REFERENCES dispatch.booking (id),
    external_id  bigint,
    reason       text NOT NULL CHECK (reason IN
                     ('CRM_FIELDS_MISSING', 'ROUTE_NOT_FOUND', 'START_IN_PAST', 'NO_TARIFF',
                      'RESYNC_CONFLICT', 'AUTO_COMPLETED')),
    detail       text,
    created_at   timestamptz NOT NULL,
    resolved_at  timestamptz
);
CREATE UNIQUE INDEX attention_one_open
    ON dispatch.attention (COALESCE(booking_id::text, external_id::text), reason) WHERE resolved_at IS NULL;

-- Разовые запуски заданий по расписанию: сводка за дату, проверка тихого отказа (BR-11, NFR-16)
CREATE TABLE dispatch.job_run (
    job      text NOT NULL,
    run_key  text NOT NULL,
    at       timestamptz NOT NULL,
    PRIMARY KEY (job, run_key)
);

-- Сверка с amoCRM: с момента последней успешной минус 5 минут (NFR-06)
CREATE TABLE dispatch.crm_sync (
    id               integer PRIMARY KEY CHECK (id = 1),
    last_success_at  timestamptz,
    last_run_at      timestamptz
);
INSERT INTO dispatch.crm_sync (id) VALUES (1);

-- Повторы обработки входящего события: API amoCRM не ответил — через 1, 5 и 15 мин, затем алерт
ALTER TABLE dispatch.inbound_event
    ADD COLUMN attempts         integer NOT NULL DEFAULT 0,
    ADD COLUMN next_attempt_at  timestamptz;

-- Резервный канал тревог — звонок (D-14). Провайдер не выбран (Q-06), поэтому MVP пишет вызовы в журнал
CREATE TABLE dispatch.alarm (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at        timestamptz NOT NULL,
    admin_id  uuid NOT NULL REFERENCES dispatch.admin (id),
    kind      text NOT NULL,
    text      text NOT NULL
);

-- Кому ушла эскалация: дежурному или сразу всем (BR-25)
ALTER TABLE dispatch.escalation
    ADD COLUMN sent_to_all_at  timestamptz;
