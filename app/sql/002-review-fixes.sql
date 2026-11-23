-- Исправления по ревью итерации 3 (docs/reviews/2026-11-23-iteration-3/README.md)

-- Запрос подтверждения помнит, на какое назначение ведёт его кнопка. Если это назначение больше не ждёт
-- подтверждения — гида сняли или группу перенесли, — уходит новый запрос (SAR-1)
ALTER TABLE dispatch.confirmation_request ADD COLUMN assignment_id uuid;

-- «Требует внимания»: администратор закрывает пункт с комментарием (SAR-3)
ALTER TABLE dispatch.attention
    ADD COLUMN resolved_by  uuid REFERENCES dispatch.admin (id),
    ADD COLUMN comment      text;
