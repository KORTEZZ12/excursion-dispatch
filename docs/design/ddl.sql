-- Диспетчер экскурсий: модель данных, версия 0.5
-- PostgreSQL 16. Одна база сервиса, схема dispatch. Описание — data-model.md, проверки — ddl-checks.sql.
-- Функции здесь — исполняемая спецификация правил, в сервисе их можно реализовать кодом с теми же гарантиями.
-- Коды F-xx в комментариях — замечания ревью итерации 2 (docs/reviews/2026-10-27-iteration-2).

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- равенство uuid в исключающих ограничениях
CREATE SCHEMA dispatch;

-- =====================================================================
-- Администраторы, параметры, справочники
-- =====================================================================

CREATE TABLE dispatch.admin (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name         text NOT NULL,
    telegram_user_id  bigint UNIQUE,
    active            boolean NOT NULL DEFAULT true
);

CREATE TABLE dispatch.parameter (            -- NFR-14: параметры P-xx меняет администратор
    code        text PRIMARY KEY CHECK (code ~ '^P-[0-9]{2}$'),
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES dispatch.admin (id)
);

-- NFR-11: кто и когда менял параметр (F-22)
CREATE TABLE dispatch.parameter_event (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code       text NOT NULL REFERENCES dispatch.parameter (code),
    at         timestamptz NOT NULL DEFAULT now(),
    actor      text NOT NULL DEFAULT COALESCE(current_setting('dispatch.actor', true), 'SYSTEM'),
    old_value  text,
    new_value  text NOT NULL
);

CREATE FUNCTION dispatch.log_parameter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value THEN
        INSERT INTO dispatch.parameter_event (code, old_value, new_value)
        VALUES (NEW.code, CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END, NEW.value);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER parameter_log AFTER INSERT OR UPDATE ON dispatch.parameter
    FOR EACH ROW EXECUTE FUNCTION dispatch.log_parameter();

-- Значения по умолчанию — из business-rules.md. Длительности — ISO 8601
INSERT INTO dispatch.parameter (code, value) VALUES
    ('P-01', '15'),          ('P-02', 'PT30M'),       ('P-03', 'PT3H'),        ('P-04', 'PT24H'),
    ('P-05', 'PT30M'),       ('P-06', '19:00'),       ('P-07', 'PT2H'),        ('P-08', 'PT1H'),
    ('P-09', '22:00/07:00'), ('P-10', '12:00'),       ('P-11', '18:00'),       ('P-12', 'PT24H'),
    ('P-13', 'PT2H'),        ('P-14', 'PT24H'),       ('P-15', 'PT15M'),       ('P-16', 'PT15M'),
    ('P-17', 'PT48H'),       ('P-18', 'PT24H'),       ('P-20', 'P90D'),        ('P-21', 'PT10M'),
    ('P-22', 'PT2M'),        ('P-23', 'PT10M'),       ('P-24', 'PT4H'),        ('P-25', 'PT30M'),
    ('P-26', 'PT2H'),        ('P-27', 'P30D');

CREATE FUNCTION dispatch.param_interval(p_code text, p_default interval)
RETURNS interval LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT value::interval FROM dispatch.parameter WHERE code = p_code), p_default)
$$;

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

-- US-25: в каждый момент дежурит не больше одного администратора
CREATE TABLE dispatch.duty_shift (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
    phone_e164              text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    telegram_user_id        bigint UNIQUE,
    telegram_chat_id        bigint,
    status                  text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'DEACTIVATED')),
    phone_share_consent_at  timestamptz,           -- BR-17, BR-28: согласие передавать телефон клиентам
    bot_blocked_at          timestamptz,           -- BR-31: Telegram ответил 403
    CHECK (status = 'PENDING_APPROVAL' OR telegram_user_id IS NOT NULL),
    -- BR-28: без согласия гид не активен; отзыв согласия — деактивация (BR-30)
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
    phone_e164       text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- E.164: туристы бывают не с +7 (F-30)
    messenger        text NOT NULL CHECK (messenger IN ('TELEGRAM', 'WHATSAPP', 'MAX')),
    anonymized_at    timestamptz,
    -- NFR-10, P-20: обезличивание стирает и телефон, и имя (F-23)
    CHECK ((anonymized_at IS NULL) = (phone_e164 IS NOT NULL)),
    CHECK (anonymized_at IS NULL OR full_name IS NULL)
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
    -- Причина отмены: API её принимает, значит, база хранит (F-21)
    cancel_reason        text CHECK (cancel_reason IN
                             ('CLIENT', 'WEATHER', 'GUIDE_ILLNESS', 'CRM_CANCELLED', 'CRM_DELETED', 'OTHER')),
    cancel_comment       text,
    -- BR-04: аварийная отмена в панели при недоступной amoCRM; правку нужно повторить в amoCRM (F-11)
    crm_resync_required  boolean NOT NULL DEFAULT false,
    version              integer NOT NULL DEFAULT 1,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_id),
    CHECK ((source = 'AMOCRM') = (external_id IS NOT NULL AND external_updated_at IS NOT NULL)),
    CHECK (adults + children + discounted >= 1),
    CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
    CHECK (NOT crm_resync_required OR source = 'AMOCRM')
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
                        ('SEARCHING', 'ASSIGNED', 'CONFIRMED', 'COMPLETED', 'NOT_HELD', 'CANCELLED', 'HANDED_OVER')),
    -- Раунд поиска: растёт при каждом возврате в поиск. Отклики и предложения живут в своём раунде (F-12)
    search_round    integer NOT NULL DEFAULT 1 CHECK (search_round > 0),
    window_ends_at  timestamptz,                   -- D-11: конец окна текущего раунда, от последнего отправленного предложения
    guide_id        uuid REFERENCES dispatch.guide (id),
    assignment_id   uuid,                          -- новое при каждой смене гида: ключ подготовки и эскалаций (F-14)
    busy_range      tstzrange,                     -- время гида с буфером P-02, считается при назначении
    confirmed_at    timestamptz,                   -- BR-13: выход подтверждён в текущем назначении
    closed_reason   text CHECK (closed_reason IN ('BOOKING_CANCELLED', 'SURPLUS', 'PARTNER')),
    partner_name    text,                          -- BR-35: кому передали группу
    version         integer NOT NULL DEFAULT 1,
    UNIQUE (booking_id, seq),
    CHECK (ends_at > starts_at),
    CHECK ((status IN ('ASSIGNED', 'CONFIRMED', 'COMPLETED', 'NOT_HELD')) = (guide_id IS NOT NULL)),
    CHECK ((guide_id IS NULL) = (busy_range IS NULL)),
    CHECK ((guide_id IS NULL) = (assignment_id IS NULL)),
    -- Пустой диапазон не пересекается ни с чем и обходил бы BR-07, поэтому запрещён (F-05)
    CHECK (busy_range IS NULL OR (NOT isempty(busy_range)
                                  AND lower(busy_range) = starts_at AND upper(busy_range) >= ends_at)),
    CHECK (status <> 'CONFIRMED' OR confirmed_at IS NOT NULL),
    CHECK (status <> 'ASSIGNED' OR confirmed_at IS NULL),
    -- F-01: исход «Передана партнёру» и причины закрытия
    CHECK ((status IN ('CANCELLED', 'HANDED_OVER')) = (closed_reason IS NOT NULL)),
    CHECK ((status = 'HANDED_OVER') = (closed_reason IS NOT DISTINCT FROM 'PARTNER')),
    CHECK (partner_name IS NULL OR status = 'HANDED_OVER'),
    -- BR-07, BR-09: у гида нет двух групп, которые пересекаются по времени с учётом буфера. Исключений нет (D-13)
    EXCLUDE USING gist (guide_id WITH =, busy_range WITH &&) WHERE (guide_id IS NOT NULL)
);

-- Разрешённые переходы статусов группы (group-states.md)
CREATE TABLE dispatch.group_transition (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    PRIMARY KEY (from_status, to_status)
);
INSERT INTO dispatch.group_transition VALUES
    ('SEARCHING', 'ASSIGNED'), ('SEARCHING', 'CANCELLED'), ('SEARCHING', 'HANDED_OVER'),
    ('ASSIGNED', 'CONFIRMED'), ('ASSIGNED', 'SEARCHING'), ('ASSIGNED', 'COMPLETED'),
    ('ASSIGNED', 'NOT_HELD'), ('ASSIGNED', 'CANCELLED'),
    ('CONFIRMED', 'ASSIGNED'), ('CONFIRMED', 'COMPLETED'), ('CONFIRMED', 'NOT_HELD'),
    ('CONFIRMED', 'SEARCHING'), ('CONFIRMED', 'CANCELLED');

-- NFR-11: история группы — кто, когда, что было и что стало, почему
CREATE TABLE dispatch.group_event (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    group_id       uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    at             timestamptz NOT NULL DEFAULT now(),
    actor          text NOT NULL DEFAULT COALESCE(current_setting('dispatch.actor', true), 'SYSTEM'),
    from_status    text,
    to_status      text NOT NULL,
    from_guide_id  uuid,
    guide_id       uuid,
    assignment_id  uuid,
    reason         text                 -- причина отказа, снятия, отмены (US-14, BR-09); из SET LOCAL dispatch.reason
);

CREATE FUNCTION dispatch.guard_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.guide_id IS NOT NULL AND NEW.assignment_id IS NULL THEN
            NEW.assignment_id := gen_random_uuid();
        END IF;
        IF NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NULL THEN
            NEW.confirmed_at := now();
        END IF;
        RETURN NEW;
    END IF;

    -- Смена гида — новое назначение. Подтверждение прежнего гида к новому не переходит (F-14),
    -- если только тот же запрос явно не подтверждает выход (позднее назначение, BR-13)
    IF NEW.guide_id IS DISTINCT FROM OLD.guide_id THEN
        NEW.assignment_id := CASE WHEN NEW.guide_id IS NULL THEN NULL ELSE gen_random_uuid() END;
        IF OLD.status = 'CONFIRMED' AND NEW.status = 'CONFIRMED'
           AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at THEN
            NEW.status := 'ASSIGNED';
        END IF;
    END IF;
    IF NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NULL THEN
        NEW.confirmed_at := now();
    ELSIF NEW.status IN ('ASSIGNED', 'SEARCHING', 'CANCELLED', 'HANDED_OVER') THEN
        NEW.confirmed_at := NULL;
    END IF;

    -- Возврат в поиск открывает новый раунд: прошлые отклики и предложения в нём не действуют (F-12)
    IF NEW.status = 'SEARCHING' AND OLD.status <> 'SEARCHING' THEN
        NEW.search_round := OLD.search_round + 1;
        NEW.window_ends_at := NULL;
    END IF;

    IF NEW.status <> OLD.status AND NOT EXISTS (
        SELECT 1 FROM dispatch.group_transition WHERE from_status = OLD.status AND to_status = NEW.status) THEN
        RAISE EXCEPTION 'Переход группы % → % запрещён', OLD.status, NEW.status;
    END IF;
    NEW.version := OLD.version + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER group_guard BEFORE INSERT OR UPDATE ON dispatch.excursion_group
    FOR EACH ROW EXECUTE FUNCTION dispatch.guard_group();

CREATE FUNCTION dispatch.log_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status <> OLD.status OR NEW.guide_id IS DISTINCT FROM OLD.guide_id THEN
        INSERT INTO dispatch.group_event (group_id, from_status, to_status, from_guide_id, guide_id, assignment_id, reason)
        VALUES (NEW.id,
                CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
                CASE WHEN TG_OP = 'UPDATE' THEN OLD.guide_id END, NEW.guide_id, NEW.assignment_id,
                NULLIF(current_setting('dispatch.reason', true), ''));
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

CREATE TABLE dispatch.offer (                  -- что отправили гиду в раунде, чтобы потом обновить сообщение
    group_id             uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    search_round         integer NOT NULL,
    guide_id             uuid NOT NULL REFERENCES dispatch.guide (id),
    telegram_message_id  bigint,
    sent_at              timestamptz NOT NULL DEFAULT now(),
    revoked_at           timestamptz,
    PRIMARY KEY (group_id, search_round, guide_id)
);

CREATE TABLE dispatch.group_response (         -- нажатие «Хочу взять» в раунде; повтор не создаёт второй отклик
    group_id      uuid NOT NULL REFERENCES dispatch.excursion_group (id),
    search_round  integer NOT NULL,
    guide_id      uuid NOT NULL REFERENCES dispatch.guide (id),
    responded_at  timestamptz NOT NULL DEFAULT now(),
    withdrawn_at  timestamptz,
    PRIMARY KEY (group_id, search_round, guide_id)
);

-- Выбор гида при закрытии окна (D-17): жребий среди откликнувшихся в текущем раунде.
-- Кандидат с пересечением отсеивается исключающим ограничением, жребий идёт дальше.
-- Возвращает выбранного гида или NULL, если назначить некого или группа уже назначена
CREATE FUNCTION dispatch.select_guide(p_group uuid, p_buffer interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    g dispatch.excursion_group%ROWTYPE;
    cand record;
    buffer interval := COALESCE(p_buffer, dispatch.param_interval('P-02', interval '30 minutes'));
BEGIN
    SELECT * INTO g FROM dispatch.excursion_group WHERE id = p_group FOR UPDATE;
    IF g.status <> 'SEARCHING' THEN RETURN NULL; END IF;     -- например, администратор уже назначил вручную
    FOR cand IN
        SELECT r.guide_id
          FROM dispatch.group_response r
          JOIN dispatch.guide gd ON gd.id = r.guide_id
         WHERE r.group_id = p_group AND r.search_round = g.search_round AND r.withdrawn_at IS NULL
           AND gd.status = 'ACTIVE' AND gd.bot_blocked_at IS NULL
         ORDER BY random()                                      -- жребий: порядок нажатий не важен
    LOOP
        BEGIN
            UPDATE dispatch.excursion_group
               SET status = 'ASSIGNED', guide_id = cand.guide_id,
                   busy_range = tstzrange(starts_at, ends_at + buffer, '[)')
             WHERE id = p_group;
            RETURN cand.guide_id;
        EXCEPTION WHEN exclusion_violation THEN
            CONTINUE;                                           -- у этого гида пересечение, жребий идёт дальше
        END;
    END LOOP;
    RETURN NULL;
END $$;

-- BR-06: нажатие «Хочу взять» из предложения или из «Свободных групп» (F-03).
-- Ответы: CANDIDATE — гид в числе кандидатов; ASSIGNED — группа его; TAKEN — группу получил другой гид;
-- CANCELLED — группа отменена или передана партнёру; STALE_ROUND — кнопка из прошлого раунда;
-- OVERLAP — у гида пересечение; NOT_ACTIVE — гид не активен или заблокировал бота
CREATE FUNCTION dispatch.respond(p_group uuid, p_round integer, p_guide uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    g  dispatch.excursion_group%ROWTYPE;
    gd dispatch.guide%ROWTYPE;
    buffer interval := dispatch.param_interval('P-02', interval '30 minutes');
BEGIN
    SELECT * INTO g FROM dispatch.excursion_group WHERE id = p_group FOR UPDATE;
    IF g.status IN ('CANCELLED', 'HANDED_OVER') THEN RETURN 'CANCELLED'; END IF;
    IF g.status <> 'SEARCHING' THEN
        RETURN CASE WHEN g.guide_id = p_guide THEN 'ASSIGNED' ELSE 'TAKEN' END;  -- повтор своего нажатия — тот же ответ
    END IF;
    IF p_round <> g.search_round THEN RETURN 'STALE_ROUND'; END IF;

    SELECT * INTO gd FROM dispatch.guide WHERE id = p_guide;
    IF NOT FOUND OR gd.status <> 'ACTIVE' OR gd.bot_blocked_at IS NOT NULL THEN RETURN 'NOT_ACTIVE'; END IF;
    IF EXISTS (SELECT 1 FROM dispatch.excursion_group x
                WHERE x.guide_id = p_guide AND x.busy_range && tstzrange(g.starts_at, g.ends_at + buffer, '[)')) THEN
        RETURN 'OVERLAP';
    END IF;

    -- До рассылки и пока окно открыто — отклик. Повторный отклик после отзыва снова делает кандидатом (F-13)
    IF g.window_ends_at IS NULL OR now() < g.window_ends_at THEN
        INSERT INTO dispatch.group_response (group_id, search_round, guide_id)
        VALUES (p_group, p_round, p_guide)
        ON CONFLICT (group_id, search_round, guide_id) DO UPDATE SET withdrawn_at = NULL;
        RETURN 'CANDIDATE';
    END IF;

    -- Окно закрылось. Если выбор по окну ещё не выполнен, сначала он: кандидаты окна важнее нажавшего после
    IF dispatch.select_guide(p_group, buffer) IS NOT NULL THEN
        RETURN CASE WHEN (SELECT guide_id FROM dispatch.excursion_group WHERE id = p_group) = p_guide
                    THEN 'ASSIGNED' ELSE 'TAKEN' END;
    END IF;
    -- Пустое окно: группу получает первый нажавший
    UPDATE dispatch.excursion_group
       SET status = 'ASSIGNED', guide_id = p_guide, busy_range = tstzrange(starts_at, ends_at + buffer, '[)')
     WHERE id = p_group;
    RETURN 'ASSIGNED';
EXCEPTION WHEN exclusion_violation THEN
    RETURN 'OVERLAP';
END $$;

-- =====================================================================
-- Отписки, уведомления, эскалации
-- =====================================================================

CREATE TABLE dispatch.client_notice (          -- задача администратору «Отправить отписку» (BR-15)
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  uuid NOT NULL REFERENCES dispatch.booking (id),
    kind        text NOT NULL CHECK (kind IN ('NOTICE', 'GUIDE_CHANGED')),
    status      text NOT NULL CHECK (status IN ('PENDING', 'SENT', 'CANCELLED')),
    due_at      timestamptz NOT NULL,           -- BR-16: P-11 накануне или, для заявки день в день, за P-26 до начала
    -- Текст до отправки не хранится: его собирают из актуальных данных при каждом показе.
    -- В момент «Отправлено» фиксируется то, что ушло клиенту (F-16)
    sent_text   text,
    channel     text CHECK (channel IN ('TELEGRAM', 'WHATSAPP', 'MAX', 'CALL')),  -- фактический канал
    sent_by     uuid REFERENCES dispatch.admin (id),
    sent_at     timestamptz,
    CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
    CHECK (status <> 'SENT' OR (channel IS NOT NULL AND sent_text IS NOT NULL))
);
CREATE UNIQUE INDEX client_notice_one_pending
    ON dispatch.client_notice (booking_id, kind) WHERE status = 'PENDING';

CREATE TABLE dispatch.notification (           -- сообщения гидам и администраторам в Telegram (outbox)
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dedup_key            text NOT NULL UNIQUE,  -- например digest:<гид>:<дата>: сводка не уходит дважды
    chat_id              bigint NOT NULL,
    scheduled_at         timestamptz NOT NULL,
    -- NFR-08: срок годности. Просроченное не отправляется: предложение после окна, сводка ночью (F-19)
    expires_at           timestamptz NOT NULL,
    status               text NOT NULL CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'EXPIRED', 'CANCELLED')),
    attempts             integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),   -- NFR-08: не больше 5 попыток
    telegram_message_id  bigint,
    last_error           text,
    CHECK (expires_at > scheduled_at)
);
CREATE INDEX notification_due ON dispatch.notification (scheduled_at) WHERE status = 'QUEUED';

CREATE TABLE dispatch.escalation (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id       uuid REFERENCES dispatch.excursion_group (id),
    assignment_id  uuid,                    -- назначение, о котором сигнал: замена гида даёт новое назначение (F-15)
    booking_id     uuid REFERENCES dispatch.booking (id),
    reason         text NOT NULL CHECK (reason IN
                       ('NO_GUIDE', 'NO_CONFIRMATION', 'REPLACEMENT_REQUESTED', 'NOTICE_NOT_SENT', 'GUIDE_BLOCKED_BOT')),
    status         text NOT NULL CHECK (status IN ('OPEN', 'ACKED', 'RESOLVED')),
    opened_at      timestamptz NOT NULL DEFAULT now(),
    acked_by       uuid REFERENCES dispatch.admin (id),
    acked_at       timestamptz,             -- BR-25: проверяем, уложился ли дежурный в P-16 (F-22)
    resolved_by    uuid REFERENCES dispatch.admin (id),   -- NULL — закрылась сама, причина устранена (BR-26)
    resolved_at    timestamptz,
    comment        text,
    -- NOTICE_NOT_SENT — про заявку, остальные — про группу (F-17)
    CHECK ((reason = 'NOTICE_NOT_SENT') = (booking_id IS NOT NULL AND group_id IS NULL)),
    CHECK (reason = 'NOTICE_NOT_SENT' OR group_id IS NOT NULL),
    CHECK ((reason IN ('NO_CONFIRMATION', 'REPLACEMENT_REQUESTED', 'GUIDE_BLOCKED_BOT')) = (assignment_id IS NOT NULL)),
    CHECK ((acked_by IS NULL) = (acked_at IS NULL)),
    CHECK (status <> 'ACKED' OR acked_at IS NOT NULL),
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
    CHECK (resolved_by IS NULL OR (status = 'RESOLVED' AND comment IS NOT NULL))   -- BR-26: вручную — с комментарием
);
-- BR-27: пока эскалация открыта, вторая с той же причиной по тому же назначению, группе или заявке не создаётся
CREATE UNIQUE INDEX escalation_one_open_per_reason
    ON dispatch.escalation (COALESCE(assignment_id, group_id, booking_id), reason) WHERE status <> 'RESOLVED';

-- NFR-11: история эскалации (F-22)
CREATE TABLE dispatch.escalation_event (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    escalation_id  uuid NOT NULL REFERENCES dispatch.escalation (id),
    at             timestamptz NOT NULL DEFAULT now(),
    actor          text NOT NULL DEFAULT COALESCE(current_setting('dispatch.actor', true), 'SYSTEM'),
    from_status    text,
    to_status      text NOT NULL
);

CREATE FUNCTION dispatch.log_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status <> OLD.status THEN
        INSERT INTO dispatch.escalation_event (escalation_id, from_status, to_status)
        VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER escalation_log AFTER INSERT OR UPDATE ON dispatch.escalation
    FOR EACH ROW EXECUTE FUNCTION dispatch.log_escalation();

-- =====================================================================
-- Входящие события amoCRM
-- =====================================================================

-- У вебхуков amoCRM нет идентификатора события, поэтому ключ дедупликации — сделка, действие и last_modified
CREATE TABLE dispatch.inbound_event (
    dedup_key     text PRIMARY KEY,            -- amocrm:lead:<id>:<action>:<last_modified>
    received_at   timestamptz NOT NULL DEFAULT now(),
    payload       text,                        -- тело как пришло; стирается через P-27 после обработки (NFR-10, F-23)
    processed_at  timestamptz,
    result        text,
    CHECK (payload IS NOT NULL OR processed_at IS NOT NULL)
);

-- Применение сделки из amoCRM (NFR-04). События одной сделки обрабатываются строго по очереди,
-- данные каждый раз берутся из API (ADR-001). Поэтому при равном updated_at более поздний ответ API
-- не старее сохранённого: равное время с другими данными — применяем (F-18).
-- Возвращает CREATED, UPDATED, UNCHANGED или STALE
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
    IF p_updated_at < b.external_updated_at THEN RETURN 'STALE'; END IF;
    IF p_updated_at = b.external_updated_at
       AND (b.client_id, b.route_id, b.starts_at, b.adults, b.children, b.discounted, b.payment_method, b.expected_amount)
           IS NOT DISTINCT FROM (p_client, p_route, p_starts_at, p_adults, p_children, p_discounted, p_payment, p_amount) THEN
        RETURN 'UNCHANGED';
    END IF;
    UPDATE dispatch.booking
       SET external_updated_at = p_updated_at, client_id = p_client, route_id = p_route, starts_at = p_starts_at,
           adults = p_adults, children = p_children, discounted = p_discounted,
           payment_method = p_payment, expected_amount = p_amount,
           version = version + 1, updated_at = now()
     WHERE id = b.id;
    RETURN 'UPDATED';
END $$;

-- BR-32: ожидаемая сумма по тарифу на дату создания заявки.
-- Нет тарифа для категории, в которой есть участники, — NULL: заявка уходит в «Требует внимания» (F-31)
CREATE FUNCTION dispatch.expected_amount(p_route uuid, p_on date, p_adults int, p_children int, p_discounted int)
RETURNS numeric LANGUAGE sql STABLE AS $$
    WITH need(category, qty) AS (VALUES ('ADULT', p_adults), ('CHILD', p_children), ('DISCOUNTED', p_discounted))
    SELECT CASE WHEN count(*) FILTER (WHERE n.qty > 0 AND t.price IS NULL) > 0 THEN NULL
                ELSE COALESCE(sum(t.price * n.qty), 0) END
      FROM need n
      LEFT JOIN dispatch.tariff t ON t.route_id = p_route AND t.category = n.category AND t.valid @> p_on
$$;
