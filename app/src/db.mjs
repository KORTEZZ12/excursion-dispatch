import pg from 'pg';

pg.types.setTypeParser(1700, (v) => v); // numeric — строкой, чтобы не терять копейки
pg.types.setTypeParser(1082, (v) => v); // date — строкой YYYY-MM-DD

export function createDb(url) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (e) => console.error('PostgreSQL: соединение потеряно', e.message));   // простаивающее соединение разорвали — пул создаст новое
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    // Транзакция. actor и reason уходят в журналы через dispatch.actor и dispatch.reason (NFR-11)
    async tx(fn, { actor = 'SYSTEM', reason = null } = {}) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await setContext(c, actor, reason);
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    end: () => pool.end(),
  };
}

export async function setContext(c, actor, reason) {
  await c.query("SELECT set_config('dispatch.actor', $1, true), set_config('dispatch.reason', $2, true)", [actor, reason ?? '']);
}

export async function setReason(c, reason) {
  await c.query("SELECT set_config('dispatch.reason', $1, true)", [reason ?? '']);
}

// Параметры P-xx читаются при каждом действии: изменение применяется без перезапуска (NFR-14)
export async function params(c) {
  const { rows } = await c.query('SELECT code, value FROM dispatch.parameter');
  return Object.fromEntries(rows.map((r) => [r.code, r.value]));
}
