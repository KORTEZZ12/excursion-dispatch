// Обработчик бота: обновления Telegram от гидов (US-07, US-09, US-12, US-21).
// Дубли отсекаются по update_id. Ответы уходят через очередь отправки в той же транзакции.
import { params } from './db.mjs';
import { enqueue } from './outbox.mjs';
import { addMs, addDays, atMsk, iso, mskDate, parseDuration } from './time.mjs';
import { toE164 } from './crm.mjs';
import * as D from './domain.mjs';
import * as T from './texts.mjs';

const CONTACT_KEYBOARD = { keyboard: [[{ text: 'Отправить телефон', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true };
const CONSENT = {
  text: 'Клиенты звонят гиду уточнить детали, поэтому в отписке клиенту будут ваши имя и телефон.\nСогласны передавать телефон клиентам?',
  reply_markup: { inline_keyboard: [[{ text: 'Согласен', callback_data: 'cons:yes' }], [{ text: 'Не согласен', callback_data: 'cons:no' }]] },
};

export function createBot({ db, clock, cfg, telegram }) {
  // Ответ гиду — сразу, тихие часы не действуют: это реакция на его действие
  let seq = 0;
  const reply = (c, chatId, body, updateId) => enqueue(c, {
    chatId, dedupKey: `reply:${updateId}:${seq++}`, body, at: clock.now(), expiresAt: addMs(clock.now(), 3600e3), urgentFor: clock.now(),
  });

  async function guideByUser(c, userId) {
    const { rows } = await c.query('SELECT * FROM dispatch.guide WHERE telegram_user_id = $1', [userId]);
    return rows[0] ?? null;
  }

  async function myGroups(c, guideId, now) {
    const from = atMsk(mskDate(now), '00:00');
    const { rows } = await c.query(
      `SELECT g.*, r.name AS route_name FROM dispatch.excursion_group g
         JOIN dispatch.booking b ON b.id = g.booking_id JOIN dispatch.route r ON r.id = b.route_id
        WHERE g.guide_id = $1 AND g.status IN ('ASSIGNED', 'CONFIRMED') AND g.starts_at >= $2 AND g.starts_at < $3
        ORDER BY g.starts_at`, [guideId, from, atMsk(addDays(mskDate(now), 9), '00:00')]);
    return rows;
  }

  async function onStart(c, msg, token, now, uid) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const guide = await guideByUser(c, userId);
    if (!token) {
      if (guide?.status === 'ACTIVE') return reply(c, chatId, T.mine(await myGroups(c, guide.id, now)), uid);
      return reply(c, chatId, { text: 'Подключение — по ссылке-приглашению от администратора' }, uid);
    }
    const { rows: [inv] } = await c.query(
      'SELECT * FROM dispatch.guide_invitation WHERE token = $1 AND used_at IS NULL AND expires_at > $2', [token, now]);
    if (!inv) return reply(c, chatId, { text: 'Ссылка не действует, попросите новую у администратора' }, uid);
    if (guide && guide.status !== 'DEACTIVATED') return reply(c, chatId, { text: 'Вы уже подключены' }, uid);
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Гид';
    await c.query(
      `INSERT INTO dispatch.bot_session (telegram_user_id, chat_id, step, token, full_name, username, updated_at)
       VALUES ($1, $2, 'WAIT_CONTACT', $3, $4, $5, $6)
       ON CONFLICT (telegram_user_id) DO UPDATE SET step = 'WAIT_CONTACT', token = $3, full_name = $4, username = $5, updated_at = $6`,
      [userId, chatId, token, name, msg.from.username ?? null, now]);
    return reply(c, chatId, { text: 'Здравствуйте! Чтобы подключиться к диспетчеру, отправьте свой номер телефона кнопкой ниже', reply_markup: CONTACT_KEYBOARD }, uid);
  }

  async function onMessage(c, msg, now, uid) {
    const chatId = msg.chat.id;
    const text = msg.text?.trim() ?? '';
    const start = /^\/start(?:\s+(\S+))?$/.exec(text);
    if (start) return onStart(c, msg, start[1], now, uid);

    const { rows: [session] } = await c.query('SELECT * FROM dispatch.bot_session WHERE telegram_user_id = $1', [msg.from.id]);
    if (msg.contact && session?.step === 'WAIT_CONTACT') {
      if (msg.contact.user_id && msg.contact.user_id !== msg.from.id) return reply(c, chatId, { text: 'Отправьте свой номер, а не чужой', reply_markup: CONTACT_KEYBOARD }, uid);
      const phone = toE164(msg.contact.phone_number);
      if (!phone) return reply(c, chatId, { text: 'Не удалось прочитать номер, отправьте ещё раз', reply_markup: CONTACT_KEYBOARD }, uid);
      await c.query("UPDATE dispatch.bot_session SET step = 'WAIT_CONSENT', phone_e164 = $2, updated_at = $3 WHERE telegram_user_id = $1", [msg.from.id, phone, now]);
      return reply(c, chatId, CONSENT, uid);
    }

    const guide = await guideByUser(c, msg.from.id);
    if (!guide || guide.status !== 'ACTIVE') return reply(c, chatId, { text: 'Подключение — по ссылке-приглашению от администратора' }, uid);
    if (text === '/revoke' || text === 'Отозвать согласие') {
      await c.query(
        `INSERT INTO dispatch.bot_session (telegram_user_id, chat_id, step, updated_at) VALUES ($1, $2, 'WAIT_REVOKE_CONFIRM', $3)
         ON CONFLICT (telegram_user_id) DO UPDATE SET step = 'WAIT_REVOKE_CONFIRM', updated_at = $3`, [msg.from.id, chatId, now]);
      return reply(c, chatId, {
        text: 'Без согласия на передачу телефона клиентам вы не сможете вести группы: вас отключат, а ваши будущие группы вернутся в поиск.\nОтозвать согласие?',
        reply_markup: { inline_keyboard: [[{ text: 'Отозвать и отключиться', callback_data: 'rvk:yes' }], [{ text: 'Оставить согласие', callback_data: 'rvk:no' }]] },
      }, uid);
    }
    return reply(c, chatId, T.mine(await myGroups(c, guide.id, now)), uid);
  }

  async function onCallback(c, cq, now, uid) {
    const chatId = cq.message?.chat?.id ?? cq.from.id;
    const [kind, arg] = String(cq.data ?? '').split(':');
    const say = async (text, body = null) => {
      await reply(c, chatId, body ?? { text }, uid);
      return text;
    };

    if (kind === 'cons') {
      const { rows: [s] } = await c.query("SELECT * FROM dispatch.bot_session WHERE telegram_user_id = $1 AND step = 'WAIT_CONSENT'", [cq.from.id]);
      if (!s) return say('Подключение — по ссылке-приглашению от администратора');
      if (arg !== 'yes') return say('Без согласия подключение не завершится', { text: 'Без согласия подключение не завершится. Если передумаете, нажмите «Согласен»', reply_markup: CONSENT.reply_markup });
      const { rows: [inv] } = await c.query(
        'SELECT * FROM dispatch.guide_invitation WHERE token = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE', [s.token, now]);
      if (!inv) return say('Ссылка не действует, попросите новую у администратора');
      const existing = await guideByUser(c, cq.from.id);
      let guideId;
      if (existing) {
        guideId = existing.id;   // повторное подключение после деактивации
        await c.query(
          `UPDATE dispatch.guide SET full_name = $2, phone_e164 = $3, telegram_chat_id = $4, status = 'PENDING_APPROVAL',
                  phone_share_consent_at = $5, bot_blocked_at = NULL WHERE id = $1`, [guideId, s.full_name, s.phone_e164, s.chat_id, now]);
      } else {
        const { rows: [g] } = await c.query(
          `INSERT INTO dispatch.guide (full_name, phone_e164, telegram_user_id, telegram_chat_id, status, phone_share_consent_at)
           VALUES ($1, $2, $3, $4, 'PENDING_APPROVAL', $5) RETURNING id`, [s.full_name, s.phone_e164, cq.from.id, s.chat_id, now]);
        guideId = g.id;
      }
      await c.query('UPDATE dispatch.guide_invitation SET used_at = $2, used_by_guide = $3 WHERE token = $1', [s.token, now, guideId]);
      await c.query('DELETE FROM dispatch.bot_session WHERE telegram_user_id = $1', [cq.from.id]);
      const account = s.username ? `@${s.username}` : `id ${cq.from.id}`;
      await D.notifyAdmins(c, now, { text: `Запрос на подключение гида: ${s.full_name}, ${account}, ${s.phone_e164}\nПодтвердите в панели, если это ваш гид` }, `join:${guideId}:${now.getTime()}`);
      return say('Спасибо! Администратор подтвердит подключение, после этого придут группы');
    }

    const guide = await guideByUser(c, cq.from.id);
    if (!guide || guide.status !== 'ACTIVE') return say('Вы отключены от диспетчера');   // BR-30: нажатия на старые кнопки отклоняются
    await c.query("SELECT set_config('dispatch.actor', $1, true)", [`GUIDE:${guide.id}`]);   // журнал: кто изменил группу (NFR-11)

    switch (kind) {
      case 'conf': return say((await D.confirmAttendance(c, now, { assignmentId: arg, guideId: guide.id })).answer);
      case 'repl': return say((await D.requestReplacement(c, now, { assignmentId: arg, guideId: guide.id })).answer);
      case 'ntim': return say((await D.confirmNewTime(c, now, { assignmentId: arg, guideId: guide.id })).answer);
      case 'mine': return say('Мои группы', T.mine(await myGroups(c, guide.id, now)));
      case 'card': {
        const g = await D.loadGroup(c, arg);
        if (!g || g.guide_id !== guide.id || !['ASSIGNED', 'CONFIRMED'].includes(g.status)) return say('Эта группа вам больше не назначена');
        const p = await params(c);
        return say('Карточка группы', T.card(g, { showClient: now < addMs(g.ends_at, parseDuration(p['P-18'])) }));   // BR-29
      }
      case 'call': {
        const g = await D.groupByAssignment(c, arg);
        if (!g || g.guide_id !== guide.id) return say('Эта группа вам больше не назначена');
        const p = await params(c);
        const until = addMs(g.ends_at, parseDuration(p['P-18']));
        if (now >= until) return say('Звонок клиенту больше недоступен');
        // D-18: номер клиента гиду не показывается, звонок через подменный номер службы
        return say('Подменный номер', { text: `Позвоните на ${cfg.telephony.proxyPhone}: звонок переадресуется клиенту группы.\nНомер действует для этой группы до ${iso(until).slice(0, 16).replace('T', ' ')}` });
      }
      case 'rvk': {
        const { rows: [s] } = await c.query("SELECT 1 FROM dispatch.bot_session WHERE telegram_user_id = $1 AND step = 'WAIT_REVOKE_CONFIRM'", [cq.from.id]);
        await c.query('DELETE FROM dispatch.bot_session WHERE telegram_user_id = $1', [cq.from.id]);
        if (arg !== 'yes' || !s) return say('Согласие сохранено');
        await reply(c, chatId, { text: 'Вы отключены от диспетчера. Чтобы вернуться, попросите у администратора новое приглашение' }, uid);
        await D.deactivateGuide(c, now, { guideId: guide.id, why: 'Гид отозвал согласие на передачу телефона' });
        await c.query("UPDATE dispatch.guide SET phone_share_consent_at = NULL WHERE id = $1 AND status = 'DEACTIVATED'", [guide.id]);
        return 'Вы отключены';
      }
      default: return say('Кнопка устарела');
    }
  }

  return async function handleUpdate(update) {
    const now = clock.now();
    let answer = null;
    const result = await db.tx(async (c) => {
      const { rowCount } = await c.query('INSERT INTO dispatch.telegram_update (update_id, received_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [update.update_id, now]);
      if (!rowCount) return 'DUPLICATE';
      if (update.callback_query) {
        answer = await onCallback(c, update.callback_query, now, update.update_id);
      } else if (update.message) {
        await onMessage(c, update.message, now, update.update_id);
      }
      return 'OK';
    });
    if (update.callback_query && result === 'OK') await telegram.answerCallbackQuery(update.callback_query.id, answer ?? undefined);
    return result;
  };
}
