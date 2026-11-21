// Клиенты внешних систем: Telegram Bot API и API amoCRM. Адреса берутся из настроек,
// поэтому в тестах и на стенде их заменяют подмены (app/test/fakes.mjs).

async function call(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { status: 0, data: null, error: String(e.message ?? e) };
  }
}

export function telegramClient({ apiBase, token, timeoutMs }) {
  const method = async (name, payload) => {
    const r = await call(`${apiBase}/bot${token}/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs,
    });
    if (r.status === 0) return { ok: false, code: 0, description: r.error };
    if (r.data?.ok) return { ok: true, result: r.data.result };
    return { ok: false, code: r.data?.error_code ?? r.status, description: r.data?.description ?? `HTTP ${r.status}`, retryAfter: r.data?.parameters?.retry_after };
  };
  return {
    async sendMessage(chatId, body) {
      const r = await method('sendMessage', { chat_id: Number(chatId), ...body });
      return r.ok ? { ok: true, messageId: r.result.message_id } : r;
    },
    answerCallbackQuery: (id, text) => method('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
  };
}

export class CrmUnavailable extends Error {}

export function amocrmClient({ apiBase, token }) {
  const get = async (path) => {
    const r = await call(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 0 || r.status === 429 || r.status >= 500) throw new CrmUnavailable(r.error ?? `HTTP ${r.status}`);
    if (r.status === 204 || r.status === 404) return null;
    if (r.status !== 200) throw new CrmUnavailable(`HTTP ${r.status}`);
    return r.data;
  };
  return {
    lead: (id) => get(`/api/v4/leads/${id}?with=contacts`),
    contact: (id) => get(`/api/v4/contacts/${id}`),
    async leadsUpdatedSince(unix) {
      const out = [];
      for (let page = 1; page < 100; page++) {
        const data = await get(`/api/v4/leads?filter[updated_at][from]=${unix}&with=contacts&page=${page}&limit=250`);
        const leads = data?._embedded?.leads ?? [];
        out.push(...leads);
        if (!data?._links?.next) break;
      }
      return out;
    },
  };
}
