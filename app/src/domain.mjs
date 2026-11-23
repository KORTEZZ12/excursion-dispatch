// Правила групп и назначений поверх модели данных. Каждая функция работает в транзакции c и с моментом now.
// Ограничения, которые держит база (пересечение у гида, статусная модель, журнал), здесь не дублируются:
// их нарушение превращается в понятный ответ.
import { params, setReason } from './db.mjs';
import { enqueue, invalidate } from './outbox.mjs';
import { addMs, addOutsideQuiet, min, mskDate, parseDuration, quiet } from './time.mjs';
import * as T from './texts.mjs';

export class DomainError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

const FINAL = ['COMPLETED', 'NOT_HELD', 'CANCELLED', 'HANDED_OVER'];
const ACTIVE = ['SEARCHING', 'ASSIGNED', 'CONFIRMED'];
const dur = (p, code) => parseDuration(p[code]);

// ---------------------------------------------------------------- чтение

const GROUP_SQL = `
  SELECT g.*, r.name AS route_name, r.meeting_point, r.meeting_point_map_url, r.duration,
         b.payment_method, b.source, b.status AS booking_status, cl.full_name AS client_name,
         gd.full_name AS guide_name, gd.phone_e164 AS guide_phone, gd.telegram_chat_id AS guide_chat
    FROM dispatch.excursion_group g
    JOIN dispatch.booking b ON b.id = g.booking_id
    JOIN dispatch.route r ON r.id = b.route_id
    JOIN dispatch.client cl ON cl.id = b.client_id
    LEFT JOIN dispatch.guide gd ON gd.id = g.guide_id`;

export async function loadGroup(c, id, { lock = false } = {}) {
  if (lock) await c.query('SELECT 1 FROM dispatch.excursion_group WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await c.query(`${GROUP_SQL} WHERE g.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function groupByAssignment(c, assignmentId) {
  const { rows } = await c.query('SELECT id FROM dispatch.excursion_group WHERE assignment_id = $1', [assignmentId]);
  return rows[0] ? loadGroup(c, rows[0].id, { lock: true }) : null;
}

export async function groupsOfBooking(c, bookingId) {
  const { rows } = await c.query(`${GROUP_SQL} WHERE g.booking_id = $1 ORDER BY g.seq`, [bookingId]);
  return rows;
}

export async function activeAdmins(c) {
  const { rows } = await c.query('SELECT * FROM dispatch.admin WHERE active ORDER BY full_name');
  return rows;
}

async function dutyAdmin(c, now) {
  const { rows } = await c.query(
    'SELECT a.* FROM dispatch.duty_shift s JOIN dispatch.admin a ON a.id = s.admin_id WHERE s.during @> $1::timestamptz AND a.active', [now]);
  return rows[0] ?? null;
}

// find-free-guides: активные гиды без пересечения с группой с учётом буфера P-02 (BR-05, BR-09)
export async function freeGuides(c, g) {
  const p = await params(c);
  const { rows } = await c.query(
    `SELECT gd.* FROM dispatch.guide gd
      WHERE gd.status = 'ACTIVE' AND gd.bot_blocked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM dispatch.excursion_group x
                         WHERE x.guide_id = gd.id AND x.id <> $1
                           AND x.busy_range && tstzrange($2::timestamptz, $3::timestamptz + $4::interval, '[)'))
      ORDER BY gd.full_name`,
    [g.id, g.starts_at, g.ends_at, p['P-02']],
  );
  return rows;
}

// ---------------------------------------------------------------- уведомления

// Сообщение гиду о группе. О группе в ближайшие 12 ч — без переноса на утро (BR-14)
async function tellGuide(c, now, g, chatId, body, key, { assignmentId = g.assignment_id, expiresAt = g.starts_at } = {}) {
  if (!chatId) return;
  await enqueue(c, { chatId, dedupKey: key, body, at: now, expiresAt, urgentFor: g.starts_at, groupId: g.id, assignmentId });
}

async function tellAdmins(c, now, admins, body, key, urgentFor = null) {
  for (const a of admins) {
    if (!a.telegram_user_id) continue;
    await enqueue(c, { chatId: a.telegram_user_id, dedupKey: `${key}:${a.id}`, body, at: now, expiresAt: addMs(now, 24 * 3600e3), urgentFor });
  }
}

export async function notifyAdmins(c, now, body, key, urgentFor = null) {
  await tellAdmins(c, now, await activeAdmins(c), body, key, urgentFor);
}

// Резервный канал тревог — звонок всем администраторам (D-14, NFR-16). Провайдер не выбран (Q-06): журнал вызовов
export async function alarmAll(c, now, kind, text) {
  for (const a of await activeAdmins(c)) {
    await c.query('INSERT INTO dispatch.alarm (at, admin_id, kind, text) VALUES ($1, $2, $3, $4)', [now, a.id, kind, text]);
  }
}

// ---------------------------------------------------------------- эскалации

// create-escalation. Пока открыта эскалация с той же причиной по тому же ключу, вторая не создаётся (BR-27).
// Уходит дежурному, а если его нет в графике — сразу всем (BR-25)
export async function openEscalation(c, now, { reason, groupId = null, assignmentId = null, bookingId = null }) {
  const { rows: open } = await c.query(
    `SELECT * FROM dispatch.escalation WHERE status <> 'RESOLVED' AND reason = $1
        AND COALESCE(assignment_id, group_id, booking_id) = COALESCE($2::uuid, $3::uuid, $4::uuid)`,
    [reason, assignmentId, groupId, bookingId]);
  if (open[0]) return open[0];
  const duty = reason === 'NOTICE_NOT_SENT' ? null : await dutyAdmin(c, now);
  const { rows } = await c.query(
    `INSERT INTO dispatch.escalation (group_id, assignment_id, booking_id, reason, status, opened_at, sent_to_all_at)
     VALUES ($1, $2, $3, $4, 'OPEN', $5, $6) RETURNING *`,
    [groupId, assignmentId, bookingId, reason, now, duty ? null : now]);
  const e = rows[0];
  const g = groupId ? await loadGroup(c, groupId) : null;
  const to = duty ? [duty] : await activeAdmins(c);
  await tellAdmins(c, now, to, T.escalation(e, g), `esc:${e.id}`, g?.starts_at ?? null);
  return e;
}

// resolve-escalation: причина устранена — эскалация закрывается сама (BR-26)
export async function resolveEscalations(c, now, { groupId = null, assignmentId = null, reasons, why = null }) {
  const { rows } = await c.query(
    `UPDATE dispatch.escalation SET status = 'RESOLVED', resolved_at = $1
      WHERE status <> 'RESOLVED' AND reason = ANY($2)
        AND (($3::uuid IS NOT NULL AND assignment_id = $3) OR ($4::uuid IS NOT NULL AND group_id = $4 AND ($3::uuid IS NULL OR assignment_id IS NULL)))
      RETURNING *`,
    [now, reasons, assignmentId, groupId]);
  if (why) {
    for (const e of rows) {
      const g = e.group_id ? await loadGroup(c, e.group_id) : null;
      const duty = e.sent_to_all_at ? null : await dutyAdmin(c, now);
      await tellAdmins(c, now, duty ? [duty] : await activeAdmins(c), T.escalationResolved(e, g, why), `esc-resolved:${e.id}`, g?.starts_at ?? null);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- поиск гида

// Группа ждёт гида. В релизе 1 предложений в боте нет (D-12): гида назначает администратор,
// а срок, после которого дежурный получает «Гид не найден», считается по BR-08
export async function startSearch(c, now, g) {
  const p = await params(c);
  const q = quiet(p['P-09']);
  const toStart = g.starts_at - now;
  let due;
  if (!(await freeGuides(c, g)).length) due = now;                        // свободных гидов нет с самого начала
  else if (toStart > dur(p, 'P-04')) due = min(addOutsideQuiet(now, dur(p, 'P-03'), q), addMs(g.starts_at, -dur(p, 'P-04')));
  else if (toStart >= 3600e3) due = addOutsideQuiet(now, dur(p, 'P-05'), q);
  else due = now;                                                         // меньше часа: окна откликов в релизе 1 нет
  await c.query(
    `INSERT INTO dispatch.search_timer (group_id, search_round, started_at, due_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id, search_round) DO NOTHING`, [g.id, g.search_round, now, due]);
}

// ---------------------------------------------------------------- назначение и снятие (US-06, BR-09, BR-13)

async function overlapsFor(c, g, guideId) {
  const p = await params(c);
  const { rows } = await c.query(
    `${GROUP_SQL} WHERE g.guide_id = $1 AND g.id <> $2
        AND g.busy_range && tstzrange($3::timestamptz, $4::timestamptz + $5::interval, '[)') ORDER BY g.starts_at`,
    [guideId, g.id, g.starts_at, g.ends_at, p['P-02']]);
  return rows;
}

// Сообщения и эскалации прежнего назначения больше не действуют (задача invalidate-guide-messages)
async function closeAssignment(c, now, assignmentId) {
  await invalidate(c, { assignmentId });
  await resolveEscalations(c, now, { assignmentId, reasons: ['NO_CONFIRMATION', 'REPLACEMENT_REQUESTED', 'GUIDE_BLOCKED_BOT'] });
  await c.query('UPDATE dispatch.new_time_request SET closed_at = $2 WHERE assignment_id = $1 AND closed_at IS NULL', [assignmentId, now]);
}

export async function assignGuide(c, now, { groupId, guideId }) {
  const p = await params(c);
  const g = await loadGroup(c, groupId, { lock: true });
  if (!g) throw new DomainError('NOT_FOUND');
  if (FINAL.includes(g.status)) throw new DomainError('GROUP_NOT_ASSIGNABLE', { status: g.status });
  const { rows: [guide] } = await c.query('SELECT * FROM dispatch.guide WHERE id = $1', [guideId]);
  if (!guide || guide.status !== 'ACTIVE' || guide.bot_blocked_at) throw new DomainError('GUIDE_NOT_ACTIVE');
  if (g.guide_id === guideId) return g;

  // Позднее назначение — сразу подтверждение выхода (BR-13). Подтверждение дня распространяется на новую группу
  const late = g.starts_at - now < dur(p, 'P-07');
  const { rows: sameDay } = await c.query(
    `SELECT 1 FROM dispatch.excursion_group WHERE guide_id = $1 AND status = 'CONFIRMED' AND id <> $2
        AND (starts_at AT TIME ZONE 'Europe/Moscow')::date = ($3::timestamptz AT TIME ZONE 'Europe/Moscow')::date`,
    [guideId, groupId, g.starts_at]);
  const confirmed = late || sameDay.length > 0;

  await c.query('SAVEPOINT assign');
  try {
    await c.query(
      `UPDATE dispatch.excursion_group
          SET status = $2, guide_id = $3, busy_range = tstzrange(starts_at, ends_at + $4::interval, '[)'), confirmed_at = $5
        WHERE id = $1`,
      [groupId, confirmed ? 'CONFIRMED' : 'ASSIGNED', guideId, p['P-02'], confirmed ? now : null]);
  } catch (e) {
    if (e.code !== '23P01') throw e;
    await c.query('ROLLBACK TO SAVEPOINT assign');
    throw new DomainError('GUIDE_BUSY', { overlaps: await overlapsFor(c, g, guideId) });   // D-13: исключений нет
  }
  await c.query('RELEASE SAVEPOINT assign');

  if (g.guide_id) {
    await tellGuide(c, now, g, g.guide_chat, T.removed(g, 'Группу передали другому гиду'), `removed:${g.assignment_id}`, { assignmentId: null });
    await closeAssignment(c, now, g.assignment_id);
  }
  const ng = await loadGroup(c, groupId);
  await resolveEscalations(c, now, { groupId, reasons: ['NO_GUIDE'] });
  await tellGuide(c, now, ng, guide.telegram_chat_id, T.assigned(ng, { confirmed }), `assigned:${ng.assignment_id}`);
  return ng;
}

export async function unassignGuide(c, now, { groupId, reason, why = 'Администратор снял вас с группы' }) {
  const g = await loadGroup(c, groupId, { lock: true });
  if (!g) throw new DomainError('NOT_FOUND');
  if (!g.guide_id || FINAL.includes(g.status)) return g;
  await setReason(c, reason);
  await c.query("UPDATE dispatch.excursion_group SET status = 'SEARCHING', guide_id = NULL, busy_range = NULL WHERE id = $1", [groupId]);
  await setReason(c, null);
  await tellGuide(c, now, g, g.guide_chat, T.removed(g, why), `removed:${g.assignment_id}`, { assignmentId: null });
  await closeAssignment(c, now, g.assignment_id);
  const ng = await loadGroup(c, groupId);
  await startSearch(c, now, ng);
  return ng;
}

// ---------------------------------------------------------------- действия гида (US-09, US-12)

// «Подтвердить выход»: подтверждаются все группы гида в этот день (BR-13)
export async function confirmAttendance(c, now, { assignmentId, guideId }) {
  const g = await groupByAssignment(c, assignmentId);
  if (!g || g.guide_id !== guideId) return { answer: 'Вы больше не ведёте эту группу' };
  if (FINAL.includes(g.status)) return { answer: 'Группа уже закрыта' };
  if (g.status === 'CONFIRMED') return { answer: 'Выход уже подтверждён' };
  const { rows } = await c.query(
    `UPDATE dispatch.excursion_group SET status = 'CONFIRMED', confirmed_at = $3
      WHERE guide_id = $1 AND status = 'ASSIGNED' AND starts_at > $3
        AND (starts_at AT TIME ZONE 'Europe/Moscow')::date = ($2::timestamptz AT TIME ZONE 'Europe/Moscow')::date
      RETURNING id, assignment_id`,
    [guideId, g.starts_at, now]);
  for (const r of rows) {
    await invalidate(c, { assignmentId: r.assignment_id });
    await resolveEscalations(c, now, { assignmentId: r.assignment_id, reasons: ['NO_CONFIRMATION'], why: 'Гид подтвердил выход' });
  }
  return { answer: rows.length > 1 ? `Выход подтверждён на ${rows.length} группы` : 'Выход подтверждён', confirmed: rows.map((r) => r.id) };
}

// «Попросить замену»: эскалация сразу, гид остаётся назначенным до решения администратора (BR-23)
export async function requestReplacement(c, now, { assignmentId, guideId }) {
  const g = await groupByAssignment(c, assignmentId);
  if (!g || g.guide_id !== guideId) return { answer: 'Вы больше не ведёте эту группу' };
  if (FINAL.includes(g.status)) return { answer: 'Группа уже закрыта' };
  await openEscalation(c, now, { reason: 'REPLACEMENT_REQUESTED', groupId: g.id, assignmentId });
  return { answer: 'Дежурный получил просьбу о замене. Пока замену не нашли, группа остаётся за вами' };
}

export async function confirmNewTime(c, now, { assignmentId, guideId }) {
  const g = await groupByAssignment(c, assignmentId);
  if (!g || g.guide_id !== guideId) return { answer: 'Вы больше не ведёте эту группу' };
  const { rowCount } = await c.query(
    'UPDATE dispatch.new_time_request SET confirmed_at = $2, closed_at = $2 WHERE assignment_id = $1 AND closed_at IS NULL', [assignmentId, now]);
  return { answer: rowCount ? 'Новое время подтверждено' : 'Новое время уже подтверждено' };
}

// ---------------------------------------------------------------- заявка: группы, отмена, перенос, число участников

async function cancelGroup(c, now, g, closedReason, body) {
  await c.query(
    "UPDATE dispatch.excursion_group SET status = 'CANCELLED', closed_reason = $2, guide_id = NULL, busy_range = NULL WHERE id = $1",
    [g.id, closedReason]);
  await invalidate(c, { groupId: g.id });
  if (g.assignment_id) await closeAssignment(c, now, g.assignment_id);
  await resolveEscalations(c, now, { groupId: g.id, reasons: ['NO_GUIDE', 'NO_CONFIRMATION', 'REPLACEMENT_REQUESTED', 'GUIDE_BLOCKED_BOT'] });
  if (g.guide_id) await tellGuide(c, now, g, g.guide_chat, body, `cancelled:${g.id}`, { assignmentId: null });
}

// Группы заявки — под число участников по BR-02. Новая заявка — все группы; изменение числа — BR-22
export async function syncGroups(c, now, bookingId) {
  const p = await params(c);
  const { rows: [b] } = await c.query(
    'SELECT b.*, r.duration FROM dispatch.booking b JOIN dispatch.route r ON r.id = b.route_id WHERE b.id = $1', [bookingId]);
  const { rows: [{ sizes }] } = await c.query('SELECT dispatch.split_participants($1, $2) AS sizes', [b.participants, Number(p['P-01'])]);
  const all = await groupsOfBooking(c, bookingId);
  let active = all.filter((g) => ACTIVE.includes(g.status));

  if (active.length > sizes.length) {
    // Групп стало меньше: сначала без гида, затем та, гид которой назначен последним
    const { rows: assignedAt } = await c.query(
      `SELECT DISTINCT ON (group_id) group_id, at FROM dispatch.group_event
        WHERE group_id = ANY($1) AND guide_id IS NOT NULL ORDER BY group_id, id DESC`, [active.map((g) => g.id)]);
    const at = new Map(assignedAt.map((r) => [r.group_id, r.at]));
    const order = [...active].sort((x, y) => {
      if (!x.guide_id !== !y.guide_id) return x.guide_id ? 1 : -1;
      if (!x.guide_id) return y.seq - x.seq;
      return at.get(y.id) - at.get(x.id);
    });
    for (const g of order.slice(0, active.length - sizes.length)) {
      await setReason(c, 'Число участников уменьшилось');
      await cancelGroup(c, now, g, 'SURPLUS', T.removed(g, 'Группа стала лишней: число участников уменьшилось'));
    }
    await setReason(c, null);
    active = (await groupsOfBooking(c, bookingId)).filter((g) => ACTIVE.includes(g.status));
  }

  for (const [i, g] of active.entries()) {
    if (g.participants === sizes[i]) continue;
    await c.query('UPDATE dispatch.excursion_group SET participants = $2 WHERE id = $1', [g.id, sizes[i]]);
    if (g.guide_id) {
      const ng = await loadGroup(c, g.id);
      await tellGuide(c, now, ng, g.guide_chat, T.participantsChanged(ng, g.participants), `participants:${g.assignment_id}:${sizes[i]}`);
    }
  }

  const maxSeq = Math.max(0, ...all.map((g) => g.seq));
  for (let k = active.length; k < sizes.length; k++) {
    const { rows: [ng] } = await c.query(
      `INSERT INTO dispatch.excursion_group (booking_id, seq, participants, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $4::timestamptz + $5::interval, 'SEARCHING') RETURNING id`,
      [bookingId, maxSeq + 1 + (k - active.length), sizes[k], b.starts_at, b.duration]);
    await startSearch(c, now, await loadGroup(c, ng.id));
  }
}

// BR-20: при отмене заявки отменяются все её группы, гиды получают уведомление, запланированное отменяется
export async function cancelBooking(c, now, { bookingId, reason, comment = null, emergency = false, fromCrm = false }) {
  const { rows: [b] } = await c.query('SELECT * FROM dispatch.booking WHERE id = $1 FOR UPDATE', [bookingId]);
  if (!b) throw new DomainError('NOT_FOUND');
  if (b.status === 'CANCELLED') return b;
  if (b.source === 'AMOCRM' && !fromCrm && !emergency) throw new DomainError('BOOKING_FROM_CRM');
  await c.query(
    `UPDATE dispatch.booking SET status = 'CANCELLED', cancel_reason = $2, cancel_comment = $3,
            crm_resync_required = $4, version = version + 1, updated_at = $5 WHERE id = $1`,
    [bookingId, reason, comment, emergency && b.source === 'AMOCRM', now]);
  await setReason(c, `Заявка отменена: ${reason}`);
  for (const g of (await groupsOfBooking(c, bookingId)).filter((x) => ACTIVE.includes(x.status))) {
    await cancelGroup(c, now, g, 'BOOKING_CANCELLED', T.cancelled(g));
  }
  await setReason(c, null);
  return b;
}

// BR-21: перенос. Назначение сохраняется и ждёт «Подтвердить новое время» P-13; пересечение — сразу в поиск
export async function rescheduleBooking(c, now, { bookingId, oldStart }) {
  const p = await params(c);
  const q = quiet(p['P-09']);
  const { rows: [b] } = await c.query(
    'SELECT b.*, r.duration FROM dispatch.booking b JOIN dispatch.route r ON r.id = b.route_id WHERE b.id = $1', [bookingId]);
  for (const g of (await groupsOfBooking(c, bookingId)).filter((x) => ACTIVE.includes(x.status))) {
    if (!g.guide_id) {
      // Новый раунд: отклики на старое время не действуют (F-32)
      await c.query(
        `UPDATE dispatch.excursion_group SET starts_at = $2, ends_at = $2::timestamptz + $3::interval, search_round = search_round + 1,
                window_ends_at = NULL WHERE id = $1`, [g.id, b.starts_at, b.duration]);
      await startSearch(c, now, await loadGroup(c, g.id));
      continue;
    }
    await c.query('SAVEPOINT move');
    try {
      await c.query(
        `UPDATE dispatch.excursion_group
            SET starts_at = $2, ends_at = $2::timestamptz + $3::interval,
                busy_range = tstzrange($2::timestamptz, $2::timestamptz + $3::interval + $4::interval, '[)'),
                status = CASE WHEN status = 'CONFIRMED' THEN 'ASSIGNED' ELSE status END
          WHERE id = $1`, [g.id, b.starts_at, b.duration, p['P-02']]);
      await c.query('RELEASE SAVEPOINT move');
    } catch (e) {
      if (e.code !== '23P01') throw e;
      await c.query('ROLLBACK TO SAVEPOINT move');
      await setReason(c, 'Новое время пересекается с другой группой гида');
      await c.query(
        `UPDATE dispatch.excursion_group SET starts_at = $2, ends_at = $2::timestamptz + $3::interval,
                status = 'SEARCHING', guide_id = NULL, busy_range = NULL WHERE id = $1`, [g.id, b.starts_at, b.duration]);
      await setReason(c, null);
      const moved = await loadGroup(c, g.id);
      await tellGuide(c, now, moved, g.guide_chat, T.removed(moved, 'Новое время пересекается с другой вашей группой'), `removed:${g.assignment_id}`, { assignmentId: null });
      await closeAssignment(c, now, g.assignment_id);
      await startSearch(c, now, moved);
      continue;
    }
    const moved = await loadGroup(c, g.id);
    await invalidate(c, { assignmentId: g.assignment_id });
    await c.query(
      `INSERT INTO dispatch.new_time_request (assignment_id, group_id, requested_at, due_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (assignment_id) DO UPDATE SET requested_at = $3, due_at = $4, confirmed_at = NULL, closed_at = NULL`,
      [g.assignment_id, g.id, now, addOutsideQuiet(now, dur(p, 'P-13'), q)]);
    await tellGuide(c, now, moved, g.guide_chat, T.newTime(moved, oldStart ?? g.starts_at), `ntim:${g.assignment_id}:${moved.starts_at.toISOString()}`);
  }
}

// BR-36: этап «Проведена» в amoCRM — заявка и назначенные группы проведены
export async function completeBooking(c, now, bookingId) {
  await c.query("UPDATE dispatch.booking SET status = 'COMPLETED', version = version + 1, updated_at = $2 WHERE id = $1 AND status = 'ACTIVE'", [bookingId, now]);
  const { rows } = await c.query(
    "UPDATE dispatch.excursion_group SET status = 'COMPLETED' WHERE booking_id = $1 AND status IN ('ASSIGNED', 'CONFIRMED') RETURNING id", [bookingId]);
  for (const r of rows) await invalidate(c, { groupId: r.id });
}

// ---------------------------------------------------------------- гиды (US-21, BR-30, BR-31)

// Деактивация: будущие группы гида возвращаются в поиск, сообщения ему не уходят, администраторы получают список
export async function deactivateGuide(c, now, { guideId, why = 'Гид деактивирован' }) {
  const { rows: [guide] } = await c.query('SELECT * FROM dispatch.guide WHERE id = $1 FOR UPDATE', [guideId]);
  if (!guide) throw new DomainError('NOT_FOUND');
  const returned = [];
  if (guide.status !== 'DEACTIVATED') {
    await c.query("UPDATE dispatch.guide SET status = 'DEACTIVATED' WHERE id = $1", [guideId]);
    const { rows } = await c.query(
      "SELECT id FROM dispatch.excursion_group WHERE guide_id = $1 AND status IN ('ASSIGNED', 'CONFIRMED') AND starts_at > $2 ORDER BY starts_at",
      [guideId, now]);
    for (const r of rows) {
      const g = await loadGroup(c, r.id, { lock: true });
      await setReason(c, why);
      await c.query("UPDATE dispatch.excursion_group SET status = 'SEARCHING', guide_id = NULL, busy_range = NULL WHERE id = $1", [r.id]);
      await setReason(c, null);
      await closeAssignment(c, now, g.assignment_id);
      await startSearch(c, now, await loadGroup(c, r.id));
      returned.push(g);
    }
    if (guide.telegram_chat_id) await invalidate(c, { chatId: guide.telegram_chat_id });
    const list = returned.length
      ? returned.slice(0, 7).map((g) => `${T.atIso(g.starts_at).slice(0, 16).replace('T', ' ')} — ${g.route_name}`).join('\n')
      : 'Будущих групп не было';
    await notifyAdmins(c, now, { text: `${why}: ${guide.full_name}\nВ поиск вернулись группы:\n${list}` }, `deactivated:${guideId}:${now.getTime()}`);
  }
  return { guide: (await c.query('SELECT * FROM dispatch.guide WHERE id = $1', [guideId])).rows[0], returnedToSearch: returned.map((g) => g.id) };
}

// Telegram ответил 403: гид исключается из назначений, по его будущим группам — эскалация (BR-31)
export async function markBotBlocked(c, now, chatId) {
  const { rows: [guide] } = await c.query(
    'UPDATE dispatch.guide SET bot_blocked_at = COALESCE(bot_blocked_at, $2) WHERE telegram_chat_id = $1 RETURNING *', [chatId, now]);
  if (!guide) return;
  const { rows } = await c.query(
    "SELECT id, assignment_id FROM dispatch.excursion_group WHERE guide_id = $1 AND status IN ('ASSIGNED', 'CONFIRMED') AND starts_at > $2",
    [guide.id, now]);
  for (const r of rows) await openEscalation(c, now, { reason: 'GUIDE_BLOCKED_BOT', groupId: r.id, assignmentId: r.assignment_id });
}

export { ACTIVE, FINAL, mskDate };
