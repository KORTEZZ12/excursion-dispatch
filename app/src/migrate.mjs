// Схема базы: модель данных docs/design/ddl.sql и схема приложения app/sql/*.sql.
// Запуск: node src/migrate.mjs
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = new URL('../../', import.meta.url);

// Модель данных применяется один раз на пустую базу, файлы app/sql — по одному, каждый ровно один раз
export async function migrate(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [r] } = await client.query(
      "SELECT to_regclass('dispatch.booking') IS NOT NULL AS ready, to_regclass('public.schema_migration') IS NOT NULL AS tracked, to_regclass('dispatch.idempotency_key') IS NOT NULL AS mvp1");
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migration (file text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    if (!r.ready) await client.query(await readFile(new URL('docs/design/ddl.sql', root), 'utf8'));
    // База, созданная до учёта миграций, уже содержит первый файл
    if (r.ready && !r.tracked && r.mvp1) await client.query("INSERT INTO public.schema_migration (file) VALUES ('001-mvp.sql') ON CONFLICT DO NOTHING");
    const { rows: done } = await client.query('SELECT file FROM public.schema_migration');
    const applied = new Set(done.map((x) => x.file));
    const dir = new URL('app/sql/', root);
    let count = 0;
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
      if (applied.has(f)) continue;
      await client.query('BEGIN');
      await client.query(await readFile(new URL(f, dir), 'utf8'));
      await client.query('INSERT INTO public.schema_migration (file) VALUES ($1)', [f]);
      await client.query('COMMIT');
      count += 1;
    }
    return count;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = await migrate(process.env.DATABASE_URL);
  console.log(count ? `Применено файлов схемы: ${count}` : 'Схема актуальна');
}
