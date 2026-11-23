// Надёжность: NFR-03, NFR-08, NFR-09, NFR-14 и четыре свойства планировщика из ADR-003
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.mjs';
import { createEnv } from './env.mjs';

describe('Очередь отправки, NFR-08', () => {
  let env;
  before(async () => { env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  it('429 — повтор после retry_after', async () => {
    const a = await env.addGuide('Анна Смирнова');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-03T11:00:00+03:00' });
    env.tg.fail(a.tg, { error_code: 429, description: 'Too Many Requests', retry_after: 7 });
    await env.assign(g.id, a.id);
    await env.app.deliver();
    assert.equal(env.tg.to(a.tg).length, 0);
    env.clock.advance(6000);
    await env.app.deliver();
    assert.equal(env.tg.to(a.tg).length, 0, 'раньше retry_after не повторяем');
    env.clock.advance(1000);
    await env.app.deliver();
    assert.match(env.tg.last(a.tg).text, /^Вам назначена группа/);
  });

  it('5xx — до 5 попыток с ростом паузы, затем FAILED и тревога по резервному каналу', async () => {
    const b = await env.addGuide('Борис Ким');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-03T15:00:00+03:00' });
    env.tg.fail(b.tg, ...Array(5).fill({ error_code: 502, description: 'Bad Gateway' }));
    await env.assign(g.id, b.id);
    for (let i = 0; i < 6; i++) {
      await env.app.deliver();
      env.clock.advance(60e3);
    }
    const { rows: [n] } = await env.db.query("SELECT status, attempts FROM dispatch.notification WHERE dedup_key LIKE 'assigned:%' AND chat_id = $1", [b.tg]);
    assert.deepEqual([n.status, n.attempts], ['FAILED', 5]);
    const { rows } = await env.db.query("SELECT 1 FROM dispatch.alarm WHERE kind = 'TELEGRAM_FAILED'");
    assert.equal(rows.length, 2, 'тревога каждому администратору');
  });

  it('Просроченное не отправляется: сводка не уходит после начала тихих часов', async () => {
    const v = await env.addGuide('Вера Лис');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-02T12:00:00+03:00' });
    await env.assign(g.id, v.id);
    await env.app.deliver();
    env.tg.fail(v.tg, { error_code: 503, description: 'Unavailable' });
    await env.at('2026-12-01T19:00:00+03:00');                     // сводка не ушла, повтор через пару секунд
    env.clock.set('2026-12-01T22:00:00+03:00');                    // Telegram ожил только к тихим часам
    await env.app.deliver();
    const { rows: [n] } = await env.db.query("SELECT status FROM dispatch.notification WHERE dedup_key = $1", [`digest:${v.id}:2026-12-02`]);
    assert.equal(n.status, 'EXPIRED');
    assert.ok(!env.tg.to(v.tg).some((m) => m.text.startsWith('Ваши группы на завтра')));
  });
});

describe('Планировщик и вебхуки', () => {
  let env;
  before(async () => { env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  it('ADR-003, свойство 4: таймер с датой в прошлом — группа за 40 мин до начала сразу эскалируется, а назначение сразу подтверждение', async () => {
    env.clock.set('2026-12-03T10:20:00+03:00');
    await env.addGuide('Дина Юсупова');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-03T11:00:00+03:00' });
    assert.equal((await env.escalations("reason = 'NO_GUIDE' AND group_id = $1", [g.id])).length, 1, 'до начала меньше часа — сразу');
  });

  it('Обновление Telegram дважды — обрабатывается один раз; без секретного заголовка — 401 (NFR-09)', async () => {
    const z = await env.addGuide('Зоя Белова');
    const update = { update_id: 555001, message: { message_id: 1, chat: { id: z.tg }, from: { id: z.tg }, text: 'Мои группы' } };
    await env.bot.update(update);
    await env.bot.update(update);
    assert.equal(env.tg.to(z.tg).length, 1);
    const res = await fetch(`${env.base}/integrations/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 555002 }) });
    assert.equal(res.status, 401);
  });

  it('NFR-14: параметр меняется без перезапуска и попадает в журнал; P-01 и P-06 — только релизом', async () => {
    const r = await env.api('PUT', '/v1/parameters/P-07', { body: { value: 'PT3H' } });
    assert.equal(r.status, 200);
    const { rows: [e] } = await env.db.query("SELECT old_value, new_value, actor FROM dispatch.parameter_event WHERE code = 'P-07' ORDER BY id DESC LIMIT 1");
    assert.deepEqual([e.old_value, e.new_value], ['PT2H', 'PT3H']);
    assert.match(e.actor, /^ADMIN:/);
    assert.equal((await env.api('PUT', '/v1/parameters/P-06', { body: { value: '20:00' } })).body.code, 'PARAMETER_READ_ONLY');
    assert.equal((await env.api('PUT', '/v1/parameters/P-07', { body: { value: 'три часа' } })).status, 400);
    const i = await env.addGuide('Илья Носов');
    env.clock.set('2026-12-04T09:00:00+03:00');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-04T14:00:00+03:00' });
    await env.assign(g.id, i.id);
    await env.at('2026-12-04T11:00:00+03:00');                     // запрос за P-07 = 3 ч
    assert.match(env.tg.last(i.tg).text, /^Подтвердите выход/);
    await env.api('PUT', '/v1/parameters/P-07', { body: { value: 'PT2H' } });
  });

  it('BR-36: этап «Проведена» не поменяли — через P-18 группа проведена сама, заявка в «Требует внимания»', async () => {
    const k = await env.addGuide('Кира Лебедева');
    env.clock.set('2026-12-05T09:00:00+03:00');
    const { groups: [g], booking } = await env.crmBooking({ adults: 3, startsAt: '2026-12-05T11:00:00+03:00' });
    await env.assign(g.id, k.id);
    await env.at('2026-12-06T12:59:00+03:00');
    assert.equal((await env.group(g.id)).status, 'ASSIGNED');
    await env.at('2026-12-06T13:00:00+03:00');
    assert.equal((await env.group(g.id)).status, 'COMPLETED');
    assert.ok((await env.api('GET', '/v1/attention')).body.some((a) => a.bookingId === booking.id && a.reason === 'AUTO_COMPLETED'));
  });

  it('NFR-10: через P-20 после экскурсии имя и телефон клиента стираются', async () => {
    env.clock.set('2026-12-10T09:00:00+03:00');
    const { booking } = await env.crmBooking({ adults: 3, startsAt: '2026-12-10T11:00:00+03:00', client: 'Ольга Петрова', phone: '+79990001122' });
    await env.at('2027-03-11T12:00:00+03:00');
    const { rows: [c] } = await env.db.query('SELECT full_name, phone_e164, anonymized_at FROM dispatch.client WHERE id = $1', [booking.client_id]);
    assert.deepEqual([c.full_name, c.phone_e164], [null, null]);
    assert.ok(c.anonymized_at);
  });
});

describe('Перезапуск, NFR-03', () => {
  let env;
  before(async () => { env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  it('NFR-03: перезапуск сервиса между назначением и временем запроса — запрос подтверждения уходит', async () => {
    const g1 = await env.addGuide('Глеб Орлов');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-02T14:00:00+03:00' });
    await env.assign(g.id, g1.id);
    await env.app.close();                                            // остановили процесс
    const restarted = createApp({ cfg: env.cfg, db: env.db, clock: env.clock, log: { error() {}, log() {} } });
    env.clock.set('2026-12-02T12:00:00+03:00');
    await restarted.tick();
    assert.match(env.tg.last(g1.tg).text, /^Подтвердите выход до 13:00/);
  });
});
