// US-06. Ручное назначение и снятие гида; соглашения API: Idempotency-Key, If-Match, каталог ошибок
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ADMIN_TG, createEnv } from './env.mjs';

describe('US-06. Ручное назначение и снятие гида', () => {
  let env;
  before(async () => { env = await createEnv(); });
  after(() => env.close());

  it('Сценарий: ручное назначение — группа назначена, гид получает подтверждение, «Гид не найден» закрывается', async () => {
    const { groups: [g] } = await env.crmBooking({ adults: 8, startsAt: '2026-12-03T11:00:00+03:00' });   // гидов нет — эскалация сразу
    await env.at();
    const [e] = await env.escalations("group_id = $1 AND reason = 'NO_GUIDE'", [g.id]);
    assert.equal(e.status, 'OPEN', 'свободных гидов нет с самого начала — эскалация сразу (BR-08)');
    const anna = await env.addGuide('Анна Смирнова');
    const r = await env.assign(g.id, anna.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ASSIGNED');
    assert.equal(r.body.guide.fullName, 'Анна Смирнова');
    assert.equal(r.headers.get('etag'), `"v${r.body.version}"`);
    await env.app.deliver();
    assert.match(env.tg.last(anna.tg).text, /^Вам назначена группа/);
    const [closed] = await env.escalations('id = $1', [e.id]);
    assert.equal(closed.status, 'RESOLVED');
    assert.equal(closed.resolved_by, null, 'закрылась сама: причина устранена (BR-26)');
  });

  it('Сценарий: назначение с пересечением — не происходит, панель показывает пересечение и свободных гидов', async () => {
    const boris = await env.addGuide('Борис Ким');
    const vera = await env.addGuide('Вера Лис');
    const { groups: [first] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-04T11:00:00+03:00' });   // 11:00–13:00 + буфер 30 мин
    assert.equal((await env.assign(first.id, boris.id)).status, 200);
    const { groups: [second] } = await env.crmBooking({ adults: 5, startsAt: '2026-12-04T13:15:00+03:00' });
    const r = await env.assign(second.id, boris.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'GUIDE_BUSY');
    assert.deepEqual(r.body.overlaps.map((o) => o.groupId), [first.id]);
    assert.equal((await env.group(second.id)).status, 'SEARCHING');
    const free = await env.api('GET', `/v1/guides?freeForGroup=${second.id}`);
    assert.ok(free.body.some((x) => x.id === vera.id));
    assert.ok(!free.body.some((x) => x.id === boris.id), 'гид с пересечением не в списке свободных');
  });

  it('Сценарий: замена гида у подтверждённой группы больше чем за 2 часа — «Гид назначен», прежний гид предупреждён', async () => {
    const gleb = await env.addGuide('Глеб Орлов');
    const dina = await env.addGuide('Дина Юсупова');
    const { groups: [early] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-05T10:00:00+03:00' });
    const { groups: [late] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-05T15:00:00+03:00' });
    await env.assign(early.id, gleb.id);
    await env.assign(late.id, gleb.id);
    await env.at('2026-12-05T08:00:00+03:00');                     // запрос подтверждения за 2 ч до первой группы
    const req = env.tg.last(gleb.tg);
    await env.bot.press(gleb.tg, env.tg.buttons(req).find((b) => b.text === 'Подтвердить выход').callback_data);
    assert.equal((await env.group(late.id)).status, 'CONFIRMED', 'подтверждение — на все группы дня');
    const r = await env.assign(late.id, dina.id);
    assert.equal(r.body.status, 'ASSIGNED', 'подтверждение прежнего гида к новому не переходит (F-14)');
    await env.app.deliver();
    assert.match(env.tg.last(gleb.tg).text, /^Вы больше не ведёте группу/);
  });

  it('Сценарий: замена незадолго до начала — группа сразу «Гид подтвердил» (BR-13)', async () => {
    env.clock.set('2026-12-06T09:00:00+03:00');
    const egor = await env.addGuide('Егор Пак');
    const zoya = await env.addGuide('Зоя Белова');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-06T12:00:00+03:00' });
    await env.assign(g.id, egor.id);
    env.clock.set('2026-12-06T10:30:00+03:00');
    const r = await env.assign(g.id, zoya.id);
    assert.equal(r.body.status, 'CONFIRMED');
    await env.app.deliver();
    assert.match(env.tg.last(zoya.tg).text, /Выход подтверждён/);
    env.clock.set('2026-12-01T10:00:00+03:00');
  });

  it('Сценарий: снятие гида — «Ищем гида», новый раунд, гид уведомлён, причина в истории', async () => {
    const ilya = await env.addGuide('Илья Носов');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-07T11:00:00+03:00' });
    const assigned = await env.assign(g.id, ilya.id);
    const r = await env.api('DELETE', `/v1/groups/${g.id}/assignment?reason=${encodeURIComponent('Гид заболел')}`, { ifMatch: assigned.headers.get('etag') });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'SEARCHING');
    assert.equal(r.body.searchRound, 2);
    await env.app.deliver();
    assert.match(env.tg.last(ilya.tg).text, /^Вы больше не ведёте группу/);
    const h = await env.api('GET', `/v1/groups/${g.id}/history`);
    const last = h.body.at(-1);
    assert.deepEqual([last.fromStatus, last.toStatus, last.reason], ['ASSIGNED', 'SEARCHING', 'Гид заболел']);
    assert.match(last.actor, /^ADMIN:/);
  });

  it('Конкурентный сценарий: снятый гид нажал «Подтвердить выход» по старому назначению — не применяется', async () => {
    const kira = await env.addGuide('Кира Лебедева');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-08T11:00:00+03:00' });
    const a = await env.assign(g.id, kira.id);
    const oldAssignment = (await env.group(g.id)).assignment_id;
    await env.api('DELETE', `/v1/groups/${g.id}/assignment?reason=test`, { ifMatch: a.headers.get('etag') });
    await env.bot.press(kira.tg, `conf:${oldAssignment}`);
    assert.equal((await env.group(g.id)).status, 'SEARCHING');
    assert.equal(env.tg.answers.at(-1).text, 'Вы больше не ведёте эту группу');
  });

  it('NFR-05: два администратора назначают разных гидов одновременно — одно назначение, второй получает 412', async () => {
    const lev = await env.addGuide('Лев Мамонтов');
    const mila = await env.addGuide('Мила Осипова');
    const { groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-09T11:00:00+03:00' });
    const ifMatch = `"v${(await env.group(g.id)).version}"`;
    const [r1, r2] = await Promise.all([
      env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: lev.id }, ifMatch }),
      env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: mila.id }, ifMatch }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 412]);
  });

  it('Соглашения API: повтор с тем же ключом, другое тело, нет заголовков, неактивный гид, закрытая группа, нет входа', async () => {
    const nina = await env.addGuide('Нина Рябова');
    const oleg = await env.addGuide('Олег Чернов');
    const { id: leadId, groups: [g] } = await env.crmBooking({ adults: 4, startsAt: '2026-12-10T11:00:00+03:00' });
    const ifMatch = `"v${(await env.group(g.id)).version}"`;
    const key = randomUUID();
    const first = await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: nina.id }, ifMatch, key });
    const replay = await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: nina.id }, ifMatch, key });
    assert.deepEqual(replay.body, first.body, 'повтор возвращает ответ первого выполнения, хотя версия уже другая');
    const reused = await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: oleg.id }, ifMatch, key });
    assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: oleg.id }, key: false, ifMatch })).body.code, 'PRECONDITION_REQUIRED');
    assert.equal((await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: oleg.id } })).body.code, 'PRECONDITION_REQUIRED');
    assert.equal((await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: { guideId: oleg.id }, ifMatch })).body.code, 'VERSION_CONFLICT');
    assert.equal((await env.api('PUT', `/v1/groups/${g.id}/assignment`, { body: {}, ifMatch: first.headers.get('etag') })).status, 400);
    await env.api('POST', `/v1/guides/${oleg.id}/deactivate`);
    assert.equal((await env.assign(g.id, oleg.id)).body.code, 'GUIDE_NOT_ACTIVE');
    env.amo.lead({ id: leadId, adults: 4, statusId: 143, startsAt: Date.parse('2026-12-10T11:00:00+03:00'), updatedAt: env.clock.now().getTime() + 1000 });
    await env.amoWebhook('status', leadId, 2);
    await env.at();
    assert.equal((await env.assign(g.id, nina.id)).body.code, 'GROUP_NOT_ASSIGNABLE');
    assert.equal((await env.api('GET', '/v1/board?date=2026-12-10', { token: null })).status, 401);
    assert.equal((await env.api('GET', `/v1/groups/${randomUUID()}/history`)).status, 404);
  });

  it('BR-08: срок поиска — через P-03 вне тихих часов, но не позже чем за P-04 до начала; эскалация уходит всем без дежурного', async () => {
    await env.addGuide('Павел Сурков');                              // свободные гиды есть
    env.clock.set('2026-12-01T20:30:00+03:00');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-20T11:00:00+03:00' });
    const { rows: [t] } = await env.db.query('SELECT due_at FROM dispatch.search_timer WHERE group_id = $1', [g.id]);
    // 20:30 + 3 ч вне тихих часов: 1,5 ч до 22:00 и 1,5 ч после 07:00
    assert.equal(t.due_at.toISOString(), new Date('2026-12-02T08:30:00+03:00').toISOString());
    await env.at('2026-12-02T08:31:00+03:00');
    const [e] = await env.escalations("group_id = $1 AND reason = 'NO_GUIDE'", [g.id]);
    assert.equal(e.status, 'OPEN');
    await env.app.deliver();
    assert.ok(env.tg.to(ADMIN_TG).some((m) => m.text.startsWith('Эскалация: Гид не найден')));
    env.clock.set('2026-12-01T10:00:00+03:00');
  });
});
