// Подмены внешних систем для тестов и демо: Telegram Bot API и API amoCRM. Настоящие HTTP-серверы,
// поэтому диспетчер ходит к ним теми же клиентами, что и в проде.
import { createServer } from 'node:http';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export async function fakeTelegram() {
  const sent = [];
  const answers = [];
  const failures = new Map(); // chat_id → очередь ответов-ошибок
  let messageId = 1000;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const method = req.url.split('/').pop();
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (method === 'sendMessage') {
      const queue = failures.get(String(body.chat_id));
      const fail = queue?.shift();
      if (fail) return reply(fail.error_code, { ok: false, error_code: fail.error_code, description: fail.description, ...(fail.retry_after ? { parameters: { retry_after: fail.retry_after } } : {}) });
      messageId += 1;
      sent.push({ chatId: Number(body.chat_id), text: body.text, markup: body.reply_markup ?? null, messageId });
      return reply(200, { ok: true, result: { message_id: messageId, chat: { id: body.chat_id }, text: body.text } });
    }
    if (method === 'answerCallbackQuery') {
      answers.push(body);
      return reply(200, { ok: true, result: true });
    }
    return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
  });
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}`,
    sent, answers,
    to: (chatId) => sent.filter((m) => m.chatId === Number(chatId)),
    last: (chatId) => sent.filter((m) => m.chatId === Number(chatId)).at(-1),
    buttons: (m) => (m?.markup?.inline_keyboard ?? []).flat(),
    fail(chatId, ...errors) { failures.set(String(chatId), [...(failures.get(String(chatId)) ?? []), ...errors]); },
    clear() { sent.length = 0; answers.length = 0; },
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function fakeAmo({ fields }) {
  const leads = new Map();
  const contacts = new Map();
  const calls = [];
  let down = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(url.pathname + url.search);
    const reply = (status, data) => { res.writeHead(status, data ? { 'Content-Type': 'application/json' } : {}); res.end(data ? JSON.stringify(data) : ''); };
    if (down) return reply(503, { title: 'Service Unavailable' });
    let m = /^\/api\/v4\/leads\/(\d+)$/.exec(url.pathname);
    if (m) return leads.has(m[1]) ? reply(200, leads.get(m[1])) : reply(204);
    m = /^\/api\/v4\/contacts\/(\d+)$/.exec(url.pathname);
    if (m) return contacts.has(m[1]) ? reply(200, contacts.get(m[1])) : reply(204);
    if (url.pathname === '/api/v4/leads') {
      const from = Number(url.searchParams.get('filter[updated_at][from]') ?? 0);
      const found = [...leads.values()].filter((l) => l.updated_at >= from);
      return found.length ? reply(200, { _embedded: { leads: found } }) : reply(204);
    }
    return reply(404, { title: 'Not Found' });
  });
  const port = await listen(server);
  let contactSeq = 500;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    set down(v) { down = v; },
    // Сделка в формате API amoCRM: дополнительные поля по идентификаторам из настроек
    lead({ id, startsAt, route = 'Обзорная по Иннополису', adults, children, discounted, participants, payment = 'Наличные',
      messenger = 'Telegram', price = 0, statusId = 100, updatedAt, client = 'Мария Иванова', phone = '89991112233' }) {
      const cf = (fid, value) => (value === undefined ? [] : [{ field_id: fid, values: [{ value }] }]);
      const contactId = String(contactSeq++);
      contacts.set(contactId, { id: Number(contactId), name: client, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: phone }] }] });
      const lead = {
        id, price, status_id: statusId, updated_at: Math.floor(updatedAt / 1000),
        custom_fields_values: [
          ...cf(fields.startsAt, startsAt ? Math.floor(startsAt / 1000) : undefined), ...cf(fields.route, route),
          ...cf(fields.adults, adults), ...cf(fields.children, children), ...cf(fields.discounted, discounted),
          ...cf(fields.participants, participants), ...cf(fields.payment, payment), ...cf(fields.messenger, messenger),
        ],
        _embedded: { contacts: [{ id: Number(contactId) }] },
      };
      leads.set(String(id), lead);
      return lead;
    },
    remove: (id) => leads.delete(String(id)),
    close: () => new Promise((r) => server.close(r)),
  };
}
