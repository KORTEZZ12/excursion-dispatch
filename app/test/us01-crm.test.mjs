// US-01. Группы из заявки CRM — сценарии из backlog.md, граничные случаи и отказы integrations/amocrm.md
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_TG, createEnv } from './env.mjs';

describe('US-01. Группы из заявки CRM', () => {
  let env;
  before(async () => { env = await createEnv(); });
  after(() => env.close());

  it('Сценарий: заявка до 15 человек — одна группа «Ищем гида», запускается поиск', async () => {
    const { booking, groups } = await env.crmBooking({ adults: 12, startsAt: '2026-12-05T11:00:00+03:00' });
    assert.equal(booking.participants, 12);
    assert.deepEqual(groups.map((g) => [g.participants, g.status]), [[12, 'SEARCHING']]);
    const { rows: timers } = await env.db.query('SELECT * FROM dispatch.search_timer WHERE group_id = $1', [groups[0].id]);
    assert.equal(timers.length, 1, 'поиск гида запущен: срок эскалации «Гид не найден» посчитан');
    assert.equal(booking.expected_amount, '12000.00', 'BR-32: сумма по тарифу, в сделке её нет');
  });

  it('Сценарий: большая заявка — 40 участников дают группы 14, 13 и 13', async () => {
    const { groups } = await env.crmBooking({ adults: 30, children: 8, discounted: 2, startsAt: '2026-12-05T11:00:00+03:00' });
    assert.deepEqual(groups.map((g) => g.participants), [14, 13, 13]);
  });

  it('Сценарий: повтор события — новых групп и уведомлений нет', async () => {
    const { id, booking } = await env.crmBooking({ adults: 5, startsAt: '2026-12-06T11:00:00+03:00' });
    const lm = Math.floor(env.clock.now().getTime() / 1000);
    const sentBefore = env.tg.sent.length;
    await env.amoWebhook('add', id, lm);          // тот же ключ дедупликации
    await env.amoWebhook('update', id, lm);       // другой ключ, но то же состояние сделки
    await env.at();
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM dispatch.excursion_group WHERE booking_id = $1', [booking.id]);
    assert.equal(rows[0].n, 1);
    assert.equal(env.tg.sent.length, sentBefore);
    const { rows: ev } = await env.db.query("SELECT result FROM dispatch.inbound_event WHERE dedup_key LIKE $1 ORDER BY received_at", [`amocrm:lead:${id}:%`]);
    assert.deepEqual(ev.map((e) => e.result), ['CREATED', 'UNCHANGED']);
  });

  it('Сценарий: событие пришло не по порядку — не применяется и записывается в журнал', async () => {
    const t1020 = Date.parse('2026-12-01T10:20:00+03:00');
    const { id, booking } = await env.crmBooking({ adults: 6, startsAt: '2026-12-07T11:00:00+03:00', updatedAt: t1020 });
    env.amo.lead({ id, adults: 9, startsAt: Date.parse('2026-12-07T11:00:00+03:00'), updatedAt: Date.parse('2026-12-01T10:10:00+03:00') });
    await env.amoWebhook('update', id, Math.floor(Date.parse('2026-12-01T10:10:00+03:00') / 1000));
    await env.at();
    const { rows: [b] } = await env.db.query('SELECT participants FROM dispatch.booking WHERE id = $1', [booking.id]);
    assert.equal(b.participants, 6);
    const { rows: [ev] } = await env.db.query('SELECT result FROM dispatch.inbound_event WHERE dedup_key = $1', [`amocrm:lead:${id}:update:${Math.floor(Date.parse('2026-12-01T10:10:00+03:00') / 1000)}`]);
    assert.equal(ev.result, 'STALE');
  });

  it('Сценарий: две правки в одну секунду — изменение применяется и появляется вторая группа', async () => {
    const t = Date.parse('2026-12-01T10:20:00+03:00');
    const { id, booking } = await env.crmBooking({ adults: 12, startsAt: '2026-12-08T11:00:00+03:00', updatedAt: t });
    env.amo.lead({ id, adults: 18, startsAt: Date.parse('2026-12-08T11:00:00+03:00'), updatedAt: t });
    await env.amoWebhook('update', id, Math.floor(t / 1000) + 0.5);   // другой ключ события, то же время сделки
    await env.at();
    const { rows } = await env.db.query("SELECT participants FROM dispatch.excursion_group WHERE booking_id = $1 AND status = 'SEARCHING' ORDER BY seq", [booking.id]);
    assert.deepEqual(rows.map((r) => r.participants), [9, 9]);
  });

  it('Сценарий: событие потерялось — плановая сверка находит расхождение и применяет актуальную версию', async () => {
    const { id, booking } = await env.crmBooking({ adults: 4, startsAt: '2026-12-09T11:00:00+03:00' });
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 7, startsAt: Date.parse('2026-12-09T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });  // вебхука нет
    env.clock.advance(15 * 60e3);
    await env.at();
    const { rows: [b] } = await env.db.query('SELECT participants FROM dispatch.booking WHERE id = $1', [booking.id]);
    assert.equal(b.participants, 7);
    assert.ok(env.amo.calls.some((c) => c.startsWith('/api/v4/leads?filter[updated_at][from]=')), 'сверка запрашивала изменённые сделки');
  });

  it('Граничный случай: 0 участников или дата в прошлом — групп нет, заявка в «Требует внимания»', async () => {
    const zero = await env.crmBooking({ adults: 0, startsAt: '2026-12-10T11:00:00+03:00' });
    const past = await env.crmBooking({ adults: 3, startsAt: '2026-11-30T11:00:00+03:00' });
    assert.equal(zero.booking, undefined);
    assert.equal(past.booking, undefined);
    const r = await env.api('GET', '/v1/attention');
    const mine = r.body.filter((a) => [zero.id, past.id].includes(a.externalId)).map((a) => a.reason).sort();
    assert.deepEqual(mine, ['CRM_FIELDS_MISSING', 'START_IN_PAST']);
  });

  it('Граничный случай: маршрута нет в справочнике — групп нет, администратор получает уведомление', async () => {
    const { id, booking } = await env.crmBooking({ adults: 3, route: 'Ночная прогулка', startsAt: '2026-12-10T11:00:00+03:00' });
    assert.equal(booking, undefined);
    assert.ok(env.tg.to(ADMIN_TG).some((m) => m.text.includes(`Заявка ${id}`) && m.text.includes('Ночная прогулка')));
  });

  it('Граничный случай: нет тарифа для категории с участниками — «Требует внимания» (BR-32)', async () => {
    await env.db.query("DELETE FROM dispatch.tariff WHERE category = 'DISCOUNTED'");
    const { id, booking } = await env.crmBooking({ adults: 2, discounted: 1, startsAt: '2026-12-10T12:00:00+03:00' });
    assert.equal(booking, undefined);
    const r = await env.api('GET', '/v1/attention');
    assert.ok(r.body.some((a) => a.externalId === id && a.reason === 'NO_TARIFF'));
  });

  it('Граничный случай: полей категорий в сделке нет — «Число участников» становится взрослыми (F-07)', async () => {
    const { booking } = await env.crmBooking({ participants: 11, price: 9900, startsAt: '2026-12-11T11:00:00+03:00' });
    assert.equal(booking.adults, 11);
    assert.equal(booking.expected_amount, '9900.00', 'сумма из сделки');
  });

  it('Отказ: сделку удалили — группы отменяются с причиной CRM_DELETED', async () => {
    const { id, booking } = await env.crmBooking({ adults: 5, startsAt: '2026-12-12T11:00:00+03:00' });
    await env.amoWebhook('delete', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    const { rows: [b] } = await env.db.query('SELECT status, cancel_reason FROM dispatch.booking WHERE id = $1', [booking.id]);
    assert.deepEqual([b.status, b.cancel_reason], ['CANCELLED', 'CRM_DELETED']);
  });

  it('Отказ: сделку восстановили — новые группы, отменённые остаются в истории', async () => {
    const { id, booking } = await env.crmBooking({ adults: 5, startsAt: '2026-12-13T11:00:00+03:00' });
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 5, statusId: 143, startsAt: Date.parse('2026-12-13T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('status', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 5, statusId: 100, startsAt: Date.parse('2026-12-13T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('restore', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    const { rows } = await env.db.query('SELECT seq, status FROM dispatch.excursion_group WHERE booking_id = $1 ORDER BY seq', [booking.id]);
    assert.deepEqual(rows.map((r) => [r.seq, r.status]), [[1, 'CANCELLED'], [2, 'SEARCHING']]);
  });

  it('Отказ: API amoCRM не отвечает — повтор через 1, 5 и 15 мин, затем уведомление администратору', async () => {
    env.amo.down = true;
    const id = 7559999;
    env.amo.lead({ id, adults: 3, startsAt: Date.parse('2026-12-14T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('add', id, 1);
    for (const minutes of [0, 1, 5, 15]) {
      env.clock.advance(minutes * 60e3);
      await env.at();
    }
    assert.ok(env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('amoCRM не отвечает') && m.text.includes(String(id))));
    env.amo.down = false;
    env.clock.advance(15 * 60e3);
    await env.at();
    const { rows } = await env.db.query("SELECT count(*)::int AS n FROM dispatch.booking WHERE external_id = $1", [id]);
    assert.equal(rows[0].n, 1, 'после восстановления событие обработано');
  });

  it('SAR-3: пункт «Требует внимания» закрывается сам, когда сделка применилась, и вручную с комментарием', async () => {
    const { id } = await env.crmBooking({ adults: 3, route: 'Неизвестный маршрут', startsAt: '2026-12-15T11:00:00+03:00' });
    assert.ok((await env.api('GET', '/v1/attention')).body.some((a) => a.externalId === id));
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 3, startsAt: Date.parse('2026-12-15T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });   // маршрут поправили в amoCRM
    await env.amoWebhook('update', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    assert.ok(!(await env.api('GET', '/v1/attention')).body.some((a) => a.externalId === id), 'сделка применилась — пункт закрыт');
    const other = await env.crmBooking({ adults: 0, startsAt: '2026-12-15T12:00:00+03:00' });
    const item = (await env.api('GET', '/v1/attention')).body.find((a) => a.externalId === other.id);
    assert.equal((await env.api('POST', `/v1/attention/${item.id}/resolve`, { body: { comment: 'да' } })).status, 400);
    const r = await env.api('POST', `/v1/attention/${item.id}/resolve`, { body: { comment: 'Клиент отказался, сделку закрыли' } });
    assert.equal(r.body.comment, 'Клиент отказался, сделку закрыли');
    assert.ok(r.body.resolvedAt);
    assert.ok(!(await env.api('GET', '/v1/attention')).body.some((a) => a.id === item.id));
  });

  it('ADR-001: событие сделки, которое ждёт повтора, не обгоняют следующие события той же сделки', async () => {
    const id = 7558888;
    env.amo.down = true;
    env.amo.lead({ id, adults: 3, startsAt: Date.parse('2026-12-16T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('add', id, 10);
    await env.at();                                   // API не ответил, повтор через 1 мин
    env.amo.down = false;
    await env.amoWebhook('update', id, 11);
    await env.at();
    const { rows: ev } = await env.db.query("SELECT dedup_key, processed_at FROM dispatch.inbound_event WHERE dedup_key LIKE $1 ORDER BY dedup_key", [`amocrm:lead:${id}:%`]);
    assert.deepEqual(ev.map((e) => e.processed_at), [null, null], 'обновление ждёт, пока не обработается создание');
    env.clock.advance(60e3);
    await env.at();
    const { rows: done } = await env.db.query("SELECT result FROM dispatch.inbound_event WHERE dedup_key LIKE $1 ORDER BY processed_at, dedup_key", [`amocrm:lead:${id}:%`]);
    assert.deepEqual(done.map((e) => e.result), ['CREATED', 'UNCHANGED']);
  });

  it('NFR-09: вебхук с неверным секретом — 404, с чужим аккаунтом — событие не сохраняется', async () => {
    assert.equal(await env.amoWebhook('add', 1, 1, { secret: 'x'.repeat(32) }), 404);
    assert.equal(await env.amoWebhook('add', 2, 1, { subdomain: 'stranger' }), 200);
    const { rows } = await env.db.query("SELECT count(*)::int AS n FROM dispatch.inbound_event WHERE dedup_key LIKE 'amocrm:lead:2:%'");
    assert.equal(rows[0].n, 0);
  });
});
