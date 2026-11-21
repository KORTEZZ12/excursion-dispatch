// Схема базы: модель данных docs/design/ddl.sql и схема приложения app/sql/*.sql.
// Применяется один раз на пустую базу: node src/migrate.mjs
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = new URL('../../', import.meta.url);

export async function migrate(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [r] } = await client.query("SELECT to_regclass('dispatch.booking') IS NOT NULL AS ready");
    if (r.ready) return false;
    await client.query(await readFile(new URL('docs/design/ddl.sql', root), 'utf8'));
    const dir = new URL('app/sql/', root);
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
      await client.query(await readFile(new URL(f, dir), 'utf8'));
    }
    return true;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const created = await migrate(process.env.DATABASE_URL);
  console.log(created ? 'Схема создана' : 'Схема уже есть');
}
