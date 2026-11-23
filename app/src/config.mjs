// Настройки из окружения. Секреты — только из окружения, в репозитории их нет.

function json(name, fallback) {
  const v = process.env[name];
  return v ? JSON.parse(v) : fallback;
}

export function loadConfig(overrides = {}) {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/dispatch',
    tickMs: Number(process.env.TICK_MS ?? 15000),
    // Администраторы панели: токен → id администратора. В проде — сессия после входа (NFR-09, находка M-06)
    adminTokens: json('ADMIN_TOKENS', {}),
    telegram: {
      apiBase: process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
      token: process.env.TELEGRAM_BOT_TOKEN ?? '',
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
      botUsername: process.env.TELEGRAM_BOT_USERNAME ?? 'dispatch_bot',
      perChatIntervalMs: Number(process.env.TELEGRAM_PER_CHAT_INTERVAL_MS ?? 1000),
      timeoutMs: Number(process.env.TELEGRAM_TIMEOUT_MS ?? 10000),
    },
    amocrm: {
      apiBase: process.env.AMOCRM_API_BASE ?? '',
      token: process.env.AMOCRM_TOKEN ?? '',
      webhookSecret: process.env.AMOCRM_WEBHOOK_SECRET ?? '',
      subdomain: process.env.AMOCRM_SUBDOMAIN ?? '',
      // Идентификаторы полей сделки свои у каждого аккаунта: их даёт GET /api/v4/leads/custom_fields
      fields: json('AMOCRM_FIELDS', {
        startsAt: 1001, route: 1002, adults: 1003, children: 1004, discounted: 1005,
        participants: 1006, payment: 1007, messenger: 1008,
      }),
      // Этапы воронки: «Отменена» и «Проведена». В amoCRM 142 — «Успешно реализовано», 143 — «Закрыто и не реализовано»
      statuses: json('AMOCRM_STATUSES', { cancelled: 143, completed: 142 }),
    },
    // Подменный номер для звонка гида клиенту (D-18). Провайдер не выбран (Q-06)
    telephony: { proxyPhone: process.env.PROXY_PHONE ?? '+78005550100' },
    ...overrides,
  };
}
