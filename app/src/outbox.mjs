// Очередь отправки в Telegram (outbox): сообщение пишется в той же транзакции, что и изменение,
// и уходит отдельным обработчиком. Тихие часы, срок годности, повторы и 403 — по NFR-08 и BR-14.
import { outOfQuiet, quiet, addMs } from './time.mjs';
import { params } from './db.mjs';

const URGENT_HORIZON = 12 * 3600e3; // BR-14: сообщения о группах в ближайшие 12 ч не ждут утра

// Поставить сообщение в очередь. Повтор с тем же dedupKey ничего не делает: сводка и запрос не уйдут дважды.
// urgentFor — начало группы: если до него меньше 12 ч, тихие часы не действуют
export async function enqueue(c, { chatId, dedupKey, body, at, expiresAt, urgentFor = null, groupId = null, assignmentId = null }) {
  if (chatId == null) return null;
  const p = await params(c);
  const urgent = urgentFor && urgentFor - at < URGENT_HORIZON;
  const scheduled = urgent ? at : outOfQuiet(at, quiet(p['P-09']));
  if (scheduled >= expiresAt) return null; // NFR-08: просроченное не отправляется
  const { rows } = await c.query(
    `INSERT INTO dispatch.notification (dedup_key, chat_id, scheduled_at, expires_at, status, body, group_id, assignment_id, created_at)
     VALUES ($1, $2, $3, $4, 'QUEUED', $5, $6, $7, $8)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [dedupKey, chatId, scheduled, expiresAt, body, groupId, assignmentId, at],
  );
  return rows[0]?.id ?? null;
}

// invalidate-guide-messages: снятие, замена, отмена — запланированные сообщения по назначению не уходят
export async function invalidate(c, { assignmentId = null, groupId = null, chatId = null }) {
  await c.query(
    `UPDATE dispatch.notification SET status = 'CANCELLED'
      WHERE status = 'QUEUED' AND ((assignment_id = $1) OR (group_id = $2 AND $1::uuid IS NULL) OR (chat_id = $3))`,
    [assignmentId, groupId, chatId],
  );
}

// Обработчик очереди. Возвращает число обработанных сообщений
export function createDeliverer({ db, telegram, clock, onBlocked, onFailed, perChatIntervalMs = 1000 }) {
  const lastSentAt = new Map();
  return async function deliver() {
    let handled = 0;
    for (;;) {
      const now = clock.now();
      const { rows } = await db.query(
        `SELECT * FROM dispatch.notification WHERE status = 'QUEUED' AND scheduled_at <= $1 ORDER BY scheduled_at, id LIMIT 30`,
        [now],
      );
      if (!rows.length) return handled;
      for (const n of rows) {
        handled += 1;
        if (now >= n.expires_at) {
          await db.query("UPDATE dispatch.notification SET status = 'EXPIRED' WHERE id = $1 AND status = 'QUEUED'", [n.id]);
          continue;
        }
        const wait = perChatIntervalMs - (Date.now() - (lastSentAt.get(String(n.chat_id)) ?? 0));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // лимит Bot API: в один чат не чаще раза в секунду
        const r = await telegram.sendMessage(n.chat_id, n.body);
        lastSentAt.set(String(n.chat_id), Date.now());
        if (r.ok) {
          await db.query(
            "UPDATE dispatch.notification SET status = 'SENT', telegram_message_id = $2, sent_at = $3, attempts = attempts + 1 WHERE id = $1",
            [n.id, r.messageId, now],
          );
        } else if (r.code === 429) {
          await db.query('UPDATE dispatch.notification SET scheduled_at = $2, last_error = $3 WHERE id = $1',
            [n.id, addMs(now, (r.retryAfter ?? 1) * 1000), r.description]);
        } else if (r.code === 403) {
          await db.query("UPDATE dispatch.notification SET status = 'FAILED', attempts = attempts + 1, last_error = $2 WHERE id = $1", [n.id, r.description]);
          await onBlocked(n.chat_id);
        } else if (r.code === 400) {
          await db.query("UPDATE dispatch.notification SET status = 'FAILED', attempts = attempts + 1, last_error = $2 WHERE id = $1", [n.id, r.description]);
        } else {
          // Таймаут и 5xx: до 5 попыток с экспоненциальной паузой и разбросом
          const attempts = n.attempts + 1;
          if (attempts >= 5) {
            await db.query("UPDATE dispatch.notification SET status = 'FAILED', attempts = $2, last_error = $3 WHERE id = $1", [n.id, attempts, r.description]);
            await onFailed(n);
          } else {
            const pause = 2 ** attempts * 1000 * (0.75 + Math.random() / 2);
            await db.query('UPDATE dispatch.notification SET attempts = $2, last_error = $3, scheduled_at = $4 WHERE id = $1',
              [n.id, attempts, r.description, addMs(now, pause)]);
          }
        }
      }
    }
  };
}
