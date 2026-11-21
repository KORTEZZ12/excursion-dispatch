// API панели администратора (docs/api/openapi.yaml) и приём вебхуков.
// Изменяющие запросы требуют Idempotency-Key: повтор возвращает сохранённый ответ первого выполнения до проверки If-Match.
import { createHash, randomBytes } from 'node:crypto';
import { params } from './db.mjs';
import { addMs, iso, isClock, parseDuration } from './time.mjs';
import { enqueue } from './outbox.mjs';
import { receiveWebhook } from './crm.mjs';
import * as D from './domain.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLES = {
  VALIDATION_ERROR: 'Ошибка в данных', UNAUTHORIZED: 'Нужно войти заново', NOT_FOUND: 'Не найдено',
  BOOKING_FROM_CRM: 'Измените заявку в amoCRM', GUIDE_BUSY: 'У гида группа в это время', GROUP_NOT_ASSIGNABLE: 'Группа уже закрыта',
  GUIDE_NOT_ACTIVE: 'Гид не подключён или деактивирован', VERSION_CONFLICT: 'Группу уже изменили, обновите страницу',
  PRECONDITION_REQUIRED: 'Нужны версия ресурса и ключ действия', PARAMETER_READ_ONLY: 'Этот параметр меняется только релизом',
  IDEMPOTENCY_KEY_REUSED: 'Этот ключ уже использован для другого действия',
};
const STATUS = {
  VALIDATION_ERROR: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, BOOKING_FROM_CRM: 409, GUIDE_BUSY: 409, GROUP_NOT_ASSIGNABLE: 409,
  GUIDE_NOT_ACTIVE: 422, VERSION_CONFLICT: 412, PRECONDITION_REQUIRED: 428, PARAMETER_READ_ONLY: 422, IDEMPOTENCY_KEY_REUSED: 422,
};

class Http extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

const problem = (code, extra, traceId) => ({
  status: STATUS[code],
  headers: { 'Content-Type': 'application/problem+json' },
  body: { type: `https://dispatch.tours.example/problems/${code.toLowerCase().replace(/_/g, '-')}`, title: TITLES[code], status: STATUS[code], code, ...extra, traceId },
});

// ---------------------------------------------------------------- представления

const guideRef = (g) => (g.guide_id ? { id: g.guide_id, fullName: g.guide_name, phone: g.guide_phone } : null);

function groupJson(g) {
  return {
    id: g.id, bookingId: g.booking_id, status: g.status, startsAt: iso(g.starts_at), endsAt: iso(g.ends_at),
    participants: g.participants, guide: guideRef(g), version: g.version, searchRound: g.search_round,
    confirmedAt: iso(g.confirmed_at), closedReason: g.closed_reason ?? null, partnerName: g.partner_name ?? null,
  };
}

async function bookingJson(c, id) {
  const { rows: [b] } = await c.query('SELECT * FROM dispatch.booking WHERE id = $1', [id]);
  if (!b) return null;
  const groups = await D.groupsOfBooking(c, id);
  return {
    id: b.id, source: b.source, externalId: b.external_id == null ? null : Number(b.external_id), status: b.status,
    routeId: b.route_id, startsAt: iso(b.starts_at), participants: b.participants, expectedAmount: b.expected_amount,
    groups: groups.map((g) => ({ id: g.id, seq: g.seq, participants: g.participants, status: g.status })),
    version: b.version, cancelReason: b.cancel_reason ?? null, crmResyncRequired: b.crm_resync_required,
  };
}

const guideJson = (g) => ({ id: g.id, fullName: g.full_name, phone: g.phone_e164, status: g.status, botBlocked: g.bot_blocked_at != null });
const escalationJson = (e) => ({
  id: e.id, groupId: e.group_id, assignmentId: e.assignment_id, bookingId: e.booking_id, reason: e.reason, status: e.status,
  openedAt: iso(e.opened_at), comment: e.comment, ackedBy: e.acked_by, ackedAt: iso(e.acked_at), resolvedAt: iso(e.resolved_at),
});

// ---------------------------------------------------------------- операции

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const need = (cond, field, message) => { if (!cond) throw new Http('VALIDATION_ERROR', { errors: [{ field, message }] }); };

export function createApi({ db, clock, cfg, bot }) {
  const routes = [];
  const route = (method, pattern, opts, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/\{\w+\}/g, '([^/]+)')}$`), opts, handler });

  route('GET', '/v1/board', {}, async ({ c, query }) => {
    const date = query.get('date');
    need(isDate(date), 'date', 'Дата в формате YYYY-MM-DD');
    const attention = query.get('attention') === 'true';
    const { rows } = await c.query(
      `SELECT g.*, r.name AS route_name, gd.full_name AS guide_name, gd.phone_e164 AS guide_phone,
              COALESCE((SELECT array_agg(e.reason ORDER BY e.opened_at) FROM dispatch.escalation e
                         WHERE e.group_id = g.id AND e.status <> 'RESOLVED'), '{}') AS open_escalations
         FROM dispatch.excursion_group g
         JOIN dispatch.booking b ON b.id = g.booking_id JOIN dispatch.route r ON r.id = b.route_id
         LEFT JOIN dispatch.guide gd ON gd.id = g.guide_id
        WHERE (g.starts_at AT TIME ZONE 'Europe/Moscow')::date = $1::date
        ORDER BY g.starts_at, b.id, g.seq`, [date]);
    // «Требуют внимания»: без гида, без подтверждения выхода, с открытой эскалацией (US-17)
    const groups = rows.filter((g) => !attention || g.status === 'SEARCHING' || g.status === 'ASSIGNED' || g.open_escalations.length);
    return {
      body: {
        date,
        groups: groups.map((g) => ({
          groupId: g.id, bookingId: g.booking_id, routeName: g.route_name, startsAt: iso(g.starts_at), participants: g.participants,
          status: g.status, guide: guideRef(g), version: g.version,                                          // для If-Match (находка M-04)
          windowEndsAt: iso(g.window_ends_at), noticeStatus: null,                                           // отписки — релиз 2
          openEscalations: g.open_escalations, routeOverlaps: [],                                            // US-27 — релиз 2
        })),
      },
    };
  });

  route('GET', '/v1/bookings/{id}', {}, async ({ c, args: [id] }) => {
    const b = UUID.test(id) ? await bookingJson(c, id) : null;
    if (!b) throw new Http('NOT_FOUND');
    return { body: b, headers: { ETag: `"v${b.version}"` } };
  });

  route('POST', '/v1/bookings/{id}/cancel', { idem: true }, async ({ c, now, args: [id], body }) => {
    if (!UUID.test(id)) throw new Http('NOT_FOUND');
    need(['CLIENT', 'WEATHER', 'GUIDE_ILLNESS', 'OTHER'].includes(body?.reason), 'reason', 'CLIENT, WEATHER, GUIDE_ILLNESS или OTHER');
    await D.cancelBooking(c, now, { bookingId: id, reason: body.reason, comment: body.comment ?? null, emergency: body.emergency === true });
    return { body: await bookingJson(c, id) };
  });

  async function groupForWrite(c, id, ifMatch) {
    if (!UUID.test(id)) throw new Http('NOT_FOUND');
    const g = await D.loadGroup(c, id, { lock: true });
    if (!g) throw new Http('NOT_FOUND');
    if (ifMatch !== `"v${g.version}"`) throw new Http('VERSION_CONFLICT');
    return g;
  }

  route('PUT', '/v1/groups/{id}/assignment', { idem: true, ifMatch: true }, async ({ c, now, args: [id], body, ifMatch }) => {
    need(UUID.test(body?.guideId ?? ''), 'guideId', 'Идентификатор гида');
    await groupForWrite(c, id, ifMatch);
    try {
      const g = await D.assignGuide(c, now, { groupId: id, guideId: body.guideId });
      return { body: groupJson(g), headers: { ETag: `"v${g.version}"` } };
    } catch (e) {
      if (e.code === 'GUIDE_BUSY') {
        throw new Http('GUIDE_BUSY', { overlaps: e.extra.overlaps.map((o) => ({ groupId: o.id, startsAt: iso(o.starts_at), routeName: o.route_name })) });
      }
      throw e;
    }
  });

  route('DELETE', '/v1/groups/{id}/assignment', { idem: true, ifMatch: true }, async ({ c, now, args: [id], query, ifMatch }) => {
    await groupForWrite(c, id, ifMatch);
    const reason = query.get('reason');
    need(!reason || reason.length <= 200, 'reason', 'Не длиннее 200 символов');
    const g = await D.unassignGuide(c, now, { groupId: id, reason: reason ?? 'Снят администратором' });
    return { body: groupJson(g), headers: { ETag: `"v${g.version}"` } };
  });

  route('GET', '/v1/groups/{id}/history', {}, async ({ c, args: [id] }) => {
    if (!UUID.test(id) || !(await D.loadGroup(c, id))) throw new Http('NOT_FOUND');
    const { rows } = await c.query('SELECT * FROM dispatch.group_event WHERE group_id = $1 ORDER BY id', [id]);
    return { body: rows.map((e) => ({ at: iso(e.at), actor: e.actor, fromStatus: e.from_status, toStatus: e.to_status, guideId: e.guide_id, fromGuideId: e.from_guide_id, reason: e.reason })) };
  });

  route('GET', '/v1/escalations', {}, async ({ c, query }) => {
    const status = query.get('status');
    need(!status || ['OPEN', 'ACKED', 'RESOLVED'].includes(status), 'status', 'OPEN, ACKED или RESOLVED');
    const { rows } = await c.query('SELECT * FROM dispatch.escalation WHERE $1::text IS NULL OR status = $1 ORDER BY opened_at DESC', [status]);
    return { body: rows.map(escalationJson) };
  });

  async function escalationForWrite(c, id) {
    if (!UUID.test(id)) throw new Http('NOT_FOUND');
    const { rows: [e] } = await c.query('SELECT * FROM dispatch.escalation WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw new Http('NOT_FOUND');
    return e;
  }

  route('POST', '/v1/escalations/{id}/ack', { idem: true }, async ({ c, now, args: [id], admin }) => {
    const e = await escalationForWrite(c, id);
    if (e.status !== 'OPEN') return { body: escalationJson(e) };
    const { rows: [u] } = await c.query("UPDATE dispatch.escalation SET status = 'ACKED', acked_by = $2, acked_at = $3 WHERE id = $1 RETURNING *", [id, admin, now]);
    return { body: escalationJson(u) };
  });

  route('POST', '/v1/escalations/{id}/resolve', { idem: true }, async ({ c, now, args: [id], admin, body }) => {
    need(typeof body?.comment === 'string' && body.comment.trim().length >= 3, 'comment', 'Комментарий — не короче 3 символов');
    const e = await escalationForWrite(c, id);
    if (e.status === 'RESOLVED') return { body: escalationJson(e) };
    const { rows: [u] } = await c.query(
      `UPDATE dispatch.escalation SET status = 'RESOLVED', resolved_by = $2, resolved_at = $3, comment = $4,
              acked_by = COALESCE(acked_by, $2), acked_at = COALESCE(acked_at, $3) WHERE id = $1 RETURNING *`, [id, admin, now, body.comment.trim()]);
    return { body: escalationJson(u) };
  });

  route('GET', '/v1/guides', {}, async ({ c, query }) => {
    const groupId = query.get('freeForGroup');
    if (groupId) {
      const g = UUID.test(groupId) ? await D.loadGroup(c, groupId) : null;
      need(g, 'freeForGroup', 'Нет такой группы');
      return { body: (await D.freeGuides(c, g)).map(guideJson) };
    }
    const { rows } = await c.query("SELECT * FROM dispatch.guide ORDER BY status = 'PENDING_APPROVAL' DESC, full_name");
    return { body: rows.map(guideJson) };
  });

  route('POST', '/v1/guide-invitations', { idem: true }, async ({ c, now, admin }) => {
    const p = await params(c);
    const token = `inv_${randomBytes(15).toString('base64url')}`;
    const expiresAt = addMs(now, parseDuration(p['P-17']));
    await c.query('INSERT INTO dispatch.guide_invitation (token, created_by, expires_at) VALUES ($1, $2, $3)', [token, admin, expiresAt]);
    return { status: 201, body: { link: `https://t.me/${cfg.telegram.botUsername}?start=${token}`, expiresAt: iso(expiresAt) } };
  });

  route('POST', '/v1/guides/{id}/approve', { idem: true }, async ({ c, now, args: [id] }) => {
    if (!UUID.test(id)) throw new Http('NOT_FOUND');
    const { rows: [g] } = await c.query('SELECT * FROM dispatch.guide WHERE id = $1 FOR UPDATE', [id]);
    if (!g) throw new Http('NOT_FOUND');
    if (g.status === 'PENDING_APPROVAL') {
      await c.query("UPDATE dispatch.guide SET status = 'ACTIVE' WHERE id = $1", [id]);
      await enqueue(c, { chatId: g.telegram_chat_id, dedupKey: `approved:${id}:${now.getTime()}`, at: now, expiresAt: addMs(now, 24 * 3600e3),
        body: { text: 'Подключение подтверждено. Назначенные группы будут приходить сюда', reply_markup: { inline_keyboard: [[{ text: 'Мои группы', callback_data: 'mine' }]] } } });
    }
    const { rows: [u] } = await c.query('SELECT * FROM dispatch.guide WHERE id = $1', [id]);
    return { body: guideJson(u) };
  });

  route('POST', '/v1/guides/{id}/deactivate', { idem: true }, async ({ c, now, args: [id] }) => {
    if (!UUID.test(id)) throw new Http('NOT_FOUND');
    const r = await D.deactivateGuide(c, now, { guideId: id });
    return { body: { guide: guideJson(r.guide), returnedToSearch: r.returnedToSearch } };
  });

  route('PUT', '/v1/parameters/{code}', { idem: true }, async ({ c, args: [code], body }) => {
    if (['P-01', 'P-06'].includes(code)) throw new Http('PARAMETER_READ_ONLY');
    const { rows: [current] } = await c.query('SELECT * FROM dispatch.parameter WHERE code = $1', [code]);
    need(current, 'code', 'Нет такого параметра');
    const v = body?.value;
    const ok = typeof v === 'string' && (current.value.startsWith('P')
      ? (() => { try { return parseDuration(v) > 0; } catch { return false; } })()
      : current.value.includes('/') ? v.split('/').length === 2 && v.split('/').every(isClock) : isClock(v));
    need(ok, 'value', current.value.startsWith('P') ? 'Длительность ISO 8601, например PT10M' : 'Время в формате HH:MM');
    await c.query('UPDATE dispatch.parameter SET value = $2, updated_at = now() WHERE code = $1', [code, v]);
    return { body: { code, value: v } };
  });

  // «Требует внимания»: заявки, которые не обработаны автоматически. В контракте 0.4 раздела не было (находка M-03)
  route('GET', '/v1/attention', {}, async ({ c }) => {
    const { rows } = await c.query('SELECT * FROM dispatch.attention WHERE resolved_at IS NULL ORDER BY created_at DESC');
    return { body: rows.map((a) => ({ id: a.id, bookingId: a.booking_id, externalId: a.external_id == null ? null : Number(a.external_id), reason: a.reason, detail: a.detail, createdAt: iso(a.created_at) })) };
  });

  // ---------------------------------------------------------------- исполнение

  async function idempotent(c, admin, key, hash, run) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${admin}:${key}`]);
    const { rows: [saved] } = await c.query(
      'SELECT * FROM dispatch.idempotency_key WHERE admin_id = $1 AND key = $2 AND created_at > $3', [admin, key, addMs(clock.now(), -24 * 3600e3)]);
    if (saved) {
      if (saved.request_hash !== hash) throw new Http('IDEMPOTENCY_KEY_REUSED');
      return { status: saved.status, headers: saved.headers, body: saved.body };
    }
    const res = await run();
    await c.query(
      `INSERT INTO dispatch.idempotency_key (admin_id, key, request_hash, status, headers, body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (admin_id, key) DO UPDATE SET request_hash = $3, status = $4, headers = $5, body = $6, created_at = $7`,
      [admin, key, hash, res.status, res.headers, JSON.stringify(res.body ?? null), clock.now()]);
    return res;
  }

  return async function handle(req, rawBody) {
    const traceId = randomBytes(16).toString('hex');
    const url = new URL(req.url, 'http://local');
    const now = clock.now();

    if (req.method === 'POST' && url.pathname.startsWith('/integrations/amocrm/webhook/')) {
      const r = await receiveWebhook(db, cfg.amocrm, now, decodeURIComponent(url.pathname.split('/').pop()), rawBody);
      return { status: r.status, headers: {}, body: null };
    }
    if (req.method === 'POST' && url.pathname === '/integrations/telegram/webhook') {
      if (!cfg.telegram.webhookSecret || req.headers['x-telegram-bot-api-secret-token'] !== cfg.telegram.webhookSecret) return { status: 401, headers: {}, body: null };
      let update;
      try { update = JSON.parse(rawBody); } catch { return { status: 200, headers: {}, body: null }; }
      if (Number.isInteger(update?.update_id)) await bot(update);
      return { status: 200, headers: {}, body: null };
    }

    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return { status: 404, headers: {}, body: { error: 'Нет такого адреса' } };
    try {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const admin = token && cfg.adminTokens[token];
      if (!admin) throw new Http('UNAUTHORIZED');
      const key = req.headers['idempotency-key'];
      const ifMatch = req.headers['if-match'];
      if (r.opts.idem && (!UUID.test(key ?? '') || (r.opts.ifMatch && !ifMatch))) throw new Http('PRECONDITION_REQUIRED');
      let body = null;
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch { throw new Http('VALIDATION_ERROR', { errors: [{ field: 'body', message: 'Тело — не JSON' }] }); }
      }
      const ctx = { now, admin, body, ifMatch, query: url.searchParams, args: r.re.exec(url.pathname).slice(1).map(decodeURIComponent) };
      const res = await db.tx(async (c) => {
        const exec = async () => {
          try {
            const out = await r.handler({ ...ctx, c });
            return { status: out.status ?? 200, headers: { 'Content-Type': 'application/json', ...(out.headers ?? {}) }, body: out.body };
          } catch (e) {
            if (e instanceof Http || e instanceof D.DomainError) {
              const p = problem(e.code, e.extra?.overlaps ? { overlaps: e.extra.overlaps } : e.extra?.errors ? { errors: e.extra.errors } : {}, traceId);
              if (r.opts.idem && e.code !== 'VERSION_CONFLICT') return p;   // бизнес-отказ запоминается под ключом, конфликт версий — нет
              throw e;
            }
            throw e;
          }
        };
        if (!r.opts.idem) return exec();
        const hash = createHash('sha256').update(`${req.method} ${url.pathname} ${url.search} ${rawBody}`).digest('hex');
        return idempotent(c, admin, key, hash, exec);
      }, { actor: `ADMIN:${admin}` });
      return res;
    } catch (e) {
      if (e instanceof Http || e instanceof D.DomainError) return problem(e.code, e.extra?.errors ? { errors: e.extra.errors } : {}, traceId);
      throw e;
    }
  };
}

