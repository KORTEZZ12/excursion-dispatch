// US-08. Сводка на завтра и US-09. Подтверждение выхода — процессы to-be-daily-digest.bpmn и to-be-preparation.bpmn
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ADMIN2_TG, ADMIN_TG, SHORT_ROUTE, createEnv } from './env.mjs';

const press = async (env, guide, text) => {
  const m = [...env.tg.to(guide.tg)].reverse().find((x) => env.tg.buttons(x).some((b) => b.text === text));
  assert.ok(m, `у гида есть сообщение с кнопкой «${text}»`);
  await env.bot.press(guide.tg, env.tg.buttons(m).find((b) => b.text === text).callback_data);
};

describe('US-08. Сводка на завтра', () => {
  let env;
  before(async () => { env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  it('Сценарий: у гида есть группы — одно сообщение с обеими группами по времени', async () => {
    const anna = await env.addGuide('Анна Смирнова');
    const { groups: [late] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-02T15:00:00+03:00' });
    const { groups: [early] } = await env.crmBooking({ adults: 6, startsAt: '2026-12-02T11:00:00+03:00' });
    await env.assign(late.id, anna.id);
    await env.assign(early.id, anna.id);
    await env.app.deliver();
    env.tg.clear();
    await env.at('2026-12-01T18:59:00+03:00');
    assert.equal(env.tg.to(anna.tg).length, 0, 'до P-06 сводки нет');
    await env.at('2026-12-01T19:00:00+03:00');
    const digests = env.tg.to(anna.tg).filter((m) => m.text.startsWith('Ваши группы на завтра'));
    assert.equal(digests.length, 1);
    const lines = digests[0].text.split('\n');
    assert.match(lines[1], /^11:00 — Обзорная по Иннополису, 6 участников/);
    assert.match(lines[2], /^15:00 — Обзорная по Иннополису, 4 участника/);
    assert.ok(lines.length <= 10, 'NFR-13: не больше 10 строк');
  });

  it('Сценарий: у гида нет групп — сообщение не отправляется', async () => {
    const boris = await env.addGuide('Борис Ким');
    await env.at('2026-12-01T19:01:00+03:00');
    assert.equal(env.tg.to(boris.tg).length, 0);
  });

  it('Сценарий: повторный запуск — гид не получает сводку второй раз', async () => {
    const before = env.tg.sent.filter((m) => m.text.startsWith('Ваши группы на завтра')).length;
    await env.at('2026-12-01T19:02:00+03:00');
    await env.at('2026-12-01T19:03:00+03:00');
    assert.equal(env.tg.sent.filter((m) => m.text.startsWith('Ваши группы на завтра')).length, before);
  });

  it('Сценарий: группу назначили во время рассылки — гид сразу получает сообщение о ней (BR-12)', async () => {
    const vera = await env.addGuide('Вера Лис');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-02T17:00:00+03:00' });
    env.clock.set('2026-12-01T19:00:30+03:00');                    // сводка уже собрана в 19:00
    await env.assign(g.id, vera.id);
    await env.app.deliver();
    assert.match(env.tg.last(vera.tg).text, /^Вам назначена группа\n2 декабря, среда, 17:00/);
  });

  it('Сценарий: сводка не ушла — в 19:05 все администраторы получают тревогу по резервному каналу (NFR-16)', async () => {
    env.clock.set('2026-12-02T10:00:00+03:00');
    const gleb = await env.addGuide('Глеб Орлов');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-03T12:00:00+03:00' });
    await env.assign(g.id, gleb.id);
    await env.app.deliver();
    env.tg.fail(gleb.tg, ...Array(10).fill({ error_code: 502, description: 'Bad Gateway' }));
    await env.at('2026-12-02T19:00:00+03:00');
    await env.at('2026-12-02T19:04:00+03:00');
    let { rows } = await env.db.query("SELECT * FROM dispatch.alarm WHERE kind = 'DIGEST_NOT_SENT'");
    assert.equal(rows.length, 0, 'до 19:05 тревоги нет');
    await env.at('2026-12-02T19:05:00+03:00');
    ({ rows } = await env.db.query("SELECT * FROM dispatch.alarm WHERE kind = 'DIGEST_NOT_SENT'"));
    assert.equal(rows.length, 2, 'звонок каждому администратору');
    await env.at('2026-12-02T19:10:00+03:00');
    assert.equal((await env.db.query("SELECT * FROM dispatch.alarm WHERE kind = 'DIGEST_NOT_SENT'")).rows.length, 2, 'тревога одна на день');
  });
});

describe('US-09. Подтверждение выхода', () => {
  let env;
  beforeEach(async () => { env?.close && (await env.close()); env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  it('Сценарий: гид подтверждает — в 12:00 запрос с двумя кнопками, «Подтвердить выход» переводит в «Гид подтвердил»', async () => {
    const anna = await env.addGuide('Анна Смирнова');
    const { groups: [g] } = await env.crmBooking({ adults: 6, startsAt: '2026-12-03T14:00:00+03:00' });
    await env.assign(g.id, anna.id);
    await env.at('2026-12-03T11:59:00+03:00');
    assert.ok(!env.tg.to(anna.tg).some((m) => m.text.startsWith('Подтвердите выход')));
    await env.at('2026-12-03T12:00:00+03:00');
    const req = env.tg.last(anna.tg);
    assert.match(req.text, /^Подтвердите выход до 13:00/);
    assert.deepEqual(env.tg.buttons(req).map((b) => b.text), ['Подтвердить выход', 'Попросить замену']);
    await press(env, anna, 'Подтвердить выход');
    assert.equal((await env.group(g.id)).status, 'CONFIRMED');
  });

  it('Сценарий: гид не ответил — в 13:00 дежурный получает «Нет подтверждения»; подтвердил после срока — эскалация закрывается сама', async () => {
    const boris = await env.addGuide('Борис Ким');
    const { groups: [g] } = await env.crmBooking({ adults: 6, startsAt: '2026-12-03T14:00:00+03:00' });
    await env.assign(g.id, boris.id);
    await env.at('2026-12-03T12:00:00+03:00');
    await env.at('2026-12-03T12:59:00+03:00');
    assert.equal((await env.escalations("reason = 'NO_CONFIRMATION'")).length, 0);
    await env.at('2026-12-03T13:00:00+03:00');
    const [e] = await env.escalations("reason = 'NO_CONFIRMATION'");
    assert.equal(e.status, 'OPEN');
    assert.ok(env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('Эскалация: Нет подтверждения выхода')), 'дежурного в графике нет — сразу всем (BR-25)');
    env.clock.set('2026-12-03T13:10:00+03:00');
    await press(env, boris, 'Подтвердить выход');
    assert.equal((await env.group(g.id)).status, 'CONFIRMED');
    assert.equal((await env.escalations('id = $1', [e.id]))[0].status, 'RESOLVED');
    assert.ok(env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('Закрыто: Нет подтверждения выхода')), 'дежурный получает уведомление');
  });

  it('Сценарий: гид просит замену — эскалация сразу, гид остаётся назначенным', async () => {
    const vera = await env.addGuide('Вера Лис');
    const { groups: [g] } = await env.crmBooking({ adults: 6, startsAt: '2026-12-03T14:00:00+03:00' });
    await env.assign(g.id, vera.id);
    await env.at('2026-12-03T12:00:00+03:00');
    await press(env, vera, 'Попросить замену');
    const [e] = await env.escalations("reason = 'REPLACEMENT_REQUESTED'");
    assert.equal(e.status, 'OPEN');
    const now = await env.group(g.id);
    assert.deepEqual([now.status, now.guide_id], ['ASSIGNED', vera.id]);
    await press(env, vera, 'Попросить замену');
    assert.equal((await env.escalations("reason = 'REPLACEMENT_REQUESTED'")).length, 1, 'вторая эскалация не создаётся (BR-27)');
  });

  it('Сценарий: две группы в один день — подтверждение на обе, второй запрос не приходит', async () => {
    const gleb = await env.addGuide('Глеб Орлов');
    // На маршруте 2 ч группы в 10:00 и 12:00 пересекаются с буфером P-02, поэтому маршрут на 1,5 ч
    const { groups: [a] } = await env.crmBooking({ adults: 4, route: SHORT_ROUTE, startsAt: '2026-12-03T10:00:00+03:00' });
    const { groups: [b] } = await env.crmBooking({ adults: 4, route: SHORT_ROUTE, startsAt: '2026-12-03T12:00:00+03:00' });
    await env.assign(a.id, gleb.id);
    await env.assign(b.id, gleb.id);
    await env.at('2026-12-03T08:00:00+03:00');
    await press(env, gleb, 'Подтвердить выход');
    assert.deepEqual([(await env.group(a.id)).status, (await env.group(b.id)).status], ['CONFIRMED', 'CONFIRMED']);
    env.tg.clear();
    await env.at('2026-12-03T10:00:00+03:00');
    await env.at('2026-12-03T11:00:00+03:00');
    assert.equal(env.tg.to(gleb.tg).filter((m) => m.text.startsWith('Подтвердите выход')).length, 0);
    assert.equal((await env.escalations()).length, 0);
  });

  it('Сценарий: ранняя группа — 06:30 в тихих часах, запрос в 07:00, крайний срок 07:30', async () => {
    const dina = await env.addGuide('Дина Юсупова');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-03T08:30:00+03:00' });
    await env.assign(g.id, dina.id);
    await env.at('2026-12-03T06:30:00+03:00');
    assert.ok(!env.tg.to(dina.tg).some((m) => m.text.startsWith('Подтвердите выход')));
    await env.at('2026-12-03T07:00:00+03:00');
    assert.match(env.tg.last(dina.tg).text, /^Подтвердите выход до 07:30/);
    await env.at('2026-12-03T07:29:00+03:00');
    assert.equal((await env.escalations("reason = 'NO_CONFIRMATION'")).length, 0, 'P-25: не меньше 30 мин на ответ');
    await env.at('2026-12-03T07:30:00+03:00');
    assert.equal((await env.escalations("reason = 'NO_CONFIRMATION'")).length, 1);
  });

  it('Сценарий: позднее назначение за 50 минут — сразу «Гид подтвердил», запрос не приходит', async () => {
    env.clock.set('2026-12-03T13:10:00+03:00');
    const egor = await env.addGuide('Егор Пак');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-03T14:00:00+03:00' });
    const r = await env.assign(g.id, egor.id);
    assert.equal(r.body.status, 'CONFIRMED');
    await env.at('2026-12-03T13:20:00+03:00');
    assert.ok(!env.tg.to(egor.tg).some((m) => m.text.startsWith('Подтвердите выход')));
    assert.equal((await env.escalations("reason = 'NO_CONFIRMATION'")).length, 0);
  });

  it('BR-13: если после 07:00 на ответ меньше P-25, запрос приходит вместе со сводкой накануне', async () => {
    const zoya = await env.addGuide('Зоя Белова');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-02T07:15:00+03:00' });
    await env.assign(g.id, zoya.id);
    await env.at('2026-12-01T19:00:00+03:00');
    const msgs = env.tg.to(zoya.tg).map((m) => m.text);
    assert.ok(msgs.some((t) => t.startsWith('Ваши группы на завтра')));
    assert.ok(msgs.some((t) => t.startsWith('Подтвердите выход')), 'запрос — со сводкой');
    await env.at('2026-12-02T07:00:00+03:00');
    assert.equal(env.tg.to(zoya.tg).filter((m) => m.text.startsWith('Подтвердите выход')).length, 1, 'утром второго запроса нет');
  });

  it('BR-25: эскалация уходит дежурному, а если он не взял её за P-16 — всем администраторам', async () => {
    const { rows: [duty] } = await env.db.query("SELECT id FROM dispatch.admin WHERE telegram_user_id = $1", [ADMIN2_TG]);
    await env.db.query("INSERT INTO dispatch.duty_shift (admin_id, during) VALUES ($1, '[2026-12-03 09:00+03, 2026-12-03 18:00+03)')", [duty.id]);
    const ilya = await env.addGuide('Илья Носов');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-03T14:00:00+03:00' });
    await env.assign(g.id, ilya.id);
    await env.at('2026-12-03T12:00:00+03:00');
    await env.at('2026-12-03T13:00:00+03:00');
    assert.ok(env.tg.to(ADMIN2_TG).some((m) => m.text.startsWith('Эскалация: Нет подтверждения')), 'дежурный получил');
    assert.ok(!env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('Эскалация: Нет подтверждения')), 'остальные — ещё нет');
    await env.at('2026-12-03T13:15:00+03:00');
    assert.ok(env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('Эскалация: Нет подтверждения')), 'через P-16 — всем');
  });

  it('BR-25: эскалацию взяли в работу до P-16 — всем администраторам она не уходит', async () => {
    const { rows: [duty] } = await env.db.query("SELECT id FROM dispatch.admin WHERE telegram_user_id = $1", [ADMIN2_TG]);
    await env.db.query("INSERT INTO dispatch.duty_shift (admin_id, during) VALUES ($1, '[2026-12-03 09:00+03, 2026-12-03 18:00+03)')", [duty.id]);
    const kira = await env.addGuide('Кира Лебедева');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-03T14:00:00+03:00' });
    await env.assign(g.id, kira.id);
    await env.at('2026-12-03T12:00:00+03:00');
    await env.at('2026-12-03T13:00:00+03:00');
    const [e] = await env.escalations("reason = 'NO_CONFIRMATION'");
    const ack = await env.api('POST', `/v1/escalations/${e.id}/ack`);
    assert.equal(ack.body.status, 'ACKED');
    await env.at('2026-12-03T13:20:00+03:00');
    assert.ok(!env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('Эскалация: Нет подтверждения')));
    const res = await env.api('POST', `/v1/escalations/${e.id}/resolve`, { body: { comment: 'Дозвонились, выходит' } });
    assert.equal(res.body.status, 'RESOLVED');
    assert.equal((await env.api('POST', `/v1/escalations/${e.id}/resolve`, { body: { comment: 'да' } })).status, 400);
  });
});
