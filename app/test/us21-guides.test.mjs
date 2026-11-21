// US-21. Подключение гида по приглашению — BR-28, BR-30, BR-31
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_TG, createEnv } from './env.mjs';

describe('US-21. Подключение гида по приглашению', () => {
  let env;
  before(async () => { env = await createEnv({ start: '2026-12-01T10:00:00+03:00' }); });
  after(() => env.close());

  const invite = async () => {
    const r = await env.api('POST', '/v1/guide-invitations');
    assert.equal(r.status, 201);
    return new URL(r.body.link).searchParams.get('start');
  };

  it('Сценарий: подключение — ссылка, телефон, согласие, запрос администратору с именем аккаунта, подтверждение', async () => {
    const r = await env.api('POST', '/v1/guide-invitations');
    assert.match(r.body.link, /^https:\/\/t\.me\/inno_dispatch_bot\?start=inv_[A-Za-z0-9_-]{20}$/);
    assert.equal(r.body.expiresAt, '2026-12-03T10:00:00+03:00', 'P-17: 48 ч');
    const token = new URL(r.body.link).searchParams.get('start');
    await env.bot.say(8101, `/start ${token}`, { first_name: 'Роман', last_name: 'Гусев', username: 'rgusev' });
    assert.match(env.tg.last(8101).text, /отправьте свой номер телефона/);
    await env.bot.contact(8101, '89175550011');
    assert.match(env.tg.last(8101).text, /Согласны передавать телефон клиентам\?/);
    await env.bot.press(8101, 'cons:yes');
    assert.match(env.tg.last(8101).text, /Администратор подтвердит подключение/);
    assert.match(env.tg.last(ADMIN_TG).text, /^Запрос на подключение гида: Роман Гусев, @rgusev, \+79175550011/);
    const pending = (await env.api('GET', '/v1/guides')).body.find((g) => g.fullName === 'Роман Гусев');
    assert.equal(pending.status, 'PENDING_APPROVAL');
    const ok = await env.api('POST', `/v1/guides/${pending.id}/approve`);
    assert.equal(ok.body.status, 'ACTIVE');
    await env.app.deliver();
    assert.match(env.tg.last(8101).text, /^Подключение подтверждено/);
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-05T11:00:00+03:00' });
    assert.equal((await env.assign(g.id, pending.id)).status, 200, 'после подтверждения гида можно назначать');
  });

  it('Сценарий: согласие на передачу телефона — без согласия подключение не завершается', async () => {
    const token = await invite();
    await env.bot.say(8102, `/start ${token}`, { first_name: 'Сергей' });
    await env.bot.contact(8102, '+79175550012');
    await env.bot.press(8102, 'cons:no');
    assert.match(env.tg.last(8102).text, /^Без согласия подключение не завершится/);
    const { rows } = await env.db.query('SELECT 1 FROM dispatch.guide WHERE telegram_user_id = 8102');
    assert.equal(rows.length, 0, 'гида в базе нет');
    const { rows: [inv] } = await env.db.query('SELECT used_at FROM dispatch.guide_invitation WHERE token = $1', [token]);
    assert.equal(inv.used_at, null, 'ссылка не израсходована');
  });

  it('Сценарий: ссылка использована или истекла — «Ссылка не действует»', async () => {
    const used = await invite();
    await env.bot.say(8103, `/start ${used}`, { first_name: 'Тимур' });
    await env.bot.contact(8103, '+79175550013');
    await env.bot.press(8103, 'cons:yes');
    await env.bot.say(8104, `/start ${used}`, { first_name: 'Чужой' });
    assert.equal(env.tg.last(8104).text, 'Ссылка не действует, попросите новую у администратора');
    const old = await invite();
    env.clock.set('2026-12-03T10:00:01+03:00');
    await env.bot.say(8105, `/start ${old}`, { first_name: 'Ульяна' });
    assert.equal(env.tg.last(8105).text, 'Ссылка не действует, попросите новую у администратора');
    env.clock.set('2026-12-01T10:00:00+03:00');
  });

  it('Сценарий: деактивация — гид перестаёт получать сообщения, будущие группы возвращаются в поиск', async () => {
    const fedor = await env.addGuide('Фёдор Ершов');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-06T11:00:00+03:00' });
    await env.assign(g.id, fedor.id);
    const r = await env.api('POST', `/v1/guides/${fedor.id}/deactivate`);
    assert.deepEqual([r.body.guide.status, r.body.returnedToSearch], ['DEACTIVATED', [g.id]]);
    assert.equal((await env.group(g.id)).status, 'SEARCHING');
    await env.app.deliver();
    assert.match(env.tg.last(ADMIN_TG).text, /^Гид деактивирован: Фёдор Ершов\nВ поиск вернулись группы:/);
    env.tg.clear();
    await env.at('2026-12-05T19:00:00+03:00');
    assert.equal(env.tg.to(fedor.tg).length, 0, 'ни сводки, ни других сообщений');
    await env.bot.press(fedor.tg, 'mine');
    assert.equal(env.tg.answers.at(-1).text, 'Вы отключены от диспетчера', 'нажатия на старые кнопки отклоняются');
    env.clock.set('2026-12-01T10:00:00+03:00');
  });

  it('Сценарий: гид отзывает согласие — предупреждение, подтверждение, деактивация, администратор получает список групп', async () => {
    const hanna = await env.addGuide('Ханна Шмидт');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-07T11:00:00+03:00' });
    await env.assign(g.id, hanna.id);
    await env.bot.say(hanna.tg, '/revoke');
    assert.match(env.tg.last(hanna.tg).text, /не сможете вести группы/);
    await env.bot.press(hanna.tg, 'rvk:yes');
    const { rows: [after] } = await env.db.query('SELECT status, phone_share_consent_at FROM dispatch.guide WHERE id = $1', [hanna.id]);
    assert.deepEqual([after.status, after.phone_share_consent_at], ['DEACTIVATED', null]);
    assert.equal((await env.group(g.id)).status, 'SEARCHING');
    assert.match(env.tg.last(ADMIN_TG).text, /^Гид отозвал согласие на передачу телефона: Ханна Шмидт/);
  });

  it('BR-31: гид заблокировал бота — Telegram ответил 403, гид исключён из свободных, по его группам эскалация', async () => {
    const yana = await env.addGuide('Яна Котова');
    const { groups: [g] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-08T11:00:00+03:00' });
    env.tg.fail(yana.tg, { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    await env.assign(g.id, yana.id);
    await env.app.deliver();
    const { rows: [gd] } = await env.db.query('SELECT bot_blocked_at FROM dispatch.guide WHERE id = $1', [yana.id]);
    assert.ok(gd.bot_blocked_at);
    assert.equal((await env.escalations("reason = 'GUIDE_BLOCKED_BOT' AND group_id = $1", [g.id])).length, 1);
    const { groups: [other] } = await env.crmBooking({ adults: 3, startsAt: '2026-12-09T11:00:00+03:00' });
    const free = await env.api('GET', `/v1/guides?freeForGroup=${other.id}`);
    assert.ok(!free.body.some((x) => x.id === yana.id));
    assert.equal((await env.api('GET', '/v1/guides')).body.find((x) => x.id === yana.id).botBlocked, true);
  });
});
