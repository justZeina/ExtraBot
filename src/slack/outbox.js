import { canView, notificationMessage } from './views.js';
import { sendDirect } from './handlers.js';

export function createOutboxWorker({ service, client, ceoSlackUserId, logger = console }) {
  let running = false;
  let outboxTimer;
  let reminderTimer;

  async function flush() {
    if (running) return { sent: 0, skipped: true };
    running = true;
    let sent = 0;
    try {
      for (const notification of service.getPendingNotifications(50)) {
        try {
          const summary = service.getRequestSummary(notification.request_id);
          if (canView(summary, notification.recipient_slack_user_id, ceoSlackUserId)) {
            await sendDirect(client, notification.recipient_slack_user_id, notificationMessage(notification, summary));
          }
          service.markNotification(notification.id, 'SENT');
          sent++;
        } catch (error) {
          logger.error(`Outbox #${notification.id} failed: ${error.message}`);
          service.markNotification(notification.id, 'FAILED');
        }
      }
      return { sent, skipped: false };
    } finally { running = false; }
  }
  function start() {
    service.processDueReminders();
    void flush();
    outboxTimer = setInterval(() => { void flush(); }, 5_000);
    reminderTimer = setInterval(() => {
      try { service.processDueReminders(); } catch (error) { logger.error(`Reminder processing failed: ${error.message}`); }
    }, 60_000);
  }
  function stop() { clearInterval(outboxTimer); clearInterval(reminderTimer); }
  return { flush, start, stop };
}
