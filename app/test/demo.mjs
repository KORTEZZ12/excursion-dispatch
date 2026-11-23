#!/usr/bin/env node
// Демо: диспетчер с подменами Telegram и amoCRM и данными одного дня. Нужен PostgreSQL (TEST_PG, как для тестов).
//   TEST_PG=postgres://postgres:postgres@localhost:5432 npm run demo
// Панель: http://127.0.0.1:<порт>/panel, токен администратора — test-admin-token
import { ADMIN_TOKEN, SHORT_ROUTE, createEnv } from './env.mjs';

const env = await createEnv({ start: '2026-12-02T08:00:00+03:00' });
const guides = {};
for (const name of ['Анна Смирнова', 'Борис Ким', 'Вера Лис']) guides[name] = await env.addGuide(name);

const book = (adults, startsAt, extra = {}) => env.crmBooking({ adults, startsAt, ...extra });
const { groups: big } = await book(30, '2026-12-02T11:00:00+03:00');
const { groups: [noon] } = await book(8, '2026-12-02T12:30:00+03:00', { route: SHORT_ROUTE });
const { groups: [evening] } = await book(6, '2026-12-02T17:00:00+03:00');
await book(4, '2026-12-02T09:30:00+03:00');
await env.assign(big[0].id, guides['Анна Смирнова'].id);
await env.assign(big[1].id, guides['Борис Ким'].id);
await env.assign(evening.id, guides['Вера Лис'].id);
await env.at('2026-12-02T09:00:00+03:00');
const anna = env.tg.to(guides['Анна Смирнова'].tg).at(-1);
await env.bot.press(guides['Анна Смирнова'].tg, env.tg.buttons(anna).find((b) => b.text === 'Подтвердить выход').callback_data);
await env.at('2026-12-02T10:00:00+03:00');
void noon;

console.log(`Панель: ${env.base}/panel?date=2026-12-02  токен: ${ADMIN_TOKEN}`);
console.log('Остановить: Ctrl+C');
process.on('SIGINT', async () => { await env.close(); process.exit(0); });
