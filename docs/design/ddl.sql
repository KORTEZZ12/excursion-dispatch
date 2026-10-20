-- Диспетчер экскурсий: модель данных, версия 0.3
-- PostgreSQL 16. Одна база сервиса, схема dispatch. Описание — data-model.md.
-- Функции здесь — исполняемая спецификация правил, в сервисе их можно реализовать кодом с теми же гарантиями.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- равенство uuid в исключающих ограничениях
CREATE SCHEMA dispatch;

-- =====================================================================
-- Справочники и параметры
-- =====================================================================

CREATE TABLE dispatch.parameter (            -- NFR-14: параметры P-xx меняет администратор
    code        text PRIMARY KEY CHECK (code ~ '^P-[0-9]{2}$'),
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispatch.route (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     text NOT NULL UNIQUE,
    duration                 interval NOT NULL CHECK (duration > interval '0'),
    meeting_point            text NOT NULL,
    meeting_point_map_url    text NOT NULL,       -- BR-15: ссылка на точку сбора
    meeting_point_photo_url  text,                -- BR-15: фото места
    active                   boolean NOT NULL DEFAULT true
);

CREATE TABLE dispatch.route_point (           -- US-27: точки маршрута для поиска пересечений
    route_id    uuid NOT NULL REFERENCES dispatch.route (id),
    seq         integer NOT NULL CHECK (seq > 0),
    name        text NOT NULL,
    at_offset   interval NOT NULL CHECK (at_offset >= interval '0'),
    PRIMARY KEY (route_id, seq)
);

-- BR-32: тарифы с периодом действия, периоды одной категории не пересекаются
CREATE TABLE dispatch.tariff (
    route_id    uuid NOT NULL REFERENCES dispatch.route (id),
    category    text NOT NULL CHECK (category IN ('ADULT', 'CHILD', 'DISCOUNTED')),
    price       numeric(10, 2) NOT NULL CHECK (price >= 0),
    valid       daterange NOT NULL CHECK (NOT isempty(valid)),
    EXCLUDE USING gist (route_id WITH =, category WITH =, valid WITH &&)
);

CREATE TABLE dispatch.admin (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name         text NOT NULL,
    telegram_user_id  bigint UNIQUE,
    active            boolean NOT NULL DEFAULT true
);

-- US-25: в каждый момент дежурит не больше одного администратора
CREATE TABLE dispatch.duty_shift (
    admin_id  uuid NOT NULL REFERENCES dispatch.admin (id),
    during    tstzrange NOT NULL CHECK (NOT isempty(during)),
    EXCLUDE USING gist (during WITH &&)
);

-- =====================================================================
-- Гиды
-- =====================================================================

CREATE TABLE dispatch.guide (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name               text NOT NULL,
    phone_e164              text NOT NULL CHECK (phone_e164 ~ '^\+7[0-9]{10}$'),
    telegram_user_id        bigint UNIQUE,
    telegram_chat_id        bigint,
    status                  text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'DEACTIVATED')),
    phone_share_consent_at  timestamptz,           -- BR-17, BR-28: согласие передавать телефон клиентам
    bot_blocked_at          timestamptz,           -- BR-31: Telegram ответил 403
    CHECK (status = 'PENDING_APPROVAL' OR telegram_user_id IS NOT NULL),
    CHECK (status <> 'ACTIVE' OR phone_share_consent_at IS NOT NULL)
);

-- BR-28: приглашение — одноразовый параметр deep link t.me/<бот>?start=<token>.
-- Telegram пропускает в нём до 64 символов A–Z, a–z, 0–9, _ и -
CREATE TABLE dispatch.guide_invitation (
    token          text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{16,64}$'),
    created_by     uuid NOT NULL REFERENCES dispatch.admin (id),
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz,
    used_by_guide  uuid REFERENCES dispatch.guide (id),
    CHECK ((used_at IS NULL) = (used_by_guide IS NULL))
);

-- =====================================================================
-- Клиенты и заявки
-- =====================================================================

CREATE TABLE dispatch.client (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name        text,
    phone_e164       text CHECK (phone_e164 ~ '^\+7[0-9]{10}$'),   -- NULL после обезличивания (P-20)
    messenger        text NOT NULL CHECK (messenger IN ('TELEGRAM', 'WHATSAPP', 'MAX')),
    anonymized_at    timestamptz,
    CHECK ((anonymized_at IS NULL) = (phone_e164 IS NOT NULL))
);

CREATE TABLE dispatch.booking (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source               text NOT NULL CHECK (source IN ('AMOCRM', 'PANEL')),
    external_id          bigint,                   -- id сделки amoCRM
    external_updated_at  timestamptz,              -- updated_at сделки: старое событие не перетирает новое
    client_id            uuid NOT NULL REFERENCES dispatch.client (id),
    route_id             uuid NOT NULL REFERENCES dispatch.route (id),
    starts_at            timestamptz NOT NULL,
    adults               integer NOT NULL DEFAULT 0 CHECK (adults >= 0),
    children             integer NOT NULL DEFAULT 0 CHECK (children >= 0),
    discounted           integer NOT NULL DEFAULT 0 CHECK (discounted >= 0),
    participants         integer GENERATED ALWAYS AS (adults + children + discounted) STORED,
    payment_method       text NOT NULL CHECK (payment_method IN ('CASH', 'TRANSFER')),
    expected_amount      numeric(10, 2) NOT NULL CHECK (expected_amount >= 0),   -- снимок по тарифу (BR-32)
    status               text NOT NULL CHECK (status IN ('ACTIVE', 'CANCELLED', 'COMPLETED')),
    version              integer NOT NULL DEFAULT 1,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_id),
    CHECK ((source = 'AMOCRM') = (external_id IS NOT NULL AND external_updated_at IS NOT NULL)),
    CHECK (adults + children + discounted >= 1)
);

-- =====================================================================
-- Группы
-- =====================================================================

CREATE TABLE dispatch.excursion_group (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      uuid NOT NULL REFERENCES dispatch.booking (id),
    seq             integer NOT NULL CHECK (seq > 0),
    participants    integer NOT NULL CHECK (participants BETWEEN 1 AND 15),   -- P-01, жёсткий предел
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    status          text NOT NULL CHECK (status IN
                        ('SEARCHING', 'ASSIGNED', 'CONFIRMED', 'COMPLETED', 'NOT_HELD', 'CANCELLED')),
    guide_id        uuid REFERENCES dispatch.guide (id),
    busy_range      tstzrange,                     -- время гида с буфером P-02, считается при назначении
    window_ends_at  timestamptz,                   -- D-11: когда закрывается окно откликов
    version         integer NOT NULL DEFAULT 1,
    UNIQUE (booking_id, seq),
    CHECK (ends_at > starts_at),
    CHECK ((status IN ('ASSIGNED', 'CONFIRMED', 'COMPLETED', 'NOT_HELD')) = (guide_id IS NOT NULL)),
    CHECK ((guide_id IS NULL) = (busy_range IS NULL)),
    CHECK (busy_range IS NULL OR (lower(busy_range) = starts_at AND upper(busy_range) >= ends_at)),
    -- BR-07: у гида нет двух групп, которые пересекаются по времени с учётом буфера
    EXCLUDE USING gist (guide_id WITH =, busy_range WITH &&) WHERE (guide_id IS NOT NULL)
);

-- Разрешённые переходы статусов группы (group-states.md)
CREATE TABLE dispatch.group_transition (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    PRIMARY KEY (from_status, to_status)
);
INSERT INTO dispatch.group_transition VALUES
    ('SEARCHING', 'ASSIGNED'), ('SEARCHING', 'CANCELLED'),
    ('ASSIGNED', 'CONFIRMED'), ('ASSIGNED', 'SEARCHING'), ('ASSIGNED', 'COMPLETED'),
    ('ASSIGNED', 'NOT_HELD'), ('ASSIGNED', 'CANCELLED'),
    ('CONFIRMED', 'COMPLETED'), ('CONFIRMED', 'NOT_HELD'), ('CONFIRMED', 'SEARCHING'),
    ('CONFIRMED', 'CANCELLED');

-- NFR-11: история группы — кто, когда, что было и что стало
CREATE TABLE dispatch.group_event (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_id     uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    at           timestamptz NOT NULL DEFAULT now(),
    actor        text NOT NULL DEFAULT COALESCE(current_setting('dispatch.actor', true), 'SYSTEM'),
    from_status  text,
    to_status    text NOT NULL,
    guide_id     uuid
);

CREATE FUNCTION dispatch.guard_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> OLD.status AND NOT EXISTS (
        SELECT 1 FROM dispatch.group_transition WHERE from_status = OLD.status AND to_status = NEW.status) THEN
        RAISE EXCEPTION 'Переход группы % → % запрещён', OLD.status, NEW.status;
    END IF;
    NEW.version := OLD.version + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER group_guard BEFORE UPDATE ON dispatch.excursion_group
    FOR EACH ROW EXECUTE FUNCTION dispatch.guard_group();

CREATE FUNCTION dispatch.log_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status <> OLD.status OR NEW.guide_id IS DISTINCT FROM OLD.guide_id THEN
        INSERT INTO dispatch.group_event (group_id, from_status, to_status, guide_id)
        VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.guide_id);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER group_log AFTER INSERT OR UPDATE ON dispatch.excursion_group
    FOR EACH ROW EXECUTE FUNCTION dispatch.log_group();

-- BR-02: N участников делятся на ⌈N / max⌉ групп, размеры отличаются не больше чем на 1
CREATE FUNCTION dispatch.split_participants(n integer, max_size integer DEFAULT 15)
RETURNS integer[] LANGUAGE sql IMMUTABLE AS $$
    SELECT array_agg(n / k + CASE WHEN i <= n % k THEN 1 ELSE 0 END ORDER BY i)
      FROM (SELECT (n + max_size - 1) / max_size AS k) s,
           generate_series(1, (n + max_size - 1) / max_size) AS i
$$;

-- =====================================================================
-- Предложения и отклики (D-11)
-- =====================================================================

CREATE TABLE dispatch.offer (                  -- что отправили гиду, чтобы потом обновить сообщение
    group_id             uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    guide_id             uuid NOT NULL REFERENCES dispatch.guide (id),
    telegram_message_id  bigint,
    sent_at              timestamptz NOT NULL DEFAULT now(),
    revoked_at           timestamptz,
    PRIMARY KEY (group_id, guide_id)
);

CREATE TABLE dispatch.group_response (         -- нажатие «Хочу взять»; повторное нажатие не создаёт второй отклик
    group_id      uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    guide_id      uuid NOT NULL REFERENCES dispatch.guide (id),
    responded_at  timestamptz NOT NULL DEFAULT now(),
    withdrawn_at  timestamptz,
    PRIMARY KEY (group_id, guide_id)
);

-- Выбор гида при закрытии окна: среди откликнувшихся — с наименьшим числом групп
-- на неделе этой группы (пн–вс по Москве), при равенстве — случайно.
-- Кандидат с пересечением отсеивается исключающим ограничением, берётся следующий.
-- Возвращает выбранного гида или NULL, если назначить некого или группа уже назначена
CREATE FUNCTION dispatch.select_guide(p_group uuid, p_buffer interval DEFAULT interval '30 minutes')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    g dispatch.excursion_group%ROWTYPE;
    cand record;
    week_start timestamptz;
BEGIN
    SELECT * INTO g FROM dispatch.excursion_group WHERE id = p_group FOR UPDATE;
    IF g.status <> 'SEARCHING' THEN RETURN NULL; END IF;     -- например, администратор уже назначил вручную
    week_start := date_trunc('week', g.starts_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow';
    FOR cand IN
        SELECT r.guide_id,
               (SELECT count(*) FROM dispatch.excursion_group x
                 WHERE x.guide_id = r.guide_id AND x.status <> 'CANCELLED'
                   AND x.starts_at >= week_start AND x.starts_at < week_start + interval '7 days') AS week_groups
          FROM dispatch.group_response r
          JOIN dispatch.guide gd ON gd.id = r.guide_id
         WHERE r.group_id = p_group AND r.withdrawn_at IS NULL
           AND gd.status = 'ACTIVE' AND gd.bot_blocked_at IS NULL
         ORDER BY week_groups, random()
    LOOP
        BEGIN
            UPDATE dispatch.excursion_group
               SET status = 'ASSIGNED', guide_id = cand.guide_id,
                   busy_range = tstzrange(starts_at, ends_at + p_buffer, '[)')
             WHERE id = p_group;
            RETURN cand.guide_id;
        EXCEPTION WHEN exclusion_violation THEN
            CONTINUE;                                           -- у этого гида пересечение, пробуем следующего
        END;
    END LOOP;
    RETURN NULL;
END $$;

-- =====================================================================
-- Отписки, уведомления, эскалации
-- =====================================================================

CREATE TABLE dispatch.client_notice (          -- задача администратору «Отправить отписку» (BR-15)
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  uuid NOT NULL REFERENCES dispatch.booking (id),
    kind        text NOT NULL CHECK (kind IN ('NOTICE', 'GUIDE_CHANGED')),
    status      text NOT NULL CHECK (status IN ('PENDING', 'SENT', 'CANCELLED')),
    text        text NOT NULL,
    channel     text CHECK (channel IN ('TELEGRAM', 'WHATSAPP', 'MAX', 'CALL')),  -- фактический канал
    sent_by     uuid REFERENCES dispatch.admin (id),
    sent_at     timestamptz,
    CHECK ((status = 'SENT') = (sent_at IS NOT NULL AND channel IS NOT NULL))
);
CREATE UNIQUE INDEX client_notice_one_pending
    ON dispatch.client_notice (booking_id, kind) WHERE status = 'PENDING';

CREATE TABLE dispatch.notification (           -- сообщения гидам и администраторам в Telegram
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dedup_key            text NOT NULL UNIQUE,  -- например digest:<гид>:<дата>: сводка не уходит дважды
    chat_id              bigint NOT NULL,
    scheduled_at         timestamptz NOT NULL,
    status               text NOT NULL CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'CANCELLED')),
    attempts             integer NOT NULL DEFAULT 0,
    telegram_message_id  bigint,
    last_error           text
);
CREATE INDEX notification_due ON dispatch.notification (scheduled_at) WHERE status = 'QUEUED';

CREATE TABLE dispatch.escalation (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id    uuid REFERENCES dispatch.excursion_group (id),
    booking_id  uuid REFERENCES dispatch.booking (id),
    reason      text NOT NULL CHECK (reason IN
                    ('NO_GUIDE', 'NO_CONFIRMATION', 'REPLACEMENT_REQUESTED', 'NOTICE_NOT_SENT', 'GUIDE_BLOCKED_BOT')),
    status      text NOT NULL CHECK (status IN ('OPEN', 'ACKED', 'RESOLVED')),
    opened_at   timestamptz NOT NULL DEFAULT now(),
    acked_by    uuid REFERENCES dispatch.admin (id),
    resolved_at timestamptz,
    comment     text,
    CHECK (group_id IS NOT NULL OR booking_id IS NOT NULL),
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);
-- BR-27: пока эскалация открыта, вторая с той же причиной по той же группе не создаётся
CREATE UNIQUE INDEX escalation_one_open_per_reason
    ON dispatch.escalation (COALESCE(group_id, booking_id), reason) WHERE status <> 'RESOLVED';

-- =====================================================================
-- Входящие события amoCRM
-- =====================================================================

-- У вебхуков amoCRM нет идентификатора события, поэтому ключ дедупликации — сделка, действие и last_modified
CREATE TABLE dispatch.inbound_event (
    dedup_key     text PRIMARY KEY,            -- amocrm:lead:<id>:<action>:<last_modified>
    received_at   timestamptz NOT NULL DEFAULT now(),
    payload       text NOT NULL,               -- тело как пришло, x-www-form-urlencoded
    processed_at  timestamptz,
    result        text
);

-- Применение сделки из amoCRM: устаревшее состояние не перетирает новое (NFR-04).
-- Возвращает CREATED, UPDATED или STALE
CREATE FUNCTION dispatch.apply_crm_booking(p_external_id bigint, p_updated_at timestamptz,
                                           p_client uuid, p_route uuid, p_starts_at timestamptz,
                                           p_adults int, p_children int, p_discounted int,
                                           p_payment text, p_amount numeric)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE b dispatch.booking%ROWTYPE;
BEGIN
    SELECT * INTO b FROM dispatch.booking WHERE source = 'AMOCRM' AND external_id = p_external_id FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO dispatch.booking (source, external_id, external_updated_at, client_id, route_id, starts_at,
                                      adults, children, discounted, payment_method, expected_amount, status)
        VALUES ('AMOCRM', p_external_id, p_updated_at, p_client, p_route, p_starts_at,
                p_adults, p_children, p_discounted, p_payment, p_amount, 'ACTIVE');
        RETURN 'CREATED';
    END IF;
    IF p_updated_at <= b.external_updated_at THEN RETURN 'STALE'; END IF;
    UPDATE dispatch.booking
       SET external_updated_at = p_updated_at, route_id = p_route, starts_at = p_starts_at,
           adults = p_adults, children = p_children, discounted = p_discounted,
           payment_method = p_payment, expected_amount = p_amount,
           version = version + 1, updated_at = now()
     WHERE id = b.id;
    RETURN 'UPDATED';
END $$;

-- BR-32: ожидаемая сумма по тарифу на дату создания заявки
CREATE FUNCTION dispatch.expected_amount(p_route uuid, p_on date, p_adults int, p_children int, p_discounted int)
RETURNS numeric LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(t.price * CASE t.category WHEN 'ADULT' THEN p_adults
                                                  WHEN 'CHILD' THEN p_children
                                                  ELSE p_discounted END), 0)
      FROM dispatch.tariff t
     WHERE t.route_id = p_route AND t.valid @> p_on
$$;
