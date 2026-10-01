import { App } from '@slack/bolt';
import { loadConfig, loadSlackConfig } from '../src/config.js';
import { createExtraService } from '../src/service.js';
import { registerSlackHandlers } from '../src/slack/handlers.js';
import { createOutboxWorker } from '../src/slack/outbox.js';
import { parseDepartments } from '../src/slack/views.js';

const config = loadConfig();
const { botToken, appToken } = loadSlackConfig();
const departments = parseDepartments(process.env.EXTRABOT_DEPARTMENTS || 'Content,Art,Storytelling');
const service = createExtraService({
  dbPath: process.env.EXTRABOT_DB_PATH || './extrabot.sqlite',
  ...config
});
const app = new App({ token: botToken, appToken, socketMode: true });
const worker = createOutboxWorker({ service, client: app.client, ceoSlackUserId: config.ceoSlackUserId });

registerSlackHandlers(app, { service, ceoSlackUserId: config.ceoSlackUserId,
  departments, flushOutbox: worker.flush });
app.error(async error => { console.error(`Slack handler error: ${error.message}`); });

try {
  await app.start();
  console.log(`ExtraBot connected to Slack. Departments: ${departments.join(', ')}.`);
  worker.start();
} catch (error) {
  worker.stop();
  service.close();
  console.error(`Could not start ExtraBot: ${error.message}`);
  process.exitCode = 1;
}

async function shutdown() {
  worker.stop();
  try { await app.stop(); } finally { service.close(); }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
