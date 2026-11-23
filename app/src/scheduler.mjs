// Планировщик в базе (ADR-003). Каждый проход носит имя типа задачи из BPMN-схем:
// to-be-daily-digest.bpmn — collect-digests, send-digest; to-be-preparation.bpmn — check-confirmation-needed,
// request-confirmation, create-escalation, notify-all-admins; to-be-guide-search.bpmn — create-escalation.
// Состояние — в таблицах, а не в памяти: после перезапуска проходы продолжают с того же места (NFR-03).
import { params } from './db.mjs';
import { enqueue } from './outbox.mjs';
import { addDays, addMs, atMsk, max, mskDate, outOfQuiet, parseDuration, quiet } from './time.mjs';
import * as D from './domain.mjs';
import * as T from './texts.mjs';

const dur = (p, code) => parseDuration(p[code]);

async function once(c, job, key, now) {
  const { rowCount } = await c.query('INSERT INTO dispatch.job_run (job, run_key, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [job, key, now]);
  return rowCount === 1;
}

async function groupsOn(c, date, statuses) {
  const { rows } = await c.query(
    `SELECT g.*, r.name AS route_name, r.meeting_point, gd.telegram_chat_id AS guide_chat
       FROM dispatch.excursion_group g
       JOIN dispatch.booking b ON b.id = g.booking_id JOIN dispatch.route r ON r.id = b.route_id
       JOIN dispatch.guide gd ON gd.id = g.guide_id
      WHERE g.status = ANY($2) AND (g.starts_at AT TIME ZONE 'Europe/Moscow')::date = $1::date
        AND gd.status = 'ACTIVE' AND gd.bot_blocked_at IS NULL
      ORDER BY g.guide_id, g.starts_at`, [date, statuses]);
  return rows;
}

const byGuide = (rows) => rows.reduce((m, g) => m.set(g.guide_id, [...(m.get(g.guide_id) ?? []), g]), new Map());

// Запрос подтверждения: за P-07 до первой группы дня, из тихих часов — в 07:00 (BR-13)
function requestTime(first, p) {
  return outOfQuiet(addMs(first.starts_at, -dur(p, 'P-07')), quiet(p['P-09']));
}
const deadlineOf = (g, requestedAt, p) => max(addMs(g.starts_at, -dur(p, 'P-08')), addMs(requestedAt, dur(p, 'P-25')));

// Запрос приходит со сводкой накануне, если после 07:00 на ответ остаётся меньше P-25 (BR-13, F-26)
function needsEveningRequest(first, p) {
  return first.starts_at - requestTime(first, p) < dur(p, 'P-25');
}

export async function collectDigests(c, now) {
  const p = await params(c);
  const today = mskDate(now);
  if (now < atMsk(today, p['P-06'])) return 0;
  if (!(await once(c, 'collect-digests', today, now))) return 0;
  const tomorrow = addDays(today, 1);
  const q = quiet(p['P-09']);
  let sent = 0;
  for (const [guideId, groups] of byGuide(await groupsOn(c, tomorrow, ['ASSIGNED', 'CONFIRMED']))) {
    // send-digest: одна сводка на гида, без звука, до начала тихих часов (BR-11, NFR-08)
    const expires = atMsk(today, q.start);
    const id = await enqueue(c, { chatId: groups[0].guide_chat, dedupKey: `digest:${guideId}:${tomorrow}`, body: T.digest(tomorrow, groups), at: now, expiresAt: expires });
    if (id) sent += 1;
    const unconfirmed = groups.filter((g) => g.status === 'ASSIGNED');
    if (unconfirmed.length && needsEveningRequest(unconfirmed[0], p)) {
      const { rowCount } = await c.query(
        'INSERT INTO dispatch.confirmation_request (guide_id, day, requested_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [guideId, tomorrow, now]);
      if (rowCount) {
        const deadline = deadlineOf(unconfirmed[0], now, p);
        await enqueue(c, { chatId: groups[0].guide_chat, dedupKey: `confirm:${guideId}:${tomorrow}`, body: T.confirmRequest(unconfirmed, deadline),
          at: now, expiresAt: unconfirmed[0].starts_at, groupId: unconfirmed[0].id, assignmentId: unconfirmed[0].assignment_id });
      }
    }
  }
  return sent;
}

// NFR-16: сводка не ушла к P-06 + 5 мин — тревога всем администраторам по резервному каналу
export async function digestWatchdog(c, now) {
  const p = await params(c);
  const today = mskDate(now);
  if (now < addMs(atMsk(today, p['P-06']), 5 * 60e3)) return;
  const tomorrow = addDays(today, 1);
  const { rows: [r] } = await c.query(
    `SELECT count(*) FILTER (WHERE status <> 'SENT') AS unsent, count(*) AS total FROM dispatch.notification WHERE dedup_key LIKE $1`,
    [`digest:%:${tomorrow}`]);
  const collected = (await c.query("SELECT 1 FROM dispatch.job_run WHERE job = 'collect-digests' AND run_key = $1", [today])).rowCount > 0;
  const expected = (await groupsOn(c, tomorrow, ['ASSIGNED', 'CONFIRMED'])).length > 0;
  if ((Number(r.unsent) > 0 || (!collected && expected)) && (await once(c, 'digest-watchdog', today, now))) {
    await D.alarmAll(c, now, 'DIGEST_NOT_SENT', `Сводки на завтра не отправлены: ${r.unsent} из ${r.total}. Разошлите вручную по инструкции ручного режима`);
  }
}

// check-confirmation-needed + request-confirmation: один запрос на гида и день (BR-13, D-15)
export async function requestConfirmations(c, now) {
  const p = await params(c);
  const today = mskDate(now);
  let sent = 0;
  for (const day of [today, addDays(today, 1)]) {
    for (const [guideId, groups] of byGuide(await groupsOn(c, day, ['ASSIGNED', 'CONFIRMED']))) {
      if (groups.some((g) => g.status === 'CONFIRMED')) continue;          // выход на этот день уже подтверждён
      const unconfirmed = groups.filter((g) => g.starts_at > now);
      if (!unconfirmed.length) continue;
      const first = unconfirmed[0];
      if (now < requestTime(first, p)) continue;
      const { rowCount } = await c.query(
        'INSERT INTO dispatch.confirmation_request (guide_id, day, requested_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [guideId, day, now]);
      if (!rowCount) continue;
      await enqueue(c, { chatId: first.guide_chat, dedupKey: `confirm:${guideId}:${day}`, body: T.confirmRequest(unconfirmed, deadlineOf(first, now, p)),
        at: now, expiresAt: first.starts_at, urgentFor: first.starts_at, groupId: first.id, assignmentId: first.assignment_id });
      sent += 1;
    }
  }
  return sent;
}

// create-escalation «Нет подтверждения»: срок прошёл, а группа ещё не подтверждена
export async function confirmationDeadlines(c, now) {
  const p = await params(c);
  const { rows } = await c.query(
    `SELECT g.id, g.assignment_id, g.starts_at, cr.requested_at
       FROM dispatch.excursion_group g
       JOIN dispatch.confirmation_request cr ON cr.guide_id = g.guide_id
        AND cr.day = (g.starts_at AT TIME ZONE 'Europe/Moscow')::date
      WHERE g.status = 'ASSIGNED' AND g.starts_at > $1`, [now]);
  for (const g of rows) {
    if (now >= deadlineOf(g, g.requested_at, p)) await D.openEscalation(c, now, { reason: 'NO_CONFIRMATION', groupId: g.id, assignmentId: g.assignment_id });
  }
}

// create-escalation «Гид не найден»: срок поиска BR-08 прошёл, группа в том же раунде
export async function searchDeadlines(c, now) {
  const { rows } = await c.query(
    `SELECT t.*, g.status, g.search_round AS current_round FROM dispatch.search_timer t
       JOIN dispatch.excursion_group g ON g.id = t.group_id
      WHERE t.escalated_at IS NULL AND t.due_at <= $1`, [now]);
  for (const t of rows) {
    if (t.status === 'SEARCHING' && t.current_round === t.search_round) await D.openEscalation(c, now, { reason: 'NO_GUIDE', groupId: t.group_id });
    await c.query('UPDATE dispatch.search_timer SET escalated_at = $3 WHERE group_id = $1 AND search_round = $2', [t.group_id, t.search_round, now]);
  }
}

// notify-all-admins: дежурный не взял эскалацию в работу за P-16 (BR-25)
export async function escalateToAll(c, now) {
  const p = await params(c);
  const { rows } = await c.query(
    `SELECT * FROM dispatch.escalation WHERE status = 'OPEN' AND sent_to_all_at IS NULL AND opened_at <= $1`, [addMs(now, -dur(p, 'P-16'))]);
  for (const e of rows) {
    await c.query('UPDATE dispatch.escalation SET sent_to_all_at = $2 WHERE id = $1', [e.id, now]);
    const g = e.group_id ? await D.loadGroup(c, e.group_id) : null;
    await D.notifyAdmins(c, now, T.escalation(e, g), `esc-all:${e.id}`, g?.starts_at ?? null);
  }
}

// BR-21: «Подтвердить новое время» не нажато за P-13 — группа возвращается в поиск
export async function newTimeDeadlines(c, now) {
  const { rows } = await c.query(
    `SELECT r.* FROM dispatch.new_time_request r JOIN dispatch.excursion_group g ON g.id = r.group_id AND g.assignment_id = r.assignment_id
      WHERE r.closed_at IS NULL AND r.due_at <= $1`, [now]);
  for (const r of rows) {
    await D.unassignGuide(c, now, { groupId: r.group_id, reason: 'Гид не подтвердил новое время', why: 'Вы не подтвердили новое время, группа возвращена в поиск' });
  }
}

// BR-36: этап «Проведена» не поменяли — через P-18 после окончания группа проведена, заявка в «Требует внимания»
export async function autoComplete(c, now) {
  const p = await params(c);
  const { rows } = await c.query(
    `UPDATE dispatch.excursion_group SET status = 'COMPLETED'
      WHERE status IN ('ASSIGNED', 'CONFIRMED') AND ends_at <= $1 RETURNING booking_id`, [addMs(now, -dur(p, 'P-18'))]);
  for (const r of rows) {
    await c.query(
      `INSERT INTO dispatch.attention (booking_id, reason, detail, created_at) VALUES ($1, 'AUTO_COMPLETED', $2, $3) ON CONFLICT DO NOTHING`,
      [r.booking_id, 'Экскурсия прошла, а этап сделки в amoCRM не «Проведена»', now]);
  }
}

// NFR-10: обезличивание клиента через P-20 после экскурсии, тело вебхука стирается через P-27
export async function retention(c, now) {
  const p = await params(c);
  await c.query(
    `UPDATE dispatch.client cl SET full_name = NULL, phone_e164 = NULL, anonymized_at = $1
      WHERE anonymized_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM dispatch.booking b JOIN dispatch.excursion_group g ON g.booking_id = b.id
         WHERE b.client_id = cl.id AND g.ends_at > $2)
        AND EXISTS (SELECT 1 FROM dispatch.booking b WHERE b.client_id = cl.id)`, [now, addMs(now, -dur(p, 'P-20'))]);
  await c.query('UPDATE dispatch.inbound_event SET payload = NULL WHERE payload IS NOT NULL AND processed_at <= $1', [addMs(now, -dur(p, 'P-27'))]);
}

// NFR-16: очередь не отправляет дольше 5 минут — тревога по резервному каналу, не чаще раза в час
export async function queueWatchdog(c, now) {
  const { rows: [r] } = await c.query(
    "SELECT count(*) AS stuck FROM dispatch.notification WHERE status = 'QUEUED' AND scheduled_at <= $1", [addMs(now, -5 * 60e3)]);
  if (Number(r.stuck) > 0 && (await once(c, 'queue-watchdog', now.toISOString().slice(0, 13), now))) {
    await D.alarmAll(c, now, 'QUEUE_STALLED', `Очередь не отправляет сообщения больше 5 минут: ${r.stuck} ждут отправки`);
  }
}

export const SWEEPS = [
  ['collect-digests', collectDigests],
  ['request-confirmation', requestConfirmations],
  ['create-escalation:no-confirmation', confirmationDeadlines],
  ['create-escalation:no-guide', searchDeadlines],
  ['notify-all-admins', escalateToAll],
  ['new-time-deadline', newTimeDeadlines],
  ['auto-complete', autoComplete],
  ['retention', retention],
];
export const WATCHDOGS = [['digest-watchdog', digestWatchdog], ['queue-watchdog', queueWatchdog]];
