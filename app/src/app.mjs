// Сборка диспетчера: API, бот, обработчик событий amoCRM, планировщик и очередь отправки в одном процессе
// (архитектура: одна виртуальная машина и PostgreSQL, docs/design/architecture.md).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { createBot } from './bot.mjs';
import { amocrmClient, telegramClient } from './clients.mjs';
import { crmDue, processInbound, reconcile } from './crm.mjs';
import * as D from './domain.mjs';
import { createDeliverer } from './outbox.mjs';
import { SWEEPS, WATCHDOGS } from './scheduler.mjs';

export const systemClock = { now: () => new Date() };

export function createApp({ cfg, db, clock = systemClock, log = console }) {
  const telegram = telegramClient(cfg.telegram);
  const crm = amocrmClient(cfg.amocrm);
  const bot = createBot({ db, clock, cfg, telegram });
  const api = createApi({ db, clock, cfg, bot });
  const deliver = createDeliverer({
    db, telegram, clock, perChatIntervalMs: cfg.telegram.perChatIntervalMs,
    onBlocked: (chatId) => db.tx((c) => D.markBotBlocked(c, clock.now(), chatId)),
    // NFR-08: после предела попыток — тревога, Telegram для неё не годится
    onFailed: (n) => db.tx((c) => D.alarmAll(c, clock.now(), 'TELEGRAM_FAILED', `Сообщение в Telegram не доставлено после 5 попыток: ${n.dedup_key}`)),
  });
  const board = fileURLToPath(new URL('../public/board.html', import.meta.url));

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/panel'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(board));
      }
      if (req.method === 'GET' && req.url === '/health') {
        await db.query('SELECT 1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"ok":true}');
      }
      const r = await api(req, raw);
      res.writeHead(r.status, r.body == null ? r.headers : { 'Content-Type': 'application/json; charset=utf-8', ...r.headers });
      res.end(r.body == null ? '' : JSON.stringify(r.body));
    } catch (e) {
      log.error(e);
      res.writeHead(500, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Внутренняя ошибка', status: 500, code: 'INTERNAL', traceId: '0' }));
    }
  });

  // Один шаг планировщика: события CRM, сверка, проходы по расписанию, очередь отправки
  async function tick() {
    await processInbound(db, crm, cfg.amocrm, clock);
    if (cfg.amocrm.apiBase && (await crmDue(db, clock.now()))) await reconcile(db, crm, cfg.amocrm, clock);
    for (const [name, sweep] of [...SWEEPS, ...WATCHDOGS]) {
      try {
        await db.tx((c) => sweep(c, clock.now()), { actor: 'SYSTEM' });
      } catch (e) {
        log.error(`планировщик: ${name}`, e);
      }
    }
    await deliver();
  }

  let timer = null;
  let running = Promise.resolve();
  return {
    server, tick, deliver, telegram,
    reconcile: () => reconcile(db, crm, cfg.amocrm, clock),
    listen(port = cfg.port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    start() {
      timer = setInterval(() => { running = running.then(tick).catch((e) => log.error(e)); }, cfg.tickMs);
    },
    async close() {
      if (timer) clearInterval(timer);
      await running;
      await new Promise((r) => server.close(r));
    },
  };
}
