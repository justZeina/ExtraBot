import { randomUUID } from 'node:crypto';
import { canView, notificationMessage, progressMessage } from './views.js';
import { sendDirect } from './handlers.js';

export function createOutboxWorker({ service, client, ceoSlackUserId, logger = console }) {
  let running = false;
  let outboxTimer;
  let reminderTimer;

  async function refreshProgressCard(requestId, { create = false } = {}) {
    const summary = service.getRequestSummary(requestId);
    const recipient = summary.marketer_slack_user_id;
    const existing = service.getMessageCard(requestId, recipient, 'MARKETER_PROGRESS');
    if (!existing && !create) return { updated: false };
    const message = progressMessage(summary);
    if (existing) {
      try {
        await client.chat.update({ channel: existing.channel_id, ts: existing.message_ts, ...message });
        return { updated: true };
      } catch (error) {
        if (!['message_not_found', 'cant_update_message'].includes(error.data?.error)) throw error;
      }
    }
    const sent = await sendDirect(client, recipient, message);
    if (!sent.channel || !sent.ts) throw new Error('Slack did not return the status message identifiers');
    service.saveMessageCard({ requestId, recipientId: recipient, kind: 'MARKETER_PROGRESS',
      channelId: sent.channel, messageTs: sent.ts });
    return { updated: false, created: true };
  }

  async function flush() {
    if (running) return { sent: 0, skipped: true };
    running = true;
    let sent = 0;
    try {
      for (const notification of service.getPendingNotifications(50)) {
        const claimToken = randomUUID();
        if (!service.claimNotification(notification.id, claimToken)) continue;
        try {
          const summary = service.getRequestSummary(notification.request_id);
          if (canView(summary, notification.recipient_slack_user_id, ceoSlackUserId)) {
            if (['EFFORT_SUBMITTED', 'DELIVERY_SUBMITTED'].includes(notification.event_type)) {
              await refreshProgressCard(notification.request_id, { create: true });
            } else await sendDirect(client, notification.recipient_slack_user_id, notificationMessage(notification, summary));
          }
          service.markNotification(notification.id, 'SENT', claimToken);
          sent++;
        } catch (error) {
          logger.error(`Outbox #${notification.id} failed: ${error.message}`);
          try { service.markNotification(notification.id, 'FAILED', claimToken); }
          catch (claimError) { logger.error(`Outbox #${notification.id} claim release failed: ${claimError.message}`); }
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
  return { flush, start, stop, refreshProgressCard };
}
