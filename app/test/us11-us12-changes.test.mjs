// US-11. Отмена заявки и US-12. Перенос даты или времени — BR-04, BR-14, BR-20, BR-21
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { createEnv } from './env.mjs';

describe('US-11. Отмена заявки', () => {
  let env;
  beforeEach(async () => { env?.close && (await env.close()); env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  const cancelInCrm = async (id, startsAt) => {
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 5, statusId: 143, startsAt: Date.parse(startsAt), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('status', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
  };

  it('Сценарий: отмена назначенной группы — гид уведомлён, группы нет в «Моих группах» и сводке, запрос подтверждения не уходит', async () => {
    const anna = await env.addGuide('Анна Смирнова');
    const { id, groups: [g] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-02T14:00:00+03:00' });
    await env.assign(g.id, anna.id);
    await cancelInCrm(id, '2026-12-02T14:00:00+03:00');
    assert.match(env.tg.last(anna.tg).text, /^Группа отменена\n2 декабря, среда, 14:00/);
    await env.bot.say(anna.tg, 'Мои группы');
    assert.equal(env.tg.last(anna.tg).text, 'На ближайшие 7 дней групп нет');
    env.tg.clear();
    await env.at('2026-12-01T19:00:00+03:00');
    await env.at('2026-12-02T12:00:00+03:00');
    assert.equal(env.tg.to(anna.tg).length, 0, 'ни сводки, ни запроса подтверждения');
    const h = await env.api('GET', `/v1/groups/${g.id}/history`);
    assert.equal(h.body.at(-1).reason, 'Заявка отменена: CRM_CANCELLED', 'причина видна в истории');
  });

  it('Сценарий: отмена во время поиска — эскалация по группе закрывается', async () => {
    const { id, groups: [g] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-02T14:00:00+03:00' });   // гидов нет — «Гид не найден» сразу
    await env.at();
    assert.equal((await env.escalations("group_id = $1 AND status = 'OPEN'", [g.id])).length, 1);
    await cancelInCrm(id, '2026-12-02T14:00:00+03:00');
    assert.equal((await env.escalations("group_id = $1 AND status <> 'RESOLVED'", [g.id])).length, 0);
  });

  it('Сценарий: причина отмены — заявку из amoCRM панель не отменяет, только аварийно; причина видна в заявке', async () => {
    const boris = await env.addGuide('Борис Ким');
    const { groups: [g], booking } = await env.crmBooking({ adults: 5, startsAt: '2026-12-03T11:00:00+03:00' });
    await env.assign(g.id, boris.id);
    const refused = await env.api('POST', `/v1/bookings/${booking.id}/cancel`, { body: { reason: 'WEATHER' } });
    assert.deepEqual([refused.status, refused.body.code], [409, 'BOOKING_FROM_CRM']);
    assert.equal((await env.api('POST', `/v1/bookings/${booking.id}/cancel`, { body: { reason: 'ГРОЗА' } })).status, 400);
    const r = await env.api('POST', `/v1/bookings/${booking.id}/cancel`, { body: { reason: 'WEATHER', comment: 'Шторм', emergency: true } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.status, r.body.cancelReason, r.body.crmResyncRequired], ['CANCELLED', 'WEATHER', true]);
    assert.deepEqual(r.body.groups.map((x) => x.status), ['CANCELLED']);
    const again = await env.api('POST', `/v1/bookings/${booking.id}/cancel`, { body: { reason: 'WEATHER', emergency: true } });
    assert.equal(again.body.status, 'CANCELLED', 'повторная отмена — 200 и та же заявка');
  });

  it('Сценарий: аварийная отмена заявки из amoCRM — гиды уведомлены, заявка «Повторить в amoCRM», восстановление не применяется само (BR-04)', async () => {
    const vera = await env.addGuide('Вера Лис');
    const { id, groups: [g], booking } = await env.crmBooking({ adults: 5, startsAt: '2026-12-03T11:00:00+03:00' });
    await env.assign(g.id, vera.id);
    env.amo.down = true;
    await env.api('POST', `/v1/bookings/${booking.id}/cancel`, { body: { reason: 'CLIENT', emergency: true } });
    await env.app.deliver();
    assert.match(env.tg.last(vera.tg).text, /^Группа отменена/);
    env.amo.down = false;
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 5, startsAt: Date.parse('2026-12-03T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });   // в amoCRM ещё активна
    await env.amoWebhook('update', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    const b = await env.api('GET', `/v1/bookings/${booking.id}`);
    assert.equal(b.body.status, 'CANCELLED');
    assert.ok((await env.api('GET', '/v1/attention')).body.some((a) => a.bookingId === booking.id && a.reason === 'RESYNC_CONFLICT'));
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 5, statusId: 143, startsAt: Date.parse('2026-12-03T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });  // отмену повторили в amoCRM
    await env.amoWebhook('status', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    assert.equal((await env.api('GET', `/v1/bookings/${booking.id}`)).body.crmResyncRequired, false);
  });

  it('Граничный случай: отмена в 23:00 — о группе в ближайшие 12 ч гид узнаёт сразу, о более поздней — в 07:00 (BR-14)', async () => {
    const gleb = await env.addGuide('Глеб Орлов');
    const dina = await env.addGuide('Дина Юсупова');
    const { id: soonId, groups: [soon] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-02T10:00:00+03:00' });
    const { id: laterId, groups: [later] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-02T15:00:00+03:00' });
    await env.assign(soon.id, gleb.id);
    await env.assign(later.id, dina.id);
    await env.app.deliver();
    env.clock.set('2026-12-01T23:00:00+03:00');
    await cancelInCrm(soonId, '2026-12-02T10:00:00+03:00');
    await cancelInCrm(laterId, '2026-12-02T15:00:00+03:00');
    assert.match(env.tg.last(gleb.tg).text, /^Группа отменена/, 'до группы 11 ч — сразу');
    assert.doesNotMatch(env.tg.last(dina.tg).text, /^Группа отменена/, 'до группы 16 ч — ждёт утра');
    await env.at('2026-12-02T07:00:00+03:00');
    assert.match(env.tg.last(dina.tg).text, /^Группа отменена/);
  });
});

describe('US-12. Перенос даты или времени', () => {
  let env;
  beforeEach(async () => { env?.close && (await env.close()); env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  const moveInCrm = async (id, startsAt) => {
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 5, startsAt: Date.parse(startsAt), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('update', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
  };

  it('Сценарий: гид подтверждает новое время — назначение сохраняется', async () => {
    const anna = await env.addGuide('Анна Смирнова');
    const { id, groups: [g] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-03T11:00:00+03:00' });
    await env.assign(g.id, anna.id);
    const assignment = (await env.group(g.id)).assignment_id;
    await moveInCrm(id, '2026-12-03T13:00:00+03:00');
    const m = env.tg.last(anna.tg);
    assert.match(m.text, /^Время группы изменилось\nБыло: 3 декабря, четверг, 11:00\nСтало: 3 декабря, четверг, 13:00/);
    await env.bot.press(anna.tg, env.tg.buttons(m).find((b) => b.text === 'Подтвердить новое время').callback_data);
    assert.equal(env.tg.answers.at(-1).text, 'Новое время подтверждено');
    await env.at('2026-12-01T14:00:00+03:00');
    const after2h = await env.group(g.id);
    assert.deepEqual([after2h.guide_id, after2h.assignment_id, after2h.starts_at.toISOString()], [anna.id, assignment, new Date('2026-12-03T13:00:00+03:00').toISOString()]);
  });

  it('Сценарий: новое время пересекается — группа возвращается в поиск, гид уведомлён', async () => {
    const boris = await env.addGuide('Борис Ким');
    const { groups: [other] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-03T13:00:00+03:00' });
    const { id, groups: [g] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-03T09:00:00+03:00' });
    await env.assign(other.id, boris.id);
    await env.assign(g.id, boris.id);
    await moveInCrm(id, '2026-12-03T13:00:00+03:00');
    const now = await env.group(g.id);
    assert.deepEqual([now.status, now.guide_id], ['SEARCHING', null]);
    assert.match(env.tg.last(boris.tg).text, /Новое время пересекается с другой вашей группой/);
    const h = await env.api('GET', `/v1/groups/${g.id}/history`);
    assert.equal(h.body.at(-1).reason, 'Новое время пересекается с другой группой гида');
  });

  it('Сценарий: гид не подтвердил за 2 ч вне тихих часов — группа в поиске, гид уведомлён', async () => {
    const vera = await env.addGuide('Вера Лис');
    const { id, groups: [g] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-04T11:00:00+03:00' });
    await env.assign(g.id, vera.id);
    env.clock.set('2026-12-01T21:29:00+03:00');
    await moveInCrm(id, '2026-12-04T15:00:00+03:00');              // запрос в 21:30: 30 мин до тихих часов и 1,5 ч после 07:00
    await env.at('2026-12-02T08:29:00+03:00');
    assert.equal((await env.group(g.id)).guide_id, vera.id);
    await env.at('2026-12-02T08:30:00+03:00');
    assert.equal((await env.group(g.id)).status, 'SEARCHING');
    assert.match(env.tg.last(vera.tg).text, /Вы не подтвердили новое время/);
  });

  it('Сценарий: перенос во время поиска — новый раунд, отклики на старое время не действуют', async () => {
    const { id, groups: [g] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-05T11:00:00+03:00' });
    await moveInCrm(id, '2026-12-05T15:00:00+03:00');
    const now = await env.group(g.id);
    assert.equal(now.search_round, 2);
    assert.equal(now.starts_at.toISOString(), new Date('2026-12-05T15:00:00+03:00').toISOString());
    const { rows } = await env.db.query('SELECT search_round FROM dispatch.search_timer WHERE group_id = $1 ORDER BY search_round', [g.id]);
    assert.deepEqual(rows.map((r) => r.search_round), [1, 2], 'срок поиска нового раунда посчитан заново');
  });

  it('BR-22: число участников в CRM уменьшилось — снимается группа без гида, затем назначенная последней', async () => {
    const gleb = await env.addGuide('Глеб Орлов');
    const dina = await env.addGuide('Дина Юсупова');
    const { id, groups } = await env.crmBooking({ adults: 40, startsAt: '2026-12-06T11:00:00+03:00' });
    await env.assign(groups[0].id, gleb.id);
    await env.assign(groups[1].id, dina.id);
    env.clock.advance(60e3);
    env.amo.lead({ id, adults: 14, startsAt: Date.parse('2026-12-06T11:00:00+03:00'), updatedAt: env.clock.now().getTime() });
    await env.amoWebhook('update', id, Math.floor(env.clock.now().getTime() / 1000));
    await env.at();
    const after = await Promise.all(groups.map((g) => env.group(g.id)));
    assert.deepEqual(after.map((g) => [g.status, g.closed_reason, g.participants]), [
      ['ASSIGNED', null, 14], ['CANCELLED', 'SURPLUS', 13], ['CANCELLED', 'SURPLUS', 13],
    ]);
    assert.match(env.tg.last(dina.tg).text, /Группа стала лишней/);
    assert.ok(!env.tg.to(gleb.tg).some((m) => m.text.startsWith('Изменилось число участников')), 'у первой группы число не изменилось — сообщения нет');
  });
});
