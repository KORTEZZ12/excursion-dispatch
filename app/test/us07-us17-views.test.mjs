// US-07. Мои группы (бот) и US-17. Доска групп (панель)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createEnv } from './env.mjs';

describe('US-07. Мои группы', () => {
  let env;
  let anna;
  const ids = {};
  before(async () => {
    env = await createEnv({ start: '2026-12-01T10:00:00+03:00' });
    anna = await env.addGuide('Анна Смирнова');
    const make = async (key, startsAt, extra = {}) => {
      const { groups: [g], id } = await env.crmBooking({ adults: 5, startsAt, client: 'Мария Иванова', phone: '89991112233', payment: 'Перевод', ...extra });
      await env.assign(g.id, anna.id);
      ids[key] = { group: g.id, lead: id };
    };
    await make('tomorrow', '2026-12-02T15:00:00+03:00');
    await make('today', '2026-12-01T18:00:00+03:00');
    await make('week', '2026-12-08T11:00:00+03:00');
    await make('far', '2026-12-12T11:00:00+03:00');
    await make('cancelled', '2026-12-03T11:00:00+03:00');
    env.amo.lead({ id: ids.cancelled.lead, adults: 5, statusId: 143, startsAt: Date.parse('2026-12-03T11:00:00+03:00'), updatedAt: Date.parse('2026-12-01T10:05:00+03:00') });
    await env.amoWebhook('status', ids.cancelled.lead, 99);
    await env.at();
  });
  after(() => env.close());

  it('Сценарий: список своих групп — сегодня, завтра и следующие 7 дней по времени, без отменённых', async () => {
    await env.bot.say(anna.tg, 'Мои группы');
    const m = env.tg.last(anna.tg);
    assert.deepEqual(m.text.split('\n'), [
      'Ваши группы:',
      '1 декабря, вторник, 18:00 — Обзорная по Иннополису',
      '2 декабря, среда, 15:00 — Обзорная по Иннополису',
      '8 декабря, вторник, 11:00 — Обзорная по Иннополису',
    ]);
    assert.equal(env.tg.buttons(m).length, 3, 'у каждой группы кнопка карточки');
  });

  it('Сценарий: карточка группы — дата, время, маршрут, место сбора, участники, оплата, имя клиента, «Позвонить клиенту»', async () => {
    await env.bot.press(anna.tg, `card:${ids.tomorrow.group}`);
    const m = env.tg.last(anna.tg);
    assert.match(m.text, /2 декабря, среда, 15:00/);
    assert.match(m.text, /Сбор: Площадь у вокзала/);
    assert.match(m.text, /5 участников/);
    assert.match(m.text, /Оплата: переводом/);
    assert.match(m.text, /Клиент: Мария Иванова/);
    assert.ok(!m.text.includes('9991112233'), 'номер клиента гиду не показывается (D-18)');
    const call = env.tg.buttons(m).find((b) => b.text === 'Позвонить клиенту');
    await env.bot.press(anna.tg, call.callback_data);
    const r = env.tg.last(anna.tg);
    assert.match(r.text, /^Позвоните на \+78005550100/);
    assert.ok(!r.text.includes('9991112233'));
  });

  it('Граничный случай: через P-18 после окончания имя клиента и звонок скрываются (BR-29)', async () => {
    env.clock.set('2026-12-02T17:00:00+03:00');                    // экскурсия кончилась, прошло 0 ч
    await env.bot.press(anna.tg, `card:${ids.tomorrow.group}`);
    assert.match(env.tg.last(anna.tg).text, /Клиент: Мария Иванова/);
    env.clock.set('2026-12-03T17:00:00+03:00');                    // ровно P-18
    await env.bot.press(anna.tg, `card:${ids.tomorrow.group}`);
    const m = env.tg.last(anna.tg);
    assert.ok(!m.text.includes('Мария'));
    assert.ok(!env.tg.buttons(m).some((b) => b.text === 'Позвонить клиенту'));
    const assignment = (await env.group(ids.tomorrow.group)).assignment_id;
    await env.bot.press(anna.tg, `call:${assignment}`);
    assert.equal(env.tg.last(anna.tg).text, 'Звонок клиенту больше недоступен');
    env.clock.set('2026-12-01T10:00:00+03:00');
  });

  it('NFR-10: чужую группу гид не открывает', async () => {
    const boris = await env.addGuide('Борис Ким');
    await env.bot.press(boris.tg, `card:${ids.week.group}`);
    assert.equal(env.tg.last(boris.tg).text, 'Эта группа вам больше не назначена');
  });
});

describe('US-17. Доска групп', () => {
  let env;
  let g1; let g2; let g3; let vera;
  before(async () => {
    env = await createEnv({ start: '2026-12-01T10:00:00+03:00' });
    vera = await env.addGuide('Вера Лис');
    const gleb = await env.addGuide('Глеб Орлов');
    ({ groups: [g1] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-02T11:00:00+03:00' }));
    ({ groups: [g2] } = await env.crmBooking({ adults: 7, startsAt: '2026-12-02T09:00:00+03:00' }));
    ({ groups: [g3] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-02T16:00:00+03:00' }));
    await env.assign(g1.id, vera.id);
    await env.assign(g3.id, gleb.id);
    await env.at('2026-12-02T09:00:00+03:00');
    await env.bot.press(vera.tg, env.tg.buttons(env.tg.last(vera.tg)).find((b) => b.text === 'Подтвердить выход').callback_data);
  });
  after(() => env.close());

  it('Сценарий: доска на день — группы по времени со статусом, гидом и подтверждением', async () => {
    const r = await env.api('GET', '/v1/board?date=2026-12-02');
    assert.deepEqual(r.body.groups.map((g) => [g.startsAt.slice(11, 16), g.status, g.guide?.fullName ?? null]), [
      ['09:00', 'SEARCHING', null],
      ['11:00', 'CONFIRMED', 'Вера Лис'],
      ['16:00', 'ASSIGNED', 'Глеб Орлов'],
    ]);
    assert.equal(r.body.groups[0].noticeStatus, null, 'отписки — релиз 2');
  });

  it('Сценарий: проблемные группы — без гида, без подтверждения и с открытыми эскалациями', async () => {
    const r = await env.api('GET', '/v1/board?date=2026-12-02&attention=true');
    assert.deepEqual(r.body.groups.map((g) => g.groupId), [g2.id, g3.id]);
    assert.ok(r.body.groups[0].openEscalations.includes('NO_GUIDE'), 'до начала меньше часа — «Гид не найден» сразу (BR-08)');
  });

  it('Доска даёт версию группы для If-Match: панель назначает гида прямо с доски', async () => {
    const zoya = await env.addGuide('Зоя Белова');
    const r = await env.api('GET', '/v1/board?date=2026-12-02');
    const row = r.body.groups.find((g) => g.groupId === g2.id);
    env.clock.set('2026-12-02T08:00:00+03:00');
    const a = await env.api('PUT', `/v1/groups/${g2.id}/assignment`, { body: { guideId: zoya.id }, ifMatch: `"v${row.version}"` });
    assert.equal(a.status, 200);
  });

  it('Неверная дата — 400', async () => {
    assert.equal((await env.api('GET', '/v1/board?date=завтра')).status, 400);
  });
});
