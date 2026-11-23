// Запуск диспетчера: node src/main.mjs. Настройки — переменные окружения (src/config.mjs, app/README.md)
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { migrate } from './migrate.mjs';

const cfg = loadConfig();
await migrate(cfg.databaseUrl);
const db = createDb(cfg.databaseUrl);
const app = createApp({ cfg, db });
const port = await app.listen();
app.start();
console.log(`Диспетчер: http://localhost:${port}/panel, планировщик раз в ${cfg.tickMs / 1000} с`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
