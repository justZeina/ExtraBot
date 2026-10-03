import { App } from '@slack/bolt';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, loadSlackConfig } from '../src/config.js';
import { createExtraService } from '../src/service.js';
import { registerSlackHandlers } from '../src/slack/handlers.js';
import { createOutboxWorker } from '../src/slack/outbox.js';
import { parseDepartments } from '../src/slack/views.js';

const config = loadConfig();
const { botToken, appToken } = loadSlackConfig();
const departments = parseDepartments(process.env.EXTRABOT_DEPARTMENTS || 'Content,Art,Storytelling');
const dbPath = resolve(process.env.EXTRABOT_DB_PATH || './extrabot.sqlite');
const lockPath = `${dbPath}.bot.lock`;
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid; } catch { /* stale or incomplete lock */ }
      if (!Number.isInteger(pid) && Date.now() - statSync(lockPath).mtimeMs < 120_000) {
        throw new Error('Another ExtraBot instance may be starting; process lock is incomplete.');
      }
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new Error(`ExtraBot is already running (PID ${pid}).`); }
        catch (probeError) { if (probeError.code !== 'ESRCH') throw probeError; }
      }
      try { unlinkSync(lockPath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw new Error('Could not acquire the ExtraBot process lock.');
}
function releaseLock() {
  try {
    if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') console.error(`Could not release process lock: ${error.message}`); }
}
acquireLock();
process.once('exit', releaseLock);
const service = createExtraService({
  dbPath,
  ...config
});
const app = new App({ token: botToken, appToken, socketMode: true });
const worker = createOutboxWorker({ service, client: app.client, ceoSlackUserId: config.ceoSlackUserId, departments });

registerSlackHandlers(app, { service, ceoSlackUserId: config.ceoSlackUserId,
  departments, flushOutbox: worker.flush, syncCards: worker.syncCards });
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
