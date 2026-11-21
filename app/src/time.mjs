// Время хранится в UTC, показывается по Москве (NFR-12). В Москве нет перехода на летнее время: UTC+3.

const MSK = 3 * 3600e3;
const DAY = 86400e3;

export const mskDate = (d) => new Date(d.getTime() + MSK).toISOString().slice(0, 10);
export const mskTime = (d) => new Date(d.getTime() + MSK).toISOString().slice(11, 16);
export const atMsk = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00+03:00`));
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const addMs = (d, ms) => new Date(d.getTime() + ms);
export const max = (a, b) => (a > b ? a : b);
export const min = (a, b) => (a < b ? a : b);

// 2026-10-24T11:00:00+03:00
export function iso(d) {
  if (d == null) return null;
  return new Date(d.getTime() + MSK).toISOString().slice(0, 19) + '+03:00';
}

// Длительности ISO 8601 из параметров: PT30M, PT2H, PT24H, P90D, P1DT2H
export function parseDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s ?? '');
  if (!m || s === 'P' || s.endsWith('T')) throw new Error(`Не длительность ISO 8601: ${s}`);
  const [d, h, mi, sec] = m.slice(1).map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + mi) * 60e3 + sec * 1000;
}

export const isClock = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s ?? '');

// Тихие часы P-09 «22:00/07:00» (BR-14)
export function quiet(param) {
  const [start, end] = param.split('/');
  return { start, end };
}

export function inQuiet(d, q) {
  const t = mskTime(d);
  return q.start > q.end ? t >= q.start || t < q.end : t >= q.start && t < q.end;
}

// Ближайший момент вне тихих часов: плановое сообщение в 23:00 уходит в 07:00
export function outOfQuiet(d, q) {
  if (!inQuiet(d, q)) return d;
  const date = mskDate(d);
  const sameDayEnd = atMsk(date, q.end);
  return sameDayEnd > d ? sameDayEnd : atMsk(addDays(date, 1), q.end);
}

// Прибавить длительность, считая только время вне тихих часов (сроки P-03, P-05, P-13)
export function addOutsideQuiet(d, ms, q) {
  let t = outOfQuiet(d, q);
  let left = ms;
  for (let i = 0; i < 400 && left > 0; i++) {
    const date = mskDate(t);
    let quietStart = atMsk(date, q.start);
    if (quietStart <= t) quietStart = atMsk(addDays(date, 1), q.start);
    const span = quietStart - t;
    if (left <= span) return addMs(t, left);
    left -= span;
    t = outOfQuiet(quietStart, q);
  }
  return t;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// «24 октября, суббота»
export function humanDate(d) {
  const local = new Date(d.getTime() + MSK);
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}, ${WEEKDAYS[local.getUTCDay()]}`;
}
