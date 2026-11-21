// Заявки из amoCRM (US-01, ADR-001). Вебхук — сигнал: тело сохраняется как есть и сразу 200,
// сделка потом берётся из API. События одной сделки применяются строго по очереди.
import { CrmUnavailable } from './clients.mjs';
import { addMs, mskDate } from './time.mjs';
import * as D from './domain.mjs';

const ACTIONS = { add: 'add', update: 'update', status: 'status', delete: 'delete', restore: 'restore' };
const RETRY = [60e3, 5 * 60e3, 15 * 60e3]; // повтор через 1, 5 и 15 мин, затем алерт

// Приём вебхука. Неверный секрет — 404; чужой аккаунт — 200, но событие не сохраняется (NFR-09)
export async function receiveWebhook(db, cfg, now, secret, rawBody) {
  if (!cfg.webhookSecret || secret !== cfg.webhookSecret) return { status: 404, stored: 0 };
  const form = new URLSearchParams(rawBody);
  if (cfg.subdomain && form.get('account[subdomain]') !== cfg.subdomain) return { status: 200, stored: 0 };
  let stored = 0;
  for (const [key, value] of form) {
    const m = /^leads\[(\w+)\]\[(\d+)\]\[id\]$/.exec(key);
    if (!m || !ACTIONS[m[1]]) continue;
    const [, action, i] = m;
    const version = form.get(`leads[${action}][${i}][last_modified]`) ?? form.get(`leads[${action}][${i}][updated_at]`)
      ?? form.get(`leads[${action}][${i}][date_create]`) ?? '0';
    const { rowCount } = await db.query(
      'INSERT INTO dispatch.inbound_event (dedup_key, received_at, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [`amocrm:lead:${value}:${action}:${version}`, now, rawBody]);
    stored += rowCount;
  }
  return { status: 200, stored };
}

const field = (lead, id) => lead.custom_fields_values?.find((f) => f.field_id === id)?.values?.[0]?.value;
const hasField = (lead, id) => lead.custom_fields_values?.some((f) => f.field_id === id) ?? false;

// Телефон к E.164: 8XXXXXXXXXX → +7XXXXXXXXXX, иностранные — как есть, с «+» (F-30)
export function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  let e = digits;
  if (/^8\d{10}$/.test(digits)) e = `+7${digits.slice(1)}`;
  else if (/^7\d{10}$/.test(digits)) e = `+${digits}`;
  else if (!digits.startsWith('+')) e = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(e) ? e : null;
}

const PAYMENT = { наличные: 'CASH', 'наличными': 'CASH', cash: 'CASH', перевод: 'TRANSFER', 'переводом': 'TRANSFER', transfer: 'TRANSFER' };
const MESSENGER = { telegram: 'TELEGRAM', телеграм: 'TELEGRAM', whatsapp: 'WHATSAPP', max: 'MAX' };

// Маппинг сделки (integrations/amocrm.md). Возвращает заявку или список недостающих полей
export function mapLead(lead, contact, cfg) {
  const f = cfg.fields;
  const missing = [];
  const startsUnix = Number(field(lead, f.startsAt));
  if (!startsUnix) missing.push('Дата и время экскурсии');
  const routeName = field(lead, f.route);
  if (!routeName) missing.push('Маршрут');
  let adults, children, discounted;
  if ([f.adults, f.children, f.discounted].some((id) => hasField(lead, id))) {
    adults = Number(field(lead, f.adults) ?? 0);
    children = Number(field(lead, f.children) ?? 0);
    discounted = Number(field(lead, f.discounted) ?? 0);
  } else {
    // Переходное правило: полей категорий в CRM ещё нет, «Число участников» — взрослые (F-07)
    adults = Number(field(lead, f.participants) ?? 0);
    children = 0;
    discounted = 0;
  }
  const payment = PAYMENT[String(field(lead, f.payment) ?? '').trim().toLowerCase()];
  if (!payment) missing.push('Оплата');
  const messenger = MESSENGER[String(field(lead, f.messenger) ?? '').trim().toLowerCase()] ?? 'TELEGRAM';
  const phoneRaw = contact?.custom_fields_values?.find((x) => x.field_code === 'PHONE')?.values?.[0]?.value;
  const phone = toE164(phoneRaw);
  if (!phone) missing.push('Телефон клиента');
  const status = lead.status_id === cfg.statuses.cancelled ? 'CANCELLED' : lead.status_id === cfg.statuses.completed ? 'COMPLETED' : 'ACTIVE';
  return {
    missing,
    externalId: Number(lead.id),
    updatedAt: new Date(Number(lead.updated_at) * 1000),
    startsAt: startsUnix ? new Date(startsUnix * 1000) : null,
    routeName, adults, children, discounted, payment, messenger,
    price: Number(lead.price ?? 0),
    clientName: contact?.name ?? null,
    phone, status,
  };
}

async function attention(c, now, { bookingId = null, externalId = null, reason, detail }) {
  await c.query(
    `INSERT INTO dispatch.attention (booking_id, external_id, reason, detail, created_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [bookingId, externalId, reason, detail, now]);
}

// Применить сделку. Возвращает итог для журнала inbound_event
export async function applyLead(db, now, lead, contact, cfg) {
  const m = mapLead(lead, contact, cfg);
  return db.tx(async (c) => {
    const { rows: [b] } = await c.query(
      "SELECT * FROM dispatch.booking WHERE source = 'AMOCRM' AND external_id = $1 FOR UPDATE", [m.externalId]);
    if (b && m.updatedAt < b.external_updated_at) return 'STALE';   // старое состояние не перетирает новое (NFR-04)
    if (m.missing.length) {
      await attention(c, now, { bookingId: b?.id, externalId: m.externalId, reason: 'CRM_FIELDS_MISSING', detail: `Нет полей: ${m.missing.join(', ')}` });
      return 'ATTENTION';
    }
    const { rows: [route] } = await c.query('SELECT * FROM dispatch.route WHERE name = $1 AND active', [m.routeName]);
    if (!route) {
      await attention(c, now, { bookingId: b?.id, externalId: m.externalId, reason: 'ROUTE_NOT_FOUND', detail: `Маршрута «${m.routeName}» нет в справочнике` });
      await D.notifyAdmins(c, now, { text: `Заявка ${m.externalId} из amoCRM не обработана: маршрута «${m.routeName}» нет в справочнике диспетчера` }, `route-missing:${m.externalId}:${m.routeName}`);
      return 'ATTENTION';
    }
    const participants = m.adults + m.children + m.discounted;

    if (!b) {
      if (m.status !== 'ACTIVE') return 'IGNORED';
      if (participants < 1) {
        await attention(c, now, { externalId: m.externalId, reason: 'CRM_FIELDS_MISSING', detail: 'В заявке 0 участников' });
        return 'ATTENTION';
      }
      if (m.startsAt <= now) {
        await attention(c, now, { externalId: m.externalId, reason: 'START_IN_PAST', detail: 'Дата экскурсии в прошлом' });
        return 'ATTENTION';
      }
      // BR-32: сумма из сделки, а если её нет — по тарифу на дату создания заявки, фиксируется
      let amount = m.price > 0 ? m.price.toFixed(2) : null;
      if (!amount) {
        const { rows: [t] } = await c.query('SELECT dispatch.expected_amount($1, $2, $3, $4, $5) AS a',
          [route.id, mskDate(now), m.adults, m.children, m.discounted]);
        amount = t.a;
      }
      if (amount == null) {
        await attention(c, now, { externalId: m.externalId, reason: 'NO_TARIFF', detail: 'Нет тарифа на дату для категории участников' });
        return 'ATTENTION';
      }
      const { rows: [cl] } = await c.query(
        'INSERT INTO dispatch.client (full_name, phone_e164, messenger) VALUES ($1, $2, $3) RETURNING id', [m.clientName, m.phone, m.messenger]);
      const { rows: [{ r }] } = await c.query('SELECT dispatch.apply_crm_booking($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r',
        [m.externalId, m.updatedAt, cl.id, route.id, m.startsAt, m.adults, m.children, m.discounted, m.payment, amount]);
      const { rows: [nb] } = await c.query("SELECT id FROM dispatch.booking WHERE source = 'AMOCRM' AND external_id = $1", [m.externalId]);
      await D.syncGroups(c, now, nb.id);
      await c.query("UPDATE dispatch.attention SET resolved_at = $2 WHERE external_id = $1 AND resolved_at IS NULL AND booking_id IS NULL", [m.externalId, now]);
      return r;
    }

    // Аварийная отмена в панели: восстановление в CRM не применяется само (BR-04, F-11)
    if (b.status === 'CANCELLED' && m.status === 'ACTIVE' && b.crm_resync_required) {
      await attention(c, now, { bookingId: b.id, externalId: m.externalId, reason: 'RESYNC_CONFLICT', detail: 'Заявку отменили в панели аварийно, а в amoCRM она снова активна' });
      return 'ATTENTION';
    }
    if (b.status === 'CANCELLED' && m.status === 'CANCELLED' && b.crm_resync_required) {
      await c.query('UPDATE dispatch.booking SET crm_resync_required = false WHERE id = $1', [b.id]);   // отмену повторили в amoCRM
    }
    if (m.status === 'ACTIVE' && participants < 1) {
      await attention(c, now, { bookingId: b.id, externalId: m.externalId, reason: 'CRM_FIELDS_MISSING', detail: 'В заявке 0 участников' });
      return 'ATTENTION';
    }
    await c.query('UPDATE dispatch.client SET full_name = $2, phone_e164 = $3, messenger = $4 WHERE id = $1 AND anonymized_at IS NULL',
      [b.client_id, m.clientName, m.phone, m.messenger]);
    const amount = m.price > 0 ? m.price.toFixed(2) : b.expected_amount;
    const { rows: [{ r }] } = await c.query('SELECT dispatch.apply_crm_booking($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r',
      [m.externalId, m.updatedAt, b.client_id, route.id, m.startsAt, m.adults, m.children, m.discounted, m.payment, amount]);
    if (r === 'STALE') return 'STALE';

    if (m.status === 'CANCELLED') {
      if (b.status === 'ACTIVE') await D.cancelBooking(c, now, { bookingId: b.id, reason: 'CRM_CANCELLED', fromCrm: true });
      return b.status === 'ACTIVE' ? 'CANCELLED' : r;
    }
    if (m.status === 'COMPLETED') {
      await D.completeBooking(c, now, b.id);
      return 'COMPLETED';
    }
    let reactivated = false;
    if (b.status === 'CANCELLED') {
      // restore_lead: заявка снова активна, для неё создаются новые группы, отменённые остаются в истории
      await c.query("UPDATE dispatch.booking SET status = 'ACTIVE', cancel_reason = NULL, cancel_comment = NULL, version = version + 1 WHERE id = $1", [b.id]);
      reactivated = true;
    }
    if (reactivated) {
      await D.syncGroups(c, now, b.id);
      return 'RESTORED';
    }
    if (r === 'UNCHANGED') return r;
    if (m.startsAt.getTime() !== b.starts_at.getTime()) await D.rescheduleBooking(c, now, { bookingId: b.id, oldStart: b.starts_at });
    if (participants !== b.participants) await D.syncGroups(c, now, b.id);
    return r;
  });
}

async function applyDeleted(db, now, externalId) {
  return db.tx(async (c) => {
    const { rows: [b] } = await c.query("SELECT * FROM dispatch.booking WHERE source = 'AMOCRM' AND external_id = $1", [externalId]);
    if (!b) return 'IGNORED';
    if (b.status !== 'ACTIVE') return 'UNCHANGED';
    await D.cancelBooking(c, now, { bookingId: b.id, reason: 'CRM_DELETED', fromCrm: true });
    return 'CANCELLED';
  });
}

async function fetchLead(client, id) {
  const lead = await client.lead(id);
  if (!lead) return { lead: null, contact: null };
  const contactId = lead._embedded?.contacts?.[0]?.id;
  return { lead, contact: contactId ? await client.contact(contactId) : null };
}

// Обработка сохранённых событий по очереди. API amoCRM не ответил — событие ждёт повтора
export async function processInbound(db, client, cfg, clock) {
  let handled = 0;
  for (;;) {
    const now = clock.now();
    const { rows: [ev] } = await db.query(
      `SELECT * FROM dispatch.inbound_event WHERE processed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ORDER BY received_at, dedup_key LIMIT 1`, [now]);
    if (!ev) return handled;
    handled += 1;
    const [, , id, action] = ev.dedup_key.split(':');
    let result;
    try {
      if (action === 'delete') result = await applyDeleted(db, now, Number(id));
      else {
        const { lead, contact } = await fetchLead(client, id);
        result = lead ? await applyLead(db, now, lead, contact, cfg) : await applyDeleted(db, now, Number(id));
      }
    } catch (e) {
      if (!(e instanceof CrmUnavailable)) throw e;
      const attempts = ev.attempts + 1;
      await db.query('UPDATE dispatch.inbound_event SET attempts = $2, next_attempt_at = $3, result = $4 WHERE dedup_key = $1',
        [ev.dedup_key, attempts, addMs(now, RETRY[Math.min(attempts, RETRY.length) - 1]), `RETRY: ${e.message}`]);
      if (attempts === RETRY.length) {
        await db.tx((c) => D.notifyAdmins(c, now, { text: `amoCRM не отвечает: заявка ${id} ждёт обработки. Если её нужно отменить срочно — аварийная отмена в панели` }, `crm-down:${ev.dedup_key}`));
      }
      continue;
    }
    await db.query('UPDATE dispatch.inbound_event SET processed_at = $2, result = $3 WHERE dedup_key = $1', [ev.dedup_key, now, result]);
  }
}

// Сверка: сделки, изменённые с момента последней успешной сверки минус 5 минут (NFR-06)
export async function reconcile(db, client, cfg, clock) {
  const now = clock.now();
  const { rows: [s] } = await db.query('SELECT * FROM dispatch.crm_sync WHERE id = 1');
  const since = addMs(s.last_success_at ?? addMs(now, -24 * 3600e3), -5 * 60e3);
  await db.query('UPDATE dispatch.crm_sync SET last_run_at = $1 WHERE id = 1', [now]);
  let leads;
  try {
    leads = await client.leadsUpdatedSince(Math.floor(since / 1000));
  } catch (e) {
    if (e instanceof CrmUnavailable) return { ok: false, applied: [] };
    throw e;
  }
  const applied = [];
  for (const lead of leads) {
    const contactId = lead._embedded?.contacts?.[0]?.id;
    const contact = contactId ? await client.contact(contactId) : null;
    const r = await applyLead(db, now, lead, contact, cfg);
    applied.push({ id: lead.id, result: r });
  }
  await db.query('UPDATE dispatch.crm_sync SET last_success_at = $1 WHERE id = 1', [now]);
  return { ok: true, applied };
}

export async function crmDue(db, now) {
  const { rows: [s] } = await db.query('SELECT last_run_at FROM dispatch.crm_sync WHERE id = 1');
  return !s.last_run_at || now - s.last_run_at >= 15 * 60e3;
}
