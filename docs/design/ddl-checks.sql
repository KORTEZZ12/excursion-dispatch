-- Проверка, что ограничения и функции из ddl.sql держат бизнес-правила. Версия 0.5.
-- Запуск на чистой базе: psql -v ON_ERROR_STOP=1 -f ddl.sql -f ddl-checks.sql
-- Проверки с кодом F-xx закрывают замечания ревью итерации 2 (docs/reviews/2026-10-27-iteration-2).

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
 ('00000000-0000-0000-0000-0000000000c3', 'Гид В', '+79990000003', 1003, 'ACTIVE', now()),
 ('00000000-0000-0000-0000-0000000000d4', 'Гид Г', '+79990000004', 1004, 'ACTIVE', now()),
 ('00000000-0000-0000-0000-0000000000e5', 'Гид Д', '+79990000005', 1005, 'ACTIVE', now());
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

-- BR-07, BR-09 (D-13): у гида не может быть двух групп с пересечением, включая буфер, и ручное назначение не исключение
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
    RAISE NOTICE 'ok  BR-07 две пересекающиеся группы одному гиду не назначаются, вручную тоже';
  END;
END $$;

-- F-05: пустой диапазон занятости не обходит BR-07
DO $$ BEGIN
  UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000a1',
         busy_range = tstzrange(starts_at, starts_at)
   WHERE id = '00000000-0000-0000-0000-000000000002';
  RAISE EXCEPTION 'пустой busy_range принят';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  F-05 пустой диапазон занятости отклонён';
END $$;

-- D-17: откликнулись А и Б, но А уже ведёт группу 1 в это время.
-- Какой бы порядок ни выпал по жребию, А отсеивается пересечением, группа достаётся Б
DO $$
DECLARE chosen uuid;
BEGIN
  INSERT INTO dispatch.group_response (group_id, search_round, guide_id) VALUES
   ('00000000-0000-0000-0000-000000000002', 1, '00000000-0000-0000-0000-0000000000a1'),
   ('00000000-0000-0000-0000-000000000002', 1, '00000000-0000-0000-0000-0000000000b2');
  chosen := dispatch.select_guide('00000000-0000-0000-0000-000000000002');
  ASSERT chosen = '00000000-0000-0000-0000-0000000000b2', 'должен быть выбран гид без пересечения';
  RAISE NOTICE 'ok  D-11 кандидат с пересечением отсеивается, группа у свободного гида';
END $$;

-- D-11: повторное нажатие «Хочу взять» не создаёт второй отклик
DO $$ BEGIN
  ASSERT dispatch.respond('00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-0000000000c3') = 'CANDIDATE';
  ASSERT dispatch.respond('00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-0000000000c3') = 'CANDIDATE';
  ASSERT (SELECT count(*) FROM dispatch.group_response WHERE group_id = '00000000-0000-0000-0000-000000000003') = 1;
  RAISE NOTICE 'ok  повторное нажатие не создаёт второй отклик';
END $$;

-- D-17: из двух свободных гидов группа достаётся случайному. За 200 розыгрышей выпадают оба.
-- Каждый розыгрыш откатывается, чтобы не открывать новый раунд
DO $$
DECLARE chosen uuid; got_b int := 0; got_c int := 0;
BEGIN
  INSERT INTO dispatch.group_response (group_id, search_round, guide_id)
  VALUES ('00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-0000000000b2');
  -- Б занят в 11:00 группой 2, поэтому сдвигаем группу 3 на вечер, чтобы пересечения не было ни у кого
  UPDATE dispatch.excursion_group SET starts_at = '2026-10-24 17:00+03', ends_at = '2026-10-24 18:30+03'
   WHERE id = '00000000-0000-0000-0000-000000000003';
  FOR i IN 1..200 LOOP
    BEGIN
      chosen := dispatch.select_guide('00000000-0000-0000-0000-000000000003');
      RAISE EXCEPTION 'откат розыгрыша';
    EXCEPTION WHEN raise_exception THEN
      IF chosen = '00000000-0000-0000-0000-0000000000b2' THEN got_b := got_b + 1; END IF;
      IF chosen = '00000000-0000-0000-0000-0000000000c3' THEN got_c := got_c + 1; END IF;
    END;
  END LOOP;
  ASSERT got_b + got_c = 200, 'в каждом розыгрыше назначен один из откликнувшихся';
  ASSERT got_b > 0 AND got_c > 0, 'жребий должен давать шанс обоим';
  chosen := dispatch.select_guide('00000000-0000-0000-0000-000000000003');
  ASSERT chosen IN ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c3');
  RAISE NOTICE 'ok  D-17 выбор по окну — жребий среди откликнувшихся';
END $$;

-- D-11: если группу уже назначили (например, администратор вручную во время окна), выбор ничего не делает
DO $$
DECLARE before uuid := (SELECT guide_id FROM dispatch.excursion_group WHERE id = '00000000-0000-0000-0000-000000000003');
BEGIN
  ASSERT dispatch.select_guide('00000000-0000-0000-0000-000000000003') IS NULL;
  ASSERT (SELECT guide_id FROM dispatch.excursion_group WHERE id = '00000000-0000-0000-0000-000000000003') = before;
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

-- BR-27: пока эскалация открыта, вторую с той же причиной по тому же назначению не создать; после закрытия — можно
DO $$
DECLARE a uuid := (SELECT assignment_id FROM dispatch.excursion_group WHERE id = '00000000-0000-0000-0000-000000000002');
BEGIN
  INSERT INTO dispatch.escalation (group_id, assignment_id, reason, status)
  VALUES ('00000000-0000-0000-0000-000000000002', a, 'NO_CONFIRMATION', 'OPEN');
  BEGIN
    INSERT INTO dispatch.escalation (group_id, assignment_id, reason, status)
    VALUES ('00000000-0000-0000-0000-000000000002', a, 'NO_CONFIRMATION', 'OPEN');
    RAISE EXCEPTION 'создана вторая открытая эскалация';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE dispatch.escalation SET status = 'RESOLVED', resolved_at = now()
   WHERE group_id = '00000000-0000-0000-0000-000000000002';
  INSERT INTO dispatch.escalation (group_id, assignment_id, reason, status)
  VALUES ('00000000-0000-0000-0000-000000000002', a, 'NO_CONFIRMATION', 'OPEN');
  RAISE NOTICE 'ok  BR-27 одна открытая эскалация на причину';
END $$;

-- US-08: повторный запуск планировщика не ставит вторую сводку тому же гиду на ту же дату
DO $$ BEGIN
  INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, expires_at, status)
  VALUES ('digest:00000000-0000-0000-0000-0000000000a1:2026-10-24', 1001, '2026-10-23 19:00+03', '2026-10-23 22:00+03', 'QUEUED')
  ON CONFLICT (dedup_key) DO NOTHING;
  INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, expires_at, status)
  VALUES ('digest:00000000-0000-0000-0000-0000000000a1:2026-10-24', 1001, '2026-10-23 19:00+03', '2026-10-23 22:00+03', 'QUEUED')
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

-- F-18: вторая правка в ту же секунду применяется, повтор без изменений — нет
DO $$ BEGIN
  ASSERT dispatch.apply_crm_booking(7551167, '2026-10-19 10:20+03', '00000000-0000-0000-0000-0000000000cc',
         '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 18, 0, 0, 'CASH', 18000) = 'UPDATED';
  ASSERT dispatch.apply_crm_booking(7551167, '2026-10-19 10:20+03', '00000000-0000-0000-0000-0000000000cc',
         '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 18, 0, 0, 'CASH', 18000) = 'UNCHANGED';
  ASSERT (SELECT participants FROM dispatch.booking WHERE external_id = 7551167) = 18;
  RAISE NOTICE 'ok  F-18 правка той же секунды не теряется';
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

-- F-31: нет тарифа на дату — суммы нет, а не 0
DO $$ BEGIN
  ASSERT dispatch.expected_amount('00000000-0000-0000-0000-0000000000e1', DATE '2025-12-31', 2, 0, 0) IS NULL;
  RAISE NOTICE 'ok  F-31 без тарифа сумма не подставляется нулём';
END $$;

-- US-25: дежурства не пересекаются
DO $$ BEGIN
  INSERT INTO dispatch.duty_shift (admin_id, during)
  VALUES ('00000000-0000-0000-0000-0000000000ad', tstzrange('2026-10-24 09:00+03', '2026-10-24 18:00+03'));
  BEGIN
    INSERT INTO dispatch.duty_shift (admin_id, during)
    VALUES ('00000000-0000-0000-0000-0000000000ad', tstzrange('2026-10-24 17:00+03', '2026-10-24 22:00+03'));
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

-- =====================================================================
-- Раунды поиска и отклики (D-11, BR-06): замечания F-03, F-12, F-13
-- =====================================================================

INSERT INTO dispatch.booking (id, source, client_id, route_id, starts_at, adults, payment_method, expected_amount, status)
SELECT ('00000000-0000-0000-0000-0000000001' || lpad(d::text, 2, '0'))::uuid, 'PANEL', '00000000-0000-0000-0000-0000000000cc',
       '00000000-0000-0000-0000-0000000000e1', ('2026-11-' || lpad(d::text, 2, '0') || ' 11:00+03')::timestamptz,
       8, 'CASH', 8000, 'ACTIVE'
  FROM generate_series(3, 11) AS d;
INSERT INTO dispatch.excursion_group (id, booking_id, seq, participants, starts_at, ends_at, status)
SELECT ('00000000-0000-0000-0000-0000000002' || lpad(d::text, 2, '0'))::uuid,
       ('00000000-0000-0000-0000-0000000001' || lpad(d::text, 2, '0'))::uuid, 1, 8,
       ('2026-11-' || lpad(d::text, 2, '0') || ' 11:00+03')::timestamptz,
       ('2026-11-' || lpad(d::text, 2, '0') || ' 12:30+03')::timestamptz, 'SEARCHING'
  FROM generate_series(3, 11) AS d;
-- У Д уже есть группа на неделе 2–8 ноября: 4 ноября
UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000e5',
       busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
 WHERE id = '00000000-0000-0000-0000-000000000204';

-- F-12: гид получил группу и отказался. Новый раунд: предложение тем же гидам снова уходит,
-- отклик прошлого раунда не действует, группа не возвращается отказавшемуся сама. Причина отказа — в истории (F-21)
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000203';
BEGIN
  INSERT INTO dispatch.offer (group_id, search_round, guide_id) VALUES (g, 1, '00000000-0000-0000-0000-0000000000d4');
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000d4') = 'CANDIDATE';
  UPDATE dispatch.excursion_group SET window_ends_at = now() - interval '1 minute' WHERE id = g;
  ASSERT dispatch.select_guide(g) = '00000000-0000-0000-0000-0000000000d4';
  PERFORM set_config('dispatch.reason', 'Отказ гида: заболел', true);
  UPDATE dispatch.excursion_group SET status = 'SEARCHING', guide_id = NULL, busy_range = NULL WHERE id = g;
  PERFORM set_config('dispatch.reason', '', true);
  ASSERT (SELECT search_round FROM dispatch.excursion_group WHERE id = g) = 2;
  ASSERT (SELECT window_ends_at FROM dispatch.excursion_group WHERE id = g) IS NULL;
  INSERT INTO dispatch.offer (group_id, search_round, guide_id) VALUES (g, 2, '00000000-0000-0000-0000-0000000000d4');
  ASSERT dispatch.respond(g, 2, '00000000-0000-0000-0000-0000000000e5') = 'CANDIDATE';
  UPDATE dispatch.excursion_group SET window_ends_at = now() - interval '1 minute' WHERE id = g;
  ASSERT dispatch.select_guide(g) = '00000000-0000-0000-0000-0000000000e5', 'отклик прошлого раунда не должен действовать';
  ASSERT (SELECT reason FROM dispatch.group_event WHERE group_id = g AND to_status = 'SEARCHING' AND from_status = 'ASSIGNED')
         = 'Отказ гида: заболел';
  RAISE NOTICE 'ok  F-12 новый раунд: свежие предложения, старые отклики не действуют, причина отказа в истории';
END $$;

-- F-13: отозвал отклик и снова нажал «Хочу взять» — снова кандидат
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000205';
BEGIN
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000c3') = 'CANDIDATE';
  UPDATE dispatch.group_response SET withdrawn_at = now() WHERE group_id = g;
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000c3') = 'CANDIDATE';
  UPDATE dispatch.excursion_group SET window_ends_at = now() - interval '1 minute' WHERE id = g;
  ASSERT dispatch.select_guide(g) = '00000000-0000-0000-0000-0000000000c3';
  RAISE NOTICE 'ok  F-13 повторный отклик после отзыва учитывается';
END $$;

-- F-12, F-03: кнопка из сообщения прошлого раунда устарела. Гид без предложения и до рассылки может откликнуться
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000206';
BEGIN
  UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000d4',
         busy_range = tstzrange(starts_at, ends_at + interval '30 minutes') WHERE id = g;
  UPDATE dispatch.excursion_group SET status = 'SEARCHING', guide_id = NULL, busy_range = NULL WHERE id = g;
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000c3') = 'STALE_ROUND';
  ASSERT NOT EXISTS (SELECT 1 FROM dispatch.offer WHERE group_id = g);
  ASSERT dispatch.respond(g, 2, '00000000-0000-0000-0000-0000000000c3') = 'CANDIDATE';
  RAISE NOTICE 'ok  F-03 откликнуться может любой свободный гид, кнопка прошлого раунда отвечает «устарело»';
END $$;

-- F-03: окно прошло без откликов — группу получает первый нажавший; второй видит «получил другой»; повтор своего — тот же ответ
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000207';
BEGIN
  UPDATE dispatch.excursion_group SET window_ends_at = now() - interval '1 minute' WHERE id = g;
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000d4') = 'ASSIGNED';
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000e5') = 'TAKEN';
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000d4') = 'ASSIGNED';
  RAISE NOTICE 'ok  F-03 первое нажатие после пустого окна, повтор безопасен';
END $$;

-- F-03: окно закрылось, выбор ещё не выполнен, и тут нажимает другой гид — побеждает кандидат окна
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000208';
BEGIN
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000c3') = 'CANDIDATE';
  UPDATE dispatch.excursion_group SET window_ends_at = now() - interval '1 second' WHERE id = g;
  ASSERT dispatch.respond(g, 1, '00000000-0000-0000-0000-0000000000d4') = 'TAKEN';
  ASSERT (SELECT guide_id FROM dispatch.excursion_group WHERE id = g) = '00000000-0000-0000-0000-0000000000c3';
  RAISE NOTICE 'ok  F-03 нажатие сразу после окна не обходит выбор по окну';
END $$;

-- =====================================================================
-- Назначения, подтверждение, эскалации: F-14, F-15, F-22
-- =====================================================================

-- F-14: замена гида у подтверждённой группы даёт новое назначение без подтверждения.
-- Позднее назначение с явным подтверждением (BR-13) остаётся подтверждённым
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000209'; a1 uuid; a2 uuid;
BEGIN
  UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000d4',
         busy_range = tstzrange(starts_at, ends_at + interval '30 minutes') WHERE id = g;
  UPDATE dispatch.excursion_group SET status = 'CONFIRMED' WHERE id = g;
  SELECT assignment_id INTO a1 FROM dispatch.excursion_group WHERE id = g;
  UPDATE dispatch.excursion_group SET guide_id = '00000000-0000-0000-0000-0000000000e5' WHERE id = g;
  SELECT assignment_id INTO a2 FROM dispatch.excursion_group WHERE id = g;
  ASSERT (SELECT status FROM dispatch.excursion_group WHERE id = g) = 'ASSIGNED', 'новый гид не подтверждал выход';
  ASSERT a1 <> a2;
  UPDATE dispatch.excursion_group SET guide_id = '00000000-0000-0000-0000-0000000000d4',
         status = 'CONFIRMED', confirmed_at = now() WHERE id = g;
  ASSERT (SELECT status FROM dispatch.excursion_group WHERE id = g) = 'CONFIRMED';
  RAISE NOTICE 'ok  F-14 подтверждение не переходит к новому гиду, позднее назначение подтверждается явно';
END $$;

-- F-15: эскалация по прежнему назначению в работе, а по новому создать можно
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000209';
        cur uuid := (SELECT assignment_id FROM dispatch.excursion_group WHERE id = '00000000-0000-0000-0000-000000000209');
BEGIN
  INSERT INTO dispatch.escalation (group_id, assignment_id, reason, status, acked_by, acked_at)
  VALUES (g, gen_random_uuid(), 'NO_CONFIRMATION', 'ACKED', '00000000-0000-0000-0000-0000000000ad', now());
  INSERT INTO dispatch.escalation (group_id, assignment_id, reason, status) VALUES (g, cur, 'NO_CONFIRMATION', 'OPEN');
  BEGIN
    INSERT INTO dispatch.escalation (group_id, assignment_id, reason, status) VALUES (g, cur, 'NO_CONFIRMATION', 'OPEN');
    RAISE EXCEPTION 'вторая эскалация по тому же назначению';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  F-15 эскалации считаются по назначению';
END $$;

-- F-22: «взята в работу» хранит, кем и когда; каждое изменение эскалации — в истории
DO $$
DECLARE e uuid;
BEGIN
  BEGIN
    INSERT INTO dispatch.escalation (group_id, reason, status) VALUES ('00000000-0000-0000-0000-000000000210', 'NO_GUIDE', 'ACKED');
    RAISE EXCEPTION 'эскалация в работе без времени взятия';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO dispatch.escalation (group_id, reason, status) VALUES ('00000000-0000-0000-0000-000000000210', 'NO_GUIDE', 'OPEN')
  RETURNING id INTO e;
  UPDATE dispatch.escalation SET status = 'ACKED', acked_by = '00000000-0000-0000-0000-0000000000ad', acked_at = now() WHERE id = e;
  UPDATE dispatch.escalation SET status = 'RESOLVED', resolved_at = now() WHERE id = e;
  ASSERT (SELECT array_agg(to_status ORDER BY id) FROM dispatch.escalation_event WHERE escalation_id = e)
         = ARRAY['OPEN', 'ACKED', 'RESOLVED'];
  BEGIN
    INSERT INTO dispatch.escalation (booking_id, reason, status) VALUES ('00000000-0000-0000-0000-000000000110', 'NO_GUIDE', 'OPEN');
    RAISE EXCEPTION 'эскалация «Гид не найден» без группы';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  F-22 журнал эскалаций и время взятия в работу';
END $$;

-- =====================================================================
-- Исходы и причины: F-01, F-21, F-11
-- =====================================================================

-- F-01: группу без гида можно передать партнёру; назначенную — нельзя; главная метрика считается запросом
DO $$
DECLARE g uuid := '00000000-0000-0000-0000-000000000210';
BEGIN
  BEGIN
    UPDATE dispatch.excursion_group SET status = 'HANDED_OVER' WHERE id = g;
    RAISE EXCEPTION 'передача без причины';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE dispatch.excursion_group SET status = 'HANDED_OVER', closed_reason = 'PARTNER', partner_name = 'Экскурсии-партнёр'
   WHERE id = g;
  BEGIN
    UPDATE dispatch.excursion_group SET status = 'HANDED_OVER', guide_id = NULL, busy_range = NULL, closed_reason = 'PARTNER'
     WHERE id = '00000000-0000-0000-0000-000000000209';
    RAISE EXCEPTION 'передана группа с гидом';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'передана%' THEN RAISE; END IF;
  END;
  ASSERT (SELECT count(*) FROM dispatch.excursion_group
           WHERE status = 'HANDED_OVER' AND date_trunc('month', starts_at) = DATE '2026-11-01') = 1;
  RAISE NOTICE 'ok  F-01 исход «Передана партнёру» хранится и считается';
END $$;

-- F-21: отменённая заявка хранит причину
DO $$ BEGIN
  BEGIN
    UPDATE dispatch.booking SET status = 'CANCELLED' WHERE id = '00000000-0000-0000-0000-000000000111';
    RAISE EXCEPTION 'отмена без причины';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE dispatch.booking SET status = 'CANCELLED', cancel_reason = 'WEATHER' WHERE id = '00000000-0000-0000-0000-000000000111';
  RAISE NOTICE 'ok  F-21 причина отмены обязательна';
END $$;

-- F-11: флаг «повторить в amoCRM» бывает только у заявок из amoCRM
DO $$ BEGIN
  UPDATE dispatch.booking SET crm_resync_required = true WHERE id = '00000000-0000-0000-0000-000000000110';
  RAISE EXCEPTION 'флаг у заявки из панели';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  F-11 аварийная отмена помечает только заявки из amoCRM';
END $$;

-- =====================================================================
-- Данные клиентов, отписки, уведомления, параметры: F-16, F-19, F-22, F-23, F-30
-- =====================================================================

-- F-30: телефон в E.164, не только +7
DO $$ BEGIN
  INSERT INTO dispatch.client (full_name, phone_e164, messenger) VALUES ('Турист', '+375291234567', 'TELEGRAM');
  BEGIN
    INSERT INTO dispatch.client (full_name, phone_e164, messenger) VALUES ('Опечатка', '89991112233', 'TELEGRAM');
    RAISE EXCEPTION 'принят номер не в E.164';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  F-30 номера в E.164';
END $$;

-- F-23: обезличивание стирает и телефон, и имя
DO $$ BEGIN
  BEGIN
    UPDATE dispatch.client SET phone_e164 = NULL, anonymized_at = now() WHERE full_name = 'Турист';
    RAISE EXCEPTION 'имя осталось после обезличивания';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE dispatch.client SET phone_e164 = NULL, full_name = NULL, anonymized_at = now() WHERE full_name = 'Турист';
  RAISE NOTICE 'ok  F-23 обезличивание полное';
END $$;

-- F-16: отправленная отписка хранит именно тот текст, что ушёл клиенту
DO $$ BEGIN
  INSERT INTO dispatch.client_notice (booking_id, kind, status, due_at)
  VALUES ('00000000-0000-0000-0000-000000000105', 'NOTICE', 'PENDING', '2026-11-04 18:00+03');
  BEGIN
    UPDATE dispatch.client_notice SET status = 'SENT', sent_at = now(), channel = 'TELEGRAM'
     WHERE booking_id = '00000000-0000-0000-0000-000000000105';
    RAISE EXCEPTION 'отписка отмечена без текста';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE dispatch.client_notice SET status = 'SENT', sent_at = now(), channel = 'TELEGRAM',
         sent_text = 'Завтра в 11:00 ждём вас у места сбора, гид В, +79990000003'
   WHERE booking_id = '00000000-0000-0000-0000-000000000105';
  RAISE NOTICE 'ok  F-16 текст отписки фиксируется в момент отправки';
END $$;

-- F-19: у сообщения есть срок годности и предел попыток
DO $$ BEGIN
  BEGIN
    INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, expires_at, status)
    VALUES ('offer:x', 1001, now(), now() - interval '1 minute', 'QUEUED');
    RAISE EXCEPTION 'сообщение просрочено до отправки';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, expires_at, status, attempts)
    VALUES ('offer:y', 1001, now(), now() + interval '10 minutes', 'QUEUED', 6);
    RAISE EXCEPTION 'шестая попытка';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok  F-19 срок годности и не больше пяти попыток';
END $$;

-- F-22: изменение параметра остаётся в журнале
DO $$ BEGIN
  PERFORM set_config('dispatch.actor', 'ADMIN:00000000-0000-0000-0000-0000000000ad', true);
  UPDATE dispatch.parameter SET value = 'PT15M', updated_by = '00000000-0000-0000-0000-0000000000ad', updated_at = now()
   WHERE code = 'P-21';
  ASSERT (SELECT old_value || '→' || new_value FROM dispatch.parameter_event WHERE code = 'P-21' ORDER BY id DESC LIMIT 1)
         = 'PT10M→PT15M';
  ASSERT (SELECT actor FROM dispatch.parameter_event WHERE code = 'P-21' ORDER BY id DESC LIMIT 1) LIKE 'ADMIN:%';
  RAISE NOTICE 'ok  F-22 изменения параметров в журнале';
END $$;

\echo 'Все проверки пройдены'
