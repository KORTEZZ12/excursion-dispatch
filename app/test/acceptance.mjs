#!/usr/bin/env node
// Протокол приёмки релиза 1: каждый Gherkin-сценарий историй релиза 1 из backlog.md — и тест, который его проверяет.
// Пишет docs/mvp/acceptance.md и падает, если у сценария нет теста. Запуск: node test/acceptance.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const backlog = readFileSync(new URL('docs/requirements/backlog.md', root), 'utf8').replace(/ /g, ' ');

// Истории релиза 1 — из сводки бэклога
const release1 = [...backlog.matchAll(/^\| (US-\d+) \| ([^|]+) \| (?:Must|Should|Could) \| 1 \|$/gm)].map((m) => ({ id: m[1], title: m[2].trim() }));

for (const us of release1) {
  const section = new RegExp(`\\n### ${us.id}\\b[\\s\\S]*?(?=\\n### |\\n## |\\n---)`).exec(backlog)?.[0] ?? '';
  us.scenarios = [...section.matchAll(/^\s*Сценарий: (.+)$/gm)].map((m) => m[1].trim());
}

// Тесты: describe('US-xx. …') и it('…') внутри него
const tests = [];
const dir = new URL('./', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  let story = null;
  for (const line of readFileSync(new URL(file, dir), 'utf8').split('\n')) {
    const d = /describe\('([^']+)'/.exec(line);
    if (d) story = /^(US-\d+)/.exec(d[1])?.[1] ?? d[1];
    const t = /\bit\('([^']+)'/.exec(line);
    if (t) tests.push({ file, story, name: t[1] });
  }
}

const lines = [
  '# Протокол приёмки релиза 1',
  '',
  'Файл собирает [`app/test/acceptance.mjs`](../../app/test/acceptance.mjs), руками его не правят. Каждый сценарий из [бэклога](../requirements/backlog.md) для историй релиза 1 сопоставлен с автоматическим тестом. Тесты запускаются на каждый PR против PostgreSQL 16 и подмен Telegram и amoCRM, каждый ответ API сверяется с [OpenAPI](../api/openapi.yaml).',
  '',
];
const missing = [];
const ambiguous = [];
let covered = 0;
for (const us of release1) {
  lines.push(`## ${us.id}. ${us.title}`, '', '| Сценарий | Тест |', '|---|---|');
  for (const sc of us.scenarios) {
    // Сначала — тест, который называет сценарий точно: «Сценарий: <имя>» и дальше пробел, тире, запятая или конец.
    // Иначе — тест, в названии которого сценарий упомянут; если таких несколько, сопоставление неоднозначно
    const name = sc.toLowerCase();
    const own = tests.filter((x) => x.story === us.id);
    const exact = own.filter((x) => new RegExp(`сценарий: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[ ,;—])`).test(x.name.toLowerCase()));
    const loose = own.filter((x) => x.name.toLowerCase().includes(name));
    const candidates = exact.length ? exact : loose;
    if (candidates.length > 1) ambiguous.push(`${us.id}: ${sc} — ${candidates.map((x) => x.name).join(' | ')}`);
    const t = candidates[0];
    if (t) covered += 1; else missing.push(`${us.id}: ${sc}`);
    lines.push(`| ${sc} | ${t ? `\`${t.file}\` — ${t.name}` : '**нет теста**'} |`);
  }
  const used = new Set(lines.filter((l) => l.startsWith('| ')).map((l) => l.split(' — ').slice(1).join(' — ').replace(/ \|$/, '')));
  const extra = tests.filter((x) => x.story === us.id && !used.has(x.name));
  if (extra.length) {
    lines.push('', 'Кроме сценариев бэклога:', '');
    for (const t of extra) lines.push(`- \`${t.file}\` — ${t.name}`);
  }
  lines.push('');
}
const other = tests.filter((x) => !release1.some((us) => us.id === x.story));
lines.push('## Нефункциональные требования и надёжность', '');
for (const t of other) lines.push(`- \`${t.file}\` — ${t.story}: ${t.name}`);
lines.push('', `Итого: ${covered} сценариев бэклога из ${covered + missing.length} покрыты тестами, всего тестов — ${tests.length}.`, '');
writeFileSync(new URL('docs/mvp/acceptance.md', root), lines.join('\n'));

if (missing.length || ambiguous.length) {
  if (missing.length) console.error(`Сценарии без теста:\n${missing.join('\n')}`);
  if (ambiguous.length) console.error(`Неоднозначное сопоставление:\n${ambiguous.join('\n')}`);
  process.exit(1);
}
console.log(`Протокол приёмки: ${covered} сценариев, ${tests.length} тестов`);
