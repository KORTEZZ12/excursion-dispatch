-- Проверка, что ограничения и функции из ddl.sql держат бизнес-правила.
-- Запуск на чистой базе: psql -v ON_ERROR_STOP=1 -f ddl.sql -f ddl-checks.sql

\set QUIET on
SET client_min_messages = notice;
SET TIME ZONE 'Europe/Moscow';

INSERT INTO dispatch.route (id, name, duration, meeting_point, meeting_point_map_url) VALUES
 ('00000000-0000-0000-0000-0000000000e1', 'Обзорная по Иннополису', interval '90 minutes',
  'Место сбора маршрута', 'https://yandex.ru/maps/?pt=48.75,55.75');
INSERT INTO dispatch.admin (id, full_name) VALUES ('00000000-0000-0000-0000-0000000000ad', 'Администратор 1');
INSERT INTO dispatch.guide (id, full_name, phone_e164, telegram_user_id, status, phone_share_consent_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'Гид А', '+79990000001', 1001, 'ACTIVE', now()),
 ('00000000-0000-0000-0000-0000000000b2', 'Гид Б', '+79990000002', 1002, 'ACTIVE', now()),
 ('00000000-0000-0000-0000-0000000000c3', 'Гид В', '+79990000003', 1003, 'ACTIVE', now());
INSERT INTO dispatch.client (id, full_name, phone_e164, messenger) VALUES
 ('00000000-0000-0000-0000-0000000000cc', 'Клиент', '+79991112233', 'TELEGRAM');
INSERT INTO dispatch.booking (id, source, client_id, route_id, starts_at, adults, payment_method, expected_amount, status) VALUES
 ('00000000-0000-0000-0000-0000000000bb', 'PANEL', '00000000-0000-0000-0000-0000000000cc',
  '00000000-0000-0000-0000-0000000000e1', '2026-10-24 11:00+03', 40, 'CASH', 40000, 'ACTIVE');

-- BR-02: 40 человек делятся на 14, 13, 13; 20 — на 10 и 10; 15 — одна группа
DO $$ BEGIN
  ASSERT dispatch.split_participants(40) = ARRAY[14, 13, 13];
  ASSERT dispatch.split_participants(20) = ARRAY[10, 10];
  ASSERT dispatch.split_participants(15) = ARRAY[15];
  RAISE NOTICE 'ok  BR-02 большая заявка делится поровну';
END $$;

-- Ещё две группы гида Б в начале недели, чтобы у него было больше групп, чем у А
INSERT INTO dispatch.booking (id, source, client_id, route_id, starts_at, adults, payment_method, expected_amount, status) VALUES
 ('00000000-0000-0000-0000-0000000000b3', 'PANEL', '00000000-0000-0000-0000-0000000000cc',
  '00000000-0000-0000-0000-0000000000e1', '2026-10-20 11:00+03', 20, 'CASH', 20000, 'ACTIVE');
INSERT INTO dispatch.excursion_group (id, booking_id, seq, participants, starts_at, ends_at, status, guide_id, busy_range) VALUES
 ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b3', 1, 10,
  '2026-10-20 11:00+03', '2026-10-20 12:30+03', 'SEARCHING', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 2, 10,
  '2026-10-21 11:00+03', '2026-10-21 12:30+03', 'SEARCHING', NULL, NULL);
UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000b2',
       busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
 WHERE booking_id = '00000000-0000-0000-0000-0000000000b3';

-- Три группы большой заявки на субботу
INSERT INTO dispatch.excursion_group (id, booking_id, seq, participants, starts_at, ends_at, status)
SELECT ('00000000-0000-0000-0000-00000000000' || s)::uuid, '00000000-0000-0000-0000-0000000000bb', s, n,
       '2026-10-24 11:00+03', '2026-10-24 12:30+03', 'SEARCHING'
  FROM unnest(dispatch.split_participants(40)) WITH ORDINALITY AS t(n, s);

-- BR-07: у гида не может быть двух групп с пересечением, включая буфер 30 минут
DO $$ BEGIN
  UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000a1',
         busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
   WHERE id = '00000000-0000-0000-0000-000000000001';
  BEGIN
    UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000a1',
           busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
     WHERE id = '00000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'гиду назначены две группы в одно время';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'ok  BR-07 две пересекающиеся группы одному гиду не назначаются';
  END;
END $$;

-- D-11: откликнулись А и Б. У А меньше групп на неделе (1 против 2), но он уже ведёт группу 1 в это время.
-- А отсеивается пересечением, группа достаётся Б
DO $$
DECLARE chosen uuid;
BEGIN
  INSERT INTO dispatch.group_response (group_id, guide_id) VALUES
   ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1'),
   ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2');
  chosen := dispatch.select_guide('00000000-0000-0000-0000-000000000002');
  ASSERT chosen = '00000000-0000-0000-0000-0000000000b2', 'должен быть выбран гид без пересечения';
  RAISE NOTICE 'ok  D-11 кандидат с пересечением отсеивается, группа у свободного гида';
END $$;

-- D-11: повторное нажатие «Хочу взять» не создаёт второй отклик
DO $$ BEGIN
  INSERT INTO dispatch.group_response (group_id, guide_id)
  VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c3')
  ON CONFLICT DO NOTHING;
  INSERT INTO dispatch.group_response (group_id, guide_id)
  VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c3')
  ON CONFLICT DO NOTHING;
  ASSERT (SELECT count(*) FROM dispatch.group_response WHERE group_id = '00000000-0000-0000-0000-000000000003') = 1;
  RAISE NOTICE 'ok  повторное нажатие не создаёт второй отклик';
END $$;

-- D-11: из двух свободных гидов группа достаётся тому, у кого меньше групп на этой неделе.
-- У Б на неделе уже три группы, у В — ни одной
DO $$
DECLARE chosen uuid;
BEGIN
  INSERT INTO dispatch.group_response (group_id, guide_id)
  VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b2');
  -- Б занят в 11:00 группой 2, поэтому сдвигаем группу 3 на вечер, чтобы пересечения не было ни у кого
  UPDATE dispatch.excursion_group SET starts_at = '2026-10-24 17:00+03', ends_at = '2026-10-24 18:30+03'
   WHERE id = '00000000-0000-0000-0000-000000000003';
  chosen := dispatch.select_guide('00000000-0000-0000-0000-000000000003');
  ASSERT chosen = '00000000-0000-0000-0000-0000000000c3', 'должен быть выбран гид с меньшим числом групп';
  RAISE NOTICE 'ok  D-11 выбор по наименьшему числу групп на неделе';
END $$;

-- D-11: если группу уже назначили (например, администратор вручную во время окна), выбор ничего не делает
DO $$ BEGIN
  ASSERT dispatch.select_guide('00000000-0000-0000-0000-000000000003') IS NULL;
  ASSERT (SELECT guide_id FROM dispatch.excursion_group WHERE id = '00000000-0000-0000-0000-000000000003')
         = '00000000-0000-0000-0000-0000000000c3';
  RAISE NOTICE 'ok  D-11 уже назначенная группа повторно не разыгрывается: так же отработает ручное назначение во время окна';
END $$;

-- Статусная модель и NFR-11: запрещённый переход — ошибка, каждое изменение — в истории
DO $$ BEGIN
  UPDATE dispatch.excursion_group SET status = 'CONFIRMED' WHERE id = '00000000-0000-0000-0000-000000000001';
  UPDATE dispatch.excursion_group SET status = 'COMPLETED' WHERE id = '00000000-0000-0000-0000-000000000001';
  BEGIN
    UPDATE dispatch.excursion_group SET status = 'SEARCHING', guide_id = NULL, busy_range = NULL
     WHERE id = '00000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'проведённая группа вернулась в поиск';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'проведённая%' THEN RAISE; END IF;
  END;
  ASSERT (SELECT array_agg(to_status ORDER BY id) FROM dispatch.group_event
           WHERE group_id = '00000000-0000-0000-0000-000000000001')
         = ARRAY['SEARCHING', 'ASSIGNED', 'CONFIRMED', 'COMPLETED'];
  RAISE NOTICE 'ok  финальный статус не меняется, история записана полностью';
END $$;

-- BR-27: пока эскалация открыта, вторую с той же причиной не создать; после закрытия — можно
DO $$ BEGIN
  INSERT INTO dispatch.escalation (group_id, reason, status)
  VALUES ('00000000-0000-0000-0000-000000000002', 'NO_CONFIRMATION', 'OPEN');
  BEGIN
    INSERT INTO dispatch.escalation (group_id, reason, status)
    VALUES ('00000000-0000-0000-0000-000000000002', 'NO_CONFIRMATION', 'OPEN');
    RAISE EXCEPTION 'создана вторая открытая эскалация';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE dispatch.escalation SET status = 'RESOLVED', resolved_at = now()
   WHERE group_id = '00000000-0000-0000-0000-000000000002';
  INSERT INTO dispatch.escalation (group_id, reason, status)
  VALUES ('00000000-0000-0000-0000-000000000002', 'NO_CONFIRMATION', 'OPEN');
  RAISE NOTICE 'ok  BR-27 одна открытая эскалация на причину';
END $$;

-- US-08: повторный запуск планировщика не ставит вторую сводку тому же гиду на ту же дату
DO $$ BEGIN
  INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, status)
  VALUES ('digest:00000000-0000-0000-0000-0000000000a1:2026-10-24', 1001, '2026-10-23 19:00+03', 'QUEUED')
  ON CONFLICT (dedup_key) DO NOTHING;
  INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, status)
  VALUES ('digest:00000000-0000-0000-0000-0000000000a1:2026-10-24', 1001, '2026-10-23 19:00+03', 'QUEUED')
  ON CONFLICT (dedup_key) DO NOTHING;
  ASSERT (SELECT count(*) FROM dispatch.notification WHERE dedup_key LIKE 'digest:%') = 1;
  RAISE NOTICE 'ok  US-08 сводка не уходит дважды';
END $$;

-- NFR-04: событие amoCRM с более старым updated_at не перетирает новое
DO $$ BEGIN
  ASSERT dispatch.apply_crm_booking(7551167, '2026-10-19 10:05+03', '00000000-0000-0000-0000-0000000000cc',
         '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 12, 0, 0, 'CASH', 12000) = 'CREATED';
  ASSERT dispatch.apply_crm_booking(7551167, '2026-10-19 10:20+03', '00000000-0000-0000-0000-0000000000cc',
         '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 14, 0, 0, 'CASH', 14000) = 'UPDATED';
  ASSERT dispatch.apply_crm_booking(7551167, '2026-10-19 10:10+03', '00000000-0000-0000-0000-0000000000cc',
         '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 12, 0, 0, 'CASH', 12000) = 'STALE';
  ASSERT (SELECT participants FROM dispatch.booking WHERE external_id = 7551167) = 14;
  RAISE NOTICE 'ok  NFR-04 устаревшее событие amoCRM не применяется';
END $$;

-- BR-32: тарифы без пересечения периодов; ожидаемая сумма 2 взрослых и 1 ребёнка — 2 500 ₽
DO $$ BEGIN
  INSERT INTO dispatch.tariff (route_id, category, price, valid) VALUES
   ('00000000-0000-0000-0000-0000000000e1', 'ADULT', 1000, daterange('2026-01-01', NULL)),
   ('00000000-0000-0000-0000-0000000000e1', 'CHILD', 500, daterange('2026-01-01', NULL)),
   ('00000000-0000-0000-0000-0000000000e1', 'DISCOUNTED', 700, daterange('2026-01-01', NULL));
  ASSERT dispatch.expected_amount('00000000-0000-0000-0000-0000000000e1', DATE '2026-10-19', 2, 1, 0) = 2500;
  BEGIN
    INSERT INTO dispatch.tariff (route_id, category, price, valid)
    VALUES ('00000000-0000-0000-0000-0000000000e1', 'ADULT', 1200, daterange('2026-06-01', NULL));
    RAISE EXCEPTION 'два действующих тарифа одной категории';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  BR-32 тариф на дату однозначен, сумма считается';
END $$;

-- US-25: дежурства не пересекаются
DO $$ BEGIN
  INSERT INTO dispatch.duty_shift VALUES ('00000000-0000-0000-0000-0000000000ad', tstzrange('2026-10-24 09:00+03', '2026-10-24 18:00+03'));
  BEGIN
    INSERT INTO dispatch.duty_shift VALUES ('00000000-0000-0000-0000-0000000000ad', tstzrange('2026-10-24 17:00+03', '2026-10-24 22:00+03'));
    RAISE EXCEPTION 'два дежурства в одно время';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  US-25 в каждый момент один дежурный';
END $$;

-- BR-28: токен приглашения проходит ограничения deep link Telegram
DO $$ BEGIN
  INSERT INTO dispatch.guide_invitation (token, created_by, expires_at)
  VALUES ('inv_Qx7Kp2Lm9Rt4Vw8Z', '00000000-0000-0000-0000-0000000000ad', now() + interval '48 hours');
  BEGIN
    INSERT INTO dispatch.guide_invitation (token, created_by, expires_at)
    VALUES ('приглашение с пробелами', '00000000-0000-0000-0000-0000000000ad', now());
    RAISE EXCEPTION 'принят токен, который Telegram не передаст';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  BR-28 токен приглашения годится для deep link';
END $$;

\echo 'Все проверки пройдены'
