-- Воспроизведение замечаний ревью итерации 2 на схеме v0.3 (тег v0.3). Реестр замечаний — README.md рядом.
-- Запуск на чистой базе после DDL и проверок версии 0.3:
--   git show v0.3:docs/design/ddl.sql > /tmp/ddl-v03.sql
--   git show v0.3:docs/design/ddl-checks.sql > /tmp/checks-v03.sql
--   psql -v ON_ERROR_STOP=1 -d repro_v03 -f /tmp/ddl-v03.sql -f /tmp/checks-v03.sql -f repro-v0.3.sql
-- Каждая проверка печатает «ДЕФЕКТ» или «ok». В v0.4 эти сценарии стали проверками ddl-checks.sql с кодами F-xx.
-- Соответствие: 1а, 1б — F-12; 2 — F-13; 3а, 3б — F-05; 4 — F-14; 5 — F-15; 6 — F-18; 7 — F-01, F-21; 8 — F-22; 9а — F-30; 9б — F-31.

\set QUIET on
SET client_min_messages = notice;
SET TIME ZONE 'Europe/Moscow';

-- Данные: гиды Г и Д, у Д уже есть группа на неделе 2–8 ноября
INSERT INTO dispatch.guide (id, full_name, phone_e164, telegram_user_id, status, phone_share_consent_at) VALUES
 ('00000000-0000-0000-0000-0000000000d4', 'Гид Г', '+79990000004', 1004, 'ACTIVE', now()),
 ('00000000-0000-0000-0000-0000000000e5', 'Гид Д', '+79990000005', 1005, 'ACTIVE', now());
INSERT INTO dispatch.booking (id, source, client_id, route_id, starts_at, adults, payment_method, expected_amount, status) VALUES
 ('00000000-0000-0000-0000-0000000000b9', 'PANEL', '00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000000e1', '2026-11-03 11:00+03', 10, 'CASH', 10000, 'ACTIVE'),
 ('00000000-0000-0000-0000-0000000000ba', 'PANEL', '00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000000e1', '2026-11-04 15:00+03', 5, 'CASH', 5000, 'ACTIVE'),
 ('00000000-0000-0000-0000-0000000000bc', 'PANEL', '00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000000e1', '2026-11-04 16:00+03', 5, 'CASH', 5000, 'ACTIVE'),
 ('00000000-0000-0000-0000-0000000000bd', 'PANEL', '00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000000e1', '2026-11-05 11:00+03', 8, 'CASH', 8000, 'ACTIVE');
INSERT INTO dispatch.excursion_group (id, booking_id, seq, participants, starts_at, ends_at, status) VALUES
 ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-0000000000b9', 1, 10, '2026-11-03 11:00+03', '2026-11-03 12:30+03', 'SEARCHING'),
 ('00000000-0000-0000-0000-000000000092', '00000000-0000-0000-0000-0000000000ba', 1, 5,  '2026-11-04 15:00+03', '2026-11-04 16:30+03', 'SEARCHING'),
 ('00000000-0000-0000-0000-000000000093', '00000000-0000-0000-0000-0000000000bc', 1, 5,  '2026-11-04 16:00+03', '2026-11-04 17:30+03', 'SEARCHING'),
 ('00000000-0000-0000-0000-000000000095', '00000000-0000-0000-0000-0000000000bd', 1, 8,  '2026-11-05 11:00+03', '2026-11-05 12:30+03', 'SEARCHING');
UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000e5',
       busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
 WHERE id = '00000000-0000-0000-0000-000000000092';

-- 1. Повторный поиск (BR-09, BR-23): гид Г получил группу, отказался, группа снова ищет гида.
--    1а: новое предложение тем же гидам. 1б: во втором раунде откликнулся только Д.
DO $$ DECLARE chosen uuid; BEGIN
  INSERT INTO dispatch.offer (group_id, guide_id) VALUES ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-0000000000d4');
  INSERT INTO dispatch.group_response (group_id, guide_id) VALUES ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-0000000000d4');
  PERFORM dispatch.select_guide('00000000-0000-0000-0000-000000000091');
  UPDATE dispatch.excursion_group SET status = 'SEARCHING', guide_id = NULL, busy_range = NULL
   WHERE id = '00000000-0000-0000-0000-000000000091';
  BEGIN
    INSERT INTO dispatch.offer (group_id, guide_id) VALUES ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-0000000000d4');
    RAISE NOTICE 'ok      1а повторное предложение в новом раунде записывается';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ДЕФЕКТ  1а новое предложение тому же гиду нарушает ключ offer (group_id, guide_id)';
  END;
  INSERT INTO dispatch.group_response (group_id, guide_id) VALUES ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-0000000000e5');
  chosen := dispatch.select_guide('00000000-0000-0000-0000-000000000091');
  IF chosen = '00000000-0000-0000-0000-0000000000d4' THEN
    RAISE NOTICE 'ДЕФЕКТ  1б группа вернулась гиду, который от неё отказался: жив его отклик из прошлого раунда';
  ELSE
    RAISE NOTICE 'ok      1б выбран гид, откликнувшийся в текущем раунде';
  END IF;
END $$;

-- 2. Отозвал отклик и снова нажал «Хочу взять» в том же окне
DO $$ BEGIN
  INSERT INTO dispatch.group_response (group_id, guide_id) VALUES ('00000000-0000-0000-0000-000000000095', '00000000-0000-0000-0000-0000000000c3');
  UPDATE dispatch.group_response SET withdrawn_at = now() WHERE group_id = '00000000-0000-0000-0000-000000000095';
  INSERT INTO dispatch.group_response (group_id, guide_id) VALUES ('00000000-0000-0000-0000-000000000095', '00000000-0000-0000-0000-0000000000c3')
    ON CONFLICT DO NOTHING;   -- так повтор обрабатывает ddl-checks.sql
  IF dispatch.select_guide('00000000-0000-0000-0000-000000000095') IS NULL THEN
    RAISE NOTICE 'ДЕФЕКТ  2  повторный отклик после отзыва молча не учтён, группа без гида';
  ELSE
    RAISE NOTICE 'ok      2  повторный отклик учтён';
  END IF;
END $$;

-- 3. BR-09, US-06, PUT /assignment с confirmOverlap: назначить с пересечением после подтверждения
DO $$ BEGIN
  BEGIN
    UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000e5',
           busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
     WHERE id = '00000000-0000-0000-0000-000000000093';
    RAISE NOTICE 'ok      3а назначение с подтверждённым пересечением возможно';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'ДЕФЕКТ  3а «Назначить всё равно» база не пропустит никогда: исключающее ограничение без исключений';
  END;
  -- 3б. Пустой диапазон занятости проходит и CHECK, и исключающее ограничение
  BEGIN
    UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000e5',
           busy_range = tstzrange(starts_at, starts_at)
     WHERE id = '00000000-0000-0000-0000-000000000093';
    RAISE NOTICE 'ДЕФЕКТ  3б пустой busy_range обходит BR-07: у гида Д теперь две пересекающиеся группы';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok      3б пустой busy_range отклонён';
  END;
END $$;

-- 4. Замена гида у подтверждённой группы
DO $$ DECLARE st text; BEGIN
  UPDATE dispatch.excursion_group SET status = 'ASSIGNED', guide_id = '00000000-0000-0000-0000-0000000000d4',
         busy_range = tstzrange(starts_at, ends_at + interval '30 minutes')
   WHERE id = '00000000-0000-0000-0000-000000000091';
  UPDATE dispatch.excursion_group SET status = 'CONFIRMED' WHERE id = '00000000-0000-0000-0000-000000000091';
  UPDATE dispatch.excursion_group SET guide_id = '00000000-0000-0000-0000-0000000000c3' WHERE id = '00000000-0000-0000-0000-000000000091';
  SELECT status INTO st FROM dispatch.excursion_group WHERE id = '00000000-0000-0000-0000-000000000091';
  IF st = 'CONFIRMED' THEN
    RAISE NOTICE 'ДЕФЕКТ  4  новый гид числится подтвердившим выход, а переход CONFIRMED → ASSIGNED запрещён';
  ELSE
    RAISE NOTICE 'ok      4  после смены гида статус %', st;
  END IF;
END $$;

-- 5. Эскалация по прежнему гиду в работе, новый гид тоже не подтвердил (BR-27)
DO $$ BEGIN
  INSERT INTO dispatch.escalation (group_id, reason, status) VALUES ('00000000-0000-0000-0000-000000000091', 'NO_CONFIRMATION', 'ACKED');
  BEGIN
    INSERT INTO dispatch.escalation (group_id, reason, status) VALUES ('00000000-0000-0000-0000-000000000091', 'NO_CONFIRMATION', 'OPEN');
    RAISE NOTICE 'ok      5  эскалация по новому назначению создаётся';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ДЕФЕКТ  5  эскалацию по новому гиду не создать, пока открыта эскалация по прежнему';
  END;
END $$;

-- 6. amoCRM: две правки сделки в одну секунду (updated_at в amoCRM — целые секунды)
DO $$ DECLARE r text; p int; BEGIN
  PERFORM dispatch.apply_crm_booking(9000001, '2026-10-19 10:05:07+03', '00000000-0000-0000-0000-0000000000cc',
          '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 12, 0, 0, 'CASH', 12000);
  r := dispatch.apply_crm_booking(9000001, '2026-10-19 10:05:07+03', '00000000-0000-0000-0000-0000000000cc',
          '00000000-0000-0000-0000-0000000000e1', '2026-10-25 11:00+03', 18, 0, 0, 'CASH', 18000);
  SELECT participants INTO p FROM dispatch.booking WHERE external_id = 9000001;
  IF r = 'STALE' THEN
    RAISE NOTICE 'ДЕФЕКТ  6  вторая правка той же секунды отброшена как STALE: в диспетчере % участников, в CRM 18', p;
  ELSE
    RAISE NOTICE 'ok      6  правка той же секунды применена';
  END IF;
END $$;

-- 7. Где хранится причина отмены и передача партнёру (главная метрика видения)
SELECT CASE WHEN count(*) = 0 THEN 'ДЕФЕКТ  7  нет ни причины отмены, ни признака «передана партнёру»'
            ELSE 'ok      7  ' || string_agg(table_name || '.' || column_name, ', ') END
  FROM information_schema.columns
 WHERE table_schema = 'dispatch' AND (column_name ILIKE '%cancel%' OR column_name ILIKE '%partner%')
UNION ALL
SELECT CASE WHEN count(*) = 0 THEN 'ДЕФЕКТ  8  не хранится, когда дежурный взял эскалацию: BR-25 и NFR-11 не проверить'
            ELSE 'ok      8  есть ' || string_agg(column_name, ', ') END
  FROM information_schema.columns
 WHERE table_schema = 'dispatch' AND table_name = 'escalation' AND column_name ILIKE 'acked_at';

-- 9. Клиент с номером не +7 (турист из Беларуси) и сумма без тарифа
DO $$ BEGIN
  INSERT INTO dispatch.client (full_name, phone_e164, messenger) VALUES ('Турист', '+375291234567', 'TELEGRAM');
  RAISE NOTICE 'ok      9а иностранный номер принят';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ДЕФЕКТ  9а заявку с номером +375 из amoCRM не загрузить';
END $$;
SELECT CASE WHEN dispatch.expected_amount('00000000-0000-0000-0000-0000000000e1', DATE '2025-12-31', 2, 0, 0) = 0
            THEN 'ДЕФЕКТ  9б нет тарифа на дату: ожидаемая сумма молча 0' ELSE 'ok      9б' END;
