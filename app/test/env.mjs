// Тестовое окружение: своя база на файл тестов, подмены Telegram и amoCRM, управляемые часы.
// Каждый ответ API сверяется с контрактом (contract.mjs), поэтому тест падает и на нарушении OpenAPI.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createDb } from '../src/db.mjs';
import { migrate } from '../src/migrate.mjs';
import { checkResponse } from './contract.mjs';
import { fakeAmo, fakeTelegram } from './fakes.mjs';

const SERVER = process.env.TEST_PG ?? 'postgres://postgres:postgres@localhost:5432';
let dbSeq = 0;

export const ADMIN_TOKEN = 'test-admin-token';
export const ADMIN_TG = 9001;
export const ADMIN2_TG = 9002;
export const AMO_SECRET = 'amo-secret-0123456789abcdef0123456789ab';
export const TG_SECRET = 'tg-secret-0123456789';
export const ROUTE = 'Обзорная по Иннополису';
export const SHORT_ROUTE = 'Короткая по центру'; // 1,5 ч: две группы в 10:00 и 12:00 не пересекаются с буфером 30 мин

export async function createEnv({ start = '2026-12-01T10:00:00+03:00' } = {}) {
  const name = `ed_test_${process.pid}_${dbSeq++}`;
  const admin = new pg.Client({ connectionString: `${SERVER}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = `${SERVER}/${name}`;
  await migrate(url);
  const db = createDb(url);

  let t = Date.parse(start);
  const clock = {
    now: () => new Date(t),
    set: (s) => { t = Date.parse(s); },
    advance: (ms) => { t += ms; },
  };

  const { rows: [a1] } = await db.query("INSERT INTO dispatch.admin (full_name, telegram_user_id) VALUES ('Старший администратор', $1) RETURNING id", [ADMIN_TG]);
  await db.query("INSERT INTO dispatch.admin (full_name, telegram_user_id) VALUES ('Администратор смены', $1)", [ADMIN2_TG]);
  const { rows: [route] } = await db.query(
    `INSERT INTO dispatch.route (name, duration, meeting_point, meeting_point_map_url)
     VALUES ($1, '2 hours', 'Площадь у вокзала', 'https://yandex.ru/maps/?pt=48.75,55.75') RETURNING id`, [ROUTE]);
  const { rows: [short] } = await db.query(
    `INSERT INTO dispatch.route (name, duration, meeting_point, meeting_point_map_url)
     VALUES ($1, '90 minutes', 'Сквер у Технопарка', 'https://yandex.ru/maps/?pt=48.74,55.75') RETURNING id`, [SHORT_ROUTE]);
  for (const r of [route, short]) {
    for (const [cat, price] of [['ADULT', 1000], ['CHILD', 500], ['DISCOUNTED', 700]]) {
      await db.query("INSERT INTO dispatch.tariff (route_id, category, price, valid) VALUES ($1, $2, $3, '[2026-01-01,2027-12-31]')", [r.id, cat, price]);
    }
  }

  const tg = await fakeTelegram();
  const fields = loadConfig().amocrm.fields;
  const amo = await fakeAmo({ fields });
  const cfg = loadConfig({
    adminTokens: { [ADMIN_TOKEN]: a1.id },
    telegram: { apiBase: tg.base, token: 'TEST', webhookSecret: TG_SECRET, botUsername: 'inno_dispatch_bot', perChatIntervalMs: 0, timeoutMs: 2000 },
    amocrm: { apiBase: amo.base, token: 'AMO', webhookSecret: AMO_SECRET, subdomain: 'inno-tours', fields, statuses: { cancelled: 143, completed: 142 } },
    telephony: { proxyPhone: '+78005550100' },
  });
  const quiet = { error() {}, log() {} };
  const app = createApp({ cfg, db, clock, log: process.env.DEBUG ? console : quiet });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;

  // Запрос к API панели с проверкой по контракту. key: false — без Idempotency-Key
  async function api(method, path, { body, key = method === 'GET' ? false : randomUUID(), ifMatch, token = ADMIN_TOKEN } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    if (ifMatch) headers['If-Match'] = ifMatch;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    const operation = checkResponse(method, path, res.status, res.headers, data);
    return { status: res.status, headers: res.headers, body: data, operation, key };
  }

  let updateId = 1;
  const bot = {
    async update(u) {
      const res = await fetch(`${base}/integrations/telegram/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': TG_SECRET }, body: JSON.stringify(u),
      });
      checkResponse('POST', '/integrations/telegram/webhook', res.status, res.headers, null);
      await app.deliver();
      return res.status;
    },
    press: (userId, data) => bot.update({ update_id: updateId++, callback_query: { id: `cq${updateId}`, from: { id: userId }, message: { chat: { id: userId } }, data } }),
    say: (userId, text, from = {}) => bot.update({ update_id: updateId++, message: { message_id: updateId, chat: { id: userId }, from: { id: userId, ...from }, text } }),
    contact: (userId, phone) => bot.update({ update_id: updateId++, message: { message_id: updateId, chat: { id: userId }, from: { id: userId }, contact: { phone_number: phone, user_id: userId } } }),
    nextUpdateId: () => updateId++,
  };

  // Вебхук amoCRM в формате x-www-form-urlencoded
  async function amoWebhook(action, id, lastModified, { secret = AMO_SECRET, subdomain = 'inno-tours' } = {}) {
    const form = new URLSearchParams({ [`leads[${action}][0][id]`]: String(id), [`leads[${action}][0][last_modified]`]: String(lastModified), 'account[subdomain]': subdomain });
    const res = await fetch(`${base}/integrations/amocrm/webhook/${secret}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    checkResponse('POST', `/integrations/amocrm/webhook/${secret}`, res.status, res.headers, null);
    return res.status;
  }

  // Подключённый гид: активен, согласие дано, Telegram-чат известен
  let guideSeq = 0;
  async function addGuide(fullName, { tg: tgId = 7000 + guideSeq, phone = `+7999000${String(1000 + guideSeq).slice(-4)}` } = {}) {
    guideSeq += 1;
    const { rows: [g] } = await db.query(
      `INSERT INTO dispatch.guide (full_name, phone_e164, telegram_user_id, telegram_chat_id, status, phone_share_consent_at)
       VALUES ($1, $2, $3, $3, 'ACTIVE', now()) RETURNING *`, [fullName, phone, tgId]);
    return { ...g, tg: tgId };
  }

  // Шаг планировщика в заданный момент
  async function at(s) {
    if (s) clock.set(s);
    await app.tick();
  }

  // Заявка из amoCRM целиком: сделка в CRM, вебхук, обработка
  let leadSeq = 7551100;
  async function crmBooking(opts = {}) {
    const id = opts.id ?? leadSeq++;
    const updatedAt = opts.updatedAt ?? clock.now().getTime();
    amo.lead({ id, updatedAt, ...opts, startsAt: Date.parse(opts.startsAt) });
    await amoWebhook(opts.action ?? 'add', id, Math.floor(updatedAt / 1000));
    await app.tick();
    const { rows: [b] } = await db.query("SELECT * FROM dispatch.booking WHERE source = 'AMOCRM' AND external_id = $1", [id]);
    const groups = b ? (await db.query('SELECT * FROM dispatch.excursion_group WHERE booking_id = $1 ORDER BY seq', [b.id])).rows : [];
    return { id, booking: b, groups };
  }

  const group = async (id) => (await db.query('SELECT * FROM dispatch.excursion_group WHERE id = $1', [id])).rows[0];
  const escalations = async (where = 'true', args = []) => (await db.query(`SELECT * FROM dispatch.escalation WHERE ${where} ORDER BY opened_at`, args)).rows;

  // Назначить гида через API, как это делает панель: версия — с доски
  async function assign(groupId, guideId, opts = {}) {
    const g = await group(groupId);
    return api('PUT', `/v1/groups/${groupId}/assignment`, { body: { guideId }, ifMatch: `"v${g.version}"`, ...opts });
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await app.close();
    await db.end();
    await tg.close();
    await amo.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }

  return { db, clock, app, api, bot, tg, amo, amoWebhook, addGuide, at, crmBooking, group, escalations, assign, close, cfg, base, routeId: route.id, adminId: a1.id };
}

export const texts = (msgs) => msgs.map((m) => m.text);
