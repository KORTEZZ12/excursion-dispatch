// Тексты бота. Сообщение помещается на экран телефона без прокрутки — до 10 строк (NFR-13),
// любое действие гида — не больше двух нажатий от уведомления.
import { humanDate, mskTime, iso } from './time.mjs';

const PAYMENT = { CASH: 'наличными на месте', TRANSFER: 'переводом' };
const ESCALATION = {
  NO_GUIDE: 'Гид не найден',
  NO_CONFIRMATION: 'Нет подтверждения выхода',
  REPLACEMENT_REQUESTED: 'Гид просит замену',
  GUIDE_BLOCKED_BOT: 'Гид заблокировал бота',
  NOTICE_NOT_SENT: 'Отписка не отправлена к сроку',
};

const when = (g) => `${humanDate(g.starts_at)}, ${mskTime(g.starts_at)}`;
const people = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'участника' : 'участников'}`;
const btn = (text, data) => ({ text, callback_data: data });
const kb = (...rows) => ({ inline_keyboard: rows });

export const cardButton = (g) => btn('Открыть карточку', `card:${g.id}`);
export const mineButton = btn('Мои группы', 'mine');

export function assigned(g, { confirmed }) {
  const lines = ['Вам назначена группа', when(g), `${g.route_name}, ${people(g.participants)}`, `Сбор: ${g.meeting_point}`];
  if (confirmed) lines.push('Выход подтверждён: группа скоро начинается, подтверждать не нужно');
  return { text: lines.join('\n'), reply_markup: kb([cardButton(g)]) };
}

export function removed(g, why) {
  const lines = ['Вы больше не ведёте группу', when(g), g.route_name];
  if (why) lines.push(why);
  return { text: lines.join('\n') };
}

export function cancelled(g) {
  return { text: ['Группа отменена', when(g), g.route_name, 'Приходить не нужно'].join('\n') };
}

export function participantsChanged(g, before) {
  return { text: ['Изменилось число участников', when(g), g.route_name, `Было ${before}, стало ${g.participants}`].join('\n'), reply_markup: kb([cardButton(g)]) };
}

export function digest(date, groups) {
  const lines = [`Ваши группы на завтра, ${humanDate(groups[0].starts_at)}:`];
  for (const g of groups) lines.push(`${mskTime(g.starts_at)} — ${g.route_name}, ${people(g.participants)}`);
  lines.push('Подробности — в «Мои группы»');
  return { text: lines.slice(0, 10).join('\n'), reply_markup: kb([mineButton]) };
}

// Один запрос на день, перед первой группой (BR-13, D-15)
export function confirmRequest(groups, deadline) {
  const first = groups[0];
  const lines = [`Подтвердите выход до ${mskTime(deadline)}`];
  for (const g of groups) lines.push(`${humanDate(g.starts_at)}, ${mskTime(g.starts_at)} — ${g.route_name}`);
  if (groups.length > 1) lines.push('Подтверждение — на все группы этого дня');
  return {
    text: lines.slice(0, 10).join('\n'),
    reply_markup: kb([btn('Подтвердить выход', `conf:${first.assignment_id}`)], [btn('Попросить замену', `repl:${first.assignment_id}`)]),
  };
}

export function newTime(g, oldStart) {
  return {
    text: ['Время группы изменилось', `Было: ${humanDate(oldStart)}, ${mskTime(oldStart)}`, `Стало: ${when(g)}`, g.route_name, 'Подтвердите, что ведёте её в новое время'].join('\n'),
    reply_markup: kb([btn('Подтвердить новое время', `ntim:${g.assignment_id}`)]),
  };
}

export function card(g, { showClient }) {
  const lines = [when(g), g.route_name, `Сбор: ${g.meeting_point}`, people(g.participants), `Оплата: ${PAYMENT[g.payment_method]}`];
  if (g.meeting_point_map_url) lines.push(`Карта: ${g.meeting_point_map_url}`);
  const rows = [];
  if (showClient && g.client_name) lines.push(`Клиент: ${g.client_name}`);
  if (showClient) rows.push([btn('Позвонить клиенту', `call:${g.assignment_id}`)]);
  rows.push([mineButton]);
  return { text: lines.join('\n'), reply_markup: kb(...rows) };
}

export function mine(groups) {
  if (!groups.length) return { text: 'На ближайшие 7 дней групп нет' };
  const lines = ['Ваши группы:'];
  for (const g of groups.slice(0, 8)) lines.push(`${humanDate(g.starts_at)}, ${mskTime(g.starts_at)} — ${g.route_name}`);
  if (groups.length > 8) lines.push(`И ещё ${groups.length - 8}`);
  return { text: lines.join('\n'), reply_markup: kb(...groups.slice(0, 8).map((g) => [btn(`${mskTime(g.starts_at)} ${g.route_name}`.slice(0, 60), `card:${g.id}`)])) };
}

export function escalation(e, g) {
  const lines = [`Эскалация: ${ESCALATION[e.reason]}`];
  if (g) lines.push(when(g), g.route_name, g.guide_name ? `Гид: ${g.guide_name}` : 'Гид не назначен');
  lines.push('Откройте панель, чтобы взять в работу');
  return { text: lines.join('\n') };
}

export function escalationResolved(e, g, why) {
  return { text: [`Закрыто: ${ESCALATION[e.reason]}`, ...(g ? [when(g), g.route_name] : []), why].join('\n') };
}

export const reasonTitle = (r) => ESCALATION[r];
export const atIso = iso;
