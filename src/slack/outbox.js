import { randomUUID } from 'node:crypto';
import { canView, cardMessage, notificationMessage, shortAlert } from './views.js';
import { sendDirect } from './handlers.js';

const effortRequests = new Set(['EFFORT_REQUESTED', 'EFFORT_REREQUESTED']);
const deliveryRequests = new Set(['CONTENT_DELIVERY_REQUESTED', 'OTHER_DELIVERY_REQUESTED', 'DELIVERY_REREQUESTED']);
const shortEvents = new Set(['EFFORT_SUBMITTED', 'DELIVERY_SUBMITTED', 'ALL_EFFORTS_COLLECTED',
  'ALL_DELIVERY_ESTIMATES_COLLECTED', 'CEO_APPROVED', 'CEO_REJECTED', 'FINAL_DELIVERY_APPROVED',
  'EFFORT_REMINDER', 'QUESTION_ADDED']);

export function createOutboxWorker({ service, client, ceoSlackUserId, departments = ['Content', 'Art', 'Storytelling'], logger = console }) {
  let running = false;
  let outboxTimer;
  let reminderTimer;

  async function syncCards(requestId) {
    const summary = service.getRequestSummary(requestId);
    let updated = 0;
    for (const card of service.listMessageCards(requestId)) {
      try {
        await client.chat.update({ channel: card.channel_id, ts: card.message_ts,
          ...cardMessage(summary, card, ceoSlackUserId, departments) });
        updated++;
      } catch (error) { logger.error(`Could not update request card: ${error.message}`); }
    }
    return { updated };
  }

  async function sendCard(notification, summary, kind) {
    const recipientId = notification.recipient_slack_user_id;
    const existing = service.getMessageCard(summary.id, recipientId, kind);
    const assigned = notification.payload.departments ?? (notification.payload.department ? [notification.payload.department] : []);
    const allDepartments = [...new Set([...(existing ? JSON.parse(existing.departments_json || '[]') : []), ...assigned])];
    const card = { ...existing, request_id: summary.id, recipient_slack_user_id: recipientId, kind,
      departments_json: JSON.stringify(allDepartments), note: notification.payload.note ?? existing?.note ?? null };
    const message = cardMessage(summary, card, ceoSlackUserId, departments);
    if (existing) {
      await client.chat.update({ channel: existing.channel_id, ts: existing.message_ts, ...message });
      service.saveMessageCard({ requestId: summary.id, recipientId, kind, channelId: existing.channel_id,
        messageTs: existing.message_ts, departments: allDepartments, note: card.note });
      return { created: false };
    }
    const sent = await sendDirect(client, recipientId, message);
    if (!sent.channel || !sent.ts) throw new Error('Slack did not return message identifiers');
    service.saveMessageCard({ requestId: summary.id, recipientId, kind, channelId: sent.channel,
      messageTs: sent.ts, departments: allDepartments, note: card.note });
    return { created: true };
  }

  async function deliver(notification, summary) {
    const event = notification.event_type;
    const payload = notification.payload;
    if (event === 'MARKETER_CREATED') return sendCard(notification, summary, 'MARKETER');
    if (effortRequests.has(event)) return sendCard(notification, summary, `EFFORT:${payload.round ?? summary.effort_round}`);
    if (event === 'CEO_APPROVAL_REQUESTED') return sendCard(notification, summary, `CEO:${payload.approvalId}`);
    if (deliveryRequests.has(event)) {
      const result = await sendCard(notification, summary, `DELIVERY:${payload.round ?? summary.delivery_round}`);
      if (!result.created) await sendDirect(client, notification.recipient_slack_user_id,
        { text: `🔴 ${payload.departments?.join(', ') || payload.department} delivery date needed · ${summary.title}` });
      return result;
    }
    if (shortEvents.has(event)) {
      if (['EFFORT_SUBMITTED', 'DELIVERY_SUBMITTED', 'CEO_APPROVED', 'CEO_REJECTED', 'FINAL_DELIVERY_APPROVED'].includes(event)) {
        await syncCards(summary.id);
      }
      if (event === 'EFFORT_SUBMITTED' && summary.status === 'REVIEWING_EFFORT' && payload.round === summary.effort_round) return;
      if (event === 'DELIVERY_SUBMITTED' && summary.status === 'REVIEWING_DELIVERY' && payload.round === summary.delivery_round) return;
      return sendDirect(client, notification.recipient_slack_user_id, shortAlert(event, summary, payload));
    }
    return sendDirect(client, notification.recipient_slack_user_id, notificationMessage(notification, summary));
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
          if (canView(summary, notification.recipient_slack_user_id, ceoSlackUserId)) await deliver(notification, summary);
          service.markNotification(notification.id, 'SENT', claimToken);
          sent++;
        } catch (error) {
          logger.error(`Outbox ${notification.id} failed: ${error.message}`);
          try { service.markNotification(notification.id, 'FAILED', claimToken); }
          catch (claimError) { logger.error(`Could not release outbox claim: ${claimError.message}`); }
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
  return { flush, start, stop, syncCards };
}
