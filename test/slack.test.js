import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtraService } from '../src/service.js';
import { registerSlackHandlers } from '../src/slack/handlers.js';
import { createOutboxWorker } from '../src/slack/outbox.js';
import { canView, createDetailsView, notificationMessage, parseDepartments, summaryMessage } from '../src/slack/views.js';

function fakeApp() {
  const handlers = { command: {}, shortcut: {}, view: {}, action: {} };
  const actionRoutes = [];
  const app = Object.fromEntries(Object.keys(handlers).map(type => [type, (name, fn) => {
    handlers[type][name] = fn;
    if (type === 'action') actionRoutes.push({ name, fn });
  }]));
  const sent = [];
  const openedViews = [];
  const pushedViews = [];
  const updatedViews = [];
  const client = {
    conversations: { open: async ({ users }) => ({ channel: { id: `D_${users}` } }) },
    chat: { postMessage: async message => { sent.push(message); return { ok: true }; } },
    views: { open: async payload => { openedViews.push(payload); return { ok: true }; },
      push: async payload => { pushedViews.push(payload); return { ok: true }; },
      update: async payload => { updatedViews.push(payload); return { ok: true }; } }
  };
  const invokeAction = (actionId, payload) => {
    const route = actionRoutes.find(({ name }) => typeof name === 'string' ? name === actionId : name.test(actionId));
    assert.ok(route, `No action handler for ${actionId}`);
    return route.fn(payload);
  };
  return { app, handlers, client, sent, openedViews, pushedViews, updatedViews, invokeAction };
}
const ack = () => async value => { ack.last = value; };

test('Slack form creates request and sends assignee notifications', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4], now: () => new Date('2026-09-29T08:00:00Z') });
  const f = fakeApp();
  const worker = createOutboxWorker({ service, client: f.client, ceoSlackUserId: 'CEO' });
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'], flushOutbox: worker.flush });
  try {
    await f.handlers.command['/extra']({ command: { text: '', user_id: 'MARKETER', trigger_id: 'trigger' }, ack: ack(), client: f.client });
    assert.equal(f.openedViews[0].view.callback_id, 'extra_create');
    assert.deepEqual(f.openedViews[0].view.blocks.map(x => x.label.text),
      ['Title', 'Client', 'Description', 'Content assignee', 'Art assignee', 'Storytelling assignee']);

    await f.handlers.view.extra_create({ body: { user: { id: 'MARKETER' } }, view: {
      state: { values: { client: { value: { value: 'Acme' } }, title: { value: { value: 'Campaign' } },
        description: { value: { value: 'Extra work' } }, assignee_0: { value: { selected_user: 'CONTENT' } },
        assignee_1: { value: { selected_user: 'ART' } }, assignee_2: { value: { selected_user: 'STORY' } } } }
    }, ack: ack(), client: f.client });
    assert.equal(service.getRequestSummary(1).departments.length, 3);
    assert.equal(service.getRequestSummary(1).client, 'Acme');
    assert.ok(f.sent.some(x => x.channel === 'D_MARKETER' && x.blocks[0].text.text.includes('was sent')));
    assert.ok(f.sent.some(x => x.channel === 'D_CONTENT'));
    assert.ok(f.sent.some(x => x.channel === 'D_ART'));
    assert.ok(f.sent.some(x => x.channel === 'D_STORY'));
    assert.equal(service.getPendingNotifications().length, 0);
  } finally { service.close(); }
});

test('current request actions are role-specific', () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  try {
    const id = service.createRequest({ title: 'One', description: 'Two', departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER').id;
    const summary = service.getRequestSummary(id);
    assert.equal(canView(summary, 'OUTSIDER', 'CEO'), false);
    assert.equal(canView(summary, 'ART', 'CEO'), true);
    const marketer = summaryMessage(summary, 'MARKETER', 'CEO', ['Art']);
    const assignee = summaryMessage(summary, 'ART', 'CEO', ['Art']);
    assert.ok(marketer.blocks.some(b => b.elements?.some(x => x.text.text === 'Edit request')));
    assert.ok(assignee.blocks.some(b => b.elements?.some(x => x.text.text === 'Submit effort: Art')));
    assert.ok(!assignee.blocks.some(b => b.elements?.some(x => x.text.text === 'Edit request')));
  } finally { service.close(); }
});

test('department list is configurable and rejects duplicates', () => {
  assert.deepEqual(parseDepartments('Content, Art, Storytelling'), ['Content', 'Art', 'Storytelling']);
  assert.throws(() => parseDepartments('Art,art'));
  assert.equal(createDetailsView(['Content']).blocks[3].label.text, 'Content assignee');
});

test('requester can assign any one department and leave the others empty', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  const f = fakeApp();
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'], flushOutbox: async () => {} });
  try {
    const values = { client: { value: { value: 'Acme' } }, title: { value: { value: 'Campaign' } },
      description: { value: { value: 'Extra work' } } };
    let response;
    await f.handlers.view.extra_create({ body: { user: { id: 'MARKETER' } }, view: { state: { values } },
      ack: async value => { response = value; }, client: f.client });
    assert.equal(response.response_action, 'errors');
    assert.ok(response.errors.assignee_0);
    values.assignee_1 = { value: { selected_user: 'ART' } };
    await f.handlers.view.extra_create({ body: { user: { id: 'MARKETER' } }, view: { state: { values } },
      ack: async value => { response = value; }, client: f.client });
    assert.equal(service.getRequestSummary(1).departments.length, 1);
    assert.equal(service.getRequestSummary(1).departments[0].department_key, 'Art');
  } finally { service.close(); }
});

test('notification button opens an actionable request modal and effort form', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4], now: () => new Date('2026-09-29T08:00:00Z') });
  const f = fakeApp();
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'], flushOutbox: async () => {} });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Campaign', description: 'Extra work',
      departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER').id;
    await f.invokeAction('extra_view', { body: { user: { id: 'ART' }, trigger_id: 'view-trigger' },
      action: { value: JSON.stringify({ requestId: id }) }, ack: ack(), client: f.client });
    const requestModal = f.openedViews.at(-1).view;
    assert.equal(requestModal.callback_id, 'extra_request');
    const modalActionIds = requestModal.blocks.flatMap(b => (b.elements || []).map(x => x.action_id));
    assert.equal(new Set(modalActionIds).size, modalActionIds.length);
    const effortButton = requestModal.blocks.flatMap(b => b.elements || []).find(x => x.text.text === 'Submit effort: Art');
    assert.ok(effortButton);
    await f.invokeAction(effortButton.action_id, { body: { user: { id: 'ART' }, trigger_id: 'form-trigger', view: { ...requestModal, id: 'V1' } },
      action: effortButton, ack: ack(), client: f.client });
    assert.equal(f.updatedViews[0].view.callback_id, 'extra_form');
    let formAck;
    await f.handlers.view.extra_form({ body: { user: { id: 'ART' } }, view: { private_metadata: f.updatedViews[0].view.private_metadata,
      blocks: f.updatedViews[0].view.blocks, state: { values: { amount: { value: { value: 'About two days, pending assets' } },
        note: { value: { value: 'Draft plus review' } } } } },
      ack: async value => { formAck = value; }, client: f.client });
    assert.equal(service.getRequestSummary(id).departments[0].effort_text, 'About two days, pending assets');
    assert.equal(service.getRequestSummary(id).departments[0].effort_minutes, null);
    assert.equal(service.getRequestSummary(id).departments[0].effort_note, 'Draft plus review');
    assert.equal(formAck.response_action, 'update');
    assert.equal(formAck.view.callback_id, 'extra_request');
    assert.ok(service.getPendingNotifications().some(n => n.event_type === 'EFFORT_SUBMITTED' && n.recipient_slack_user_id === 'MARKETER'));
  } finally { service.close(); }
});

test('CEO approval waits for marketer to request Content-first delivery', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4],
    now: () => new Date('2026-09-29T08:00:00Z') });
  const f = fakeApp();
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'], flushOutbox: async () => {} });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Campaign', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    const version = () => service.getRequestSummary(id).version;
    service.submitEffort({ requestId: id, department: 'Content', effort: { value: 2, unit: 'hours' }, expectedVersion: version() }, 'CONTENT');
    service.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'hours' }, expectedVersion: version() }, 'ART');
    const approval = service.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER');
    await f.invokeAction('extra_ceo_approve', { body: { user: { id: 'CEO' }, view: { id: 'CEO_VIEW' } },
      action: { value: JSON.stringify({ requestId: id, approvalId: approval.approvalId }) }, ack: ack(), client: f.client });
    assert.equal(service.getRequestSummary(id).status, 'APPROVED_AWAITING_DELIVERY_REQUEST');
    assert.equal(f.updatedViews.at(-1).view.callback_id, 'extra_request');
    assert.ok(f.updatedViews.at(-1).view.blocks[0].text.text.includes('CEO approved'));
    await f.invokeAction('extra_request_delivery', { body: { user: { id: 'MARKETER' }, view: { id: 'MARKETER_VIEW' } },
      action: { value: JSON.stringify({ requestId: id }) }, ack: ack(), client: f.client });
    assert.equal(service.getRequestSummary(id).status, 'COLLECTING_DELIVERY');
    service.submitDeliveryEstimate({ requestId: id, department: 'Content', deliveryAt: '2026-10-05T10:00:00Z', expectedVersion: version() }, 'CONTENT');
    service.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: '2026-10-06T10:00:00Z', expectedVersion: version() }, 'ART');
    const review = summaryMessage(service.getRequestSummary(id), 'MARKETER', 'CEO', ['Content', 'Art', 'Storytelling']);
    assert.ok(review.blocks[0].text.text.includes('delivery window'));
    const finalButton = review.blocks.flatMap(b => b.elements || []).find(x => x.text.text === 'Approve and start');
    assert.ok(finalButton);
    await f.invokeAction(finalButton.action_id, { body: { user: { id: 'MARKETER' }, trigger_id: 'final-trigger' },
      action: finalButton, ack: ack(), client: f.client });
    assert.equal(service.getRequestSummary(id).status, 'FINALIZED');
    assert.ok(service.getPendingNotifications().some(n => n.event_type === 'FINAL_DELIVERY_APPROVED' && n.recipient_slack_user_id === 'ART'));
  } finally { service.close(); }
});

test('stage notifications show pending teams and the next two decisions', () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Campaign', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    const version = () => service.getRequestSummary(id).version;
    service.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'hours' }, expectedVersion: version() }, 'ART');
    let notice = service.getPendingNotifications().find(n => n.event_type === 'EFFORT_SUBMITTED');
    let message = notificationMessage(notice, service.getRequestSummary(id));
    assert.ok(message.blocks[0].text.text.includes('Submitted by: <@ART>'));
    assert.ok(message.blocks[0].text.text.includes('Content <@CONTENT>'));
    service.submitEffort({ requestId: id, department: 'Content', effort: { value: 2, unit: 'hours' }, expectedVersion: version() }, 'CONTENT');
    notice = service.getPendingNotifications().find(n => n.event_type === 'ALL_EFFORTS_COLLECTED');
    message = notificationMessage(notice, service.getRequestSummary(id));
    assert.ok(message.text.includes('round 1'));
    assert.deepEqual(message.blocks.flatMap(b => b.elements || []).map(x => x.text.text),
      ['Send to CEO', 'Re-request estimates']);
    const approval = service.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER');
    notice = service.getPendingNotifications().find(n => n.event_type === 'CEO_APPROVAL_REQUESTED');
    message = notificationMessage(notice, service.getRequestSummary(id));
    assert.deepEqual(message.blocks.flatMap(b => b.elements || []).map(x => x.text.text),
      ['Approve', 'Reject']);
    service.recordCeoDecision({ requestId: id, approvalId: approval.approvalId, decision: 'REJECT', note: 'Reduce scope', expectedVersion: version() }, 'CEO');
    notice = service.getPendingNotifications().find(n => n.event_type === 'CEO_REJECTED');
    message = notificationMessage(notice, service.getRequestSummary(id));
    assert.ok(message.blocks[0].text.text.includes('Reduce scope'));
    assert.deepEqual(message.blocks.flatMap(b => b.elements || []).map(x => x.text.text),
      ['Re-request estimates', 'Dismiss permanently']);
  } finally { service.close(); }
});

test('marketer re-request form and CEO decision form carry optional notes', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  const f = fakeApp();
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'], flushOutbox: async () => {} });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Campaign', description: 'Assets',
      departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER').id;
    const version = () => service.getRequestSummary(id).version;
    service.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'hours' }, expectedVersion: version() }, 'ART');
    const ready = summaryMessage(service.getRequestSummary(id), 'MARKETER', 'CEO', ['Content', 'Art', 'Storytelling']);
    const rerequest = ready.blocks.flatMap(b => b.elements || []).find(x => x.text.text === 'Re-request estimates');
    await f.invokeAction(rerequest.action_id, { body: { user: { id: 'MARKETER' }, trigger_id: 're-trigger' },
      action: rerequest, ack: ack(), client: f.client });
    const reForm = f.openedViews.at(-1).view;
    assert.equal(reForm.submit.text, 'Re-request');
    await f.handlers.view.extra_form({ body: { user: { id: 'MARKETER' } }, view: { private_metadata: reForm.private_metadata,
      blocks: reForm.blocks, state: { values: { departments: { value: { selected_options: [{ value: 'Art' }] } },
        note: { value: { value: 'Please include review time' } } } } }, ack: ack(), client: f.client });
    assert.equal(service.getRequestSummary(id).effort_round, 2);
    assert.ok(service.getPendingNotifications().some(n => n.event_type === 'EFFORT_REREQUESTED' && n.payload.note === 'Please include review time'));
    service.submitEffort({ requestId: id, department: 'Art', effort: { value: 4, unit: 'hours' }, expectedVersion: version() }, 'ART');
    const approval = service.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER');
    const ceo = summaryMessage(service.getRequestSummary(id), 'CEO', 'CEO', ['Content', 'Art', 'Storytelling']);
    const approve = ceo.blocks.flatMap(b => b.elements || []).find(x => x.text.text === 'Approve');
    await f.invokeAction(approve.action_id, { body: { user: { id: 'CEO' }, trigger_id: 'ceo-trigger' },
      action: approve, ack: ack(), client: f.client });
    const ceoForm = f.openedViews.at(-1).view;
    assert.equal(ceoForm.submit.text, 'Approve');
    assert.equal(ceoForm.blocks.find(b => b.block_id === 'note').optional, true);
    await f.handlers.view.extra_form({ body: { user: { id: 'CEO' } }, view: { private_metadata: ceoForm.private_metadata,
      blocks: ceoForm.blocks, state: { values: { note: { value: { value: 'Proceed' } } } } },
      ack: ack(), client: f.client });
    assert.equal(service.getRequestSummary(id).latestApproval.comment, 'Proceed');
    assert.equal(service.getRequestSummary(id).status, 'APPROVED_AWAITING_DELIVERY_REQUEST');
    assert.ok(service.getPendingNotifications().some(n => n.event_type === 'CEO_APPROVED' && n.payload.note === 'Proceed'));
    assert.equal(approval.approvalId, service.getRequestSummary(id).latestApproval.id);
  } finally { service.close(); }
});
