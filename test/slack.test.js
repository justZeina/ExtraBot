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
  const updatedMessages = [];
  const openedViews = [];
  const pushedViews = [];
  const updatedViews = [];
  const client = {
    conversations: { open: async ({ users }) => ({ channel: { id: `D_${users}` } }) },
    chat: { postMessage: async message => { sent.push(message); return { ok: true, channel: message.channel, ts: String(sent.length) }; },
      update: async message => { updatedMessages.push(message); return { ok: true }; } },
    views: { open: async payload => { openedViews.push(payload); return { ok: true }; },
      push: async payload => { pushedViews.push(payload); return { ok: true }; },
      update: async payload => { updatedViews.push(payload); return { ok: true }; } }
  };
  const invokeAction = (actionId, payload) => {
    const route = actionRoutes.find(({ name }) => typeof name === 'string' ? name === actionId : name.test(actionId));
    assert.ok(route, `No action handler for ${actionId}`);
    return route.fn(payload);
  };
  return { app, handlers, client, sent, updatedMessages, openedViews, pushedViews, updatedViews, invokeAction };
}
const ack = () => async value => { ack.last = value; };

test('Slack form creates request and sends assignee notifications', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4], now: () => new Date('2026-09-29T08:00:00Z') });
  const f = fakeApp();
  const worker = createOutboxWorker({ service, client: f.client, ceoSlackUserId: 'CEO' });
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'],
    flushOutbox: worker.flush, syncCards: worker.syncCards });
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
    assert.equal(ack.last.view.callback_id, 'extra_created');
    assert.equal(f.sent.filter(x => x.channel === 'D_MARKETER').length, 1);
    assert.ok(f.sent.some(x => x.channel === 'D_MARKETER' && x.blocks[0].text.text.includes('Campaign')));
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

test('/extra list shows title and client with a working View button, without request numbers', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  const f = fakeApp();
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'],
    flushOutbox: async () => {} });
  try {
    service.createRequest({ client: 'Acme', title: 'Campaign', description: 'Assets', departments: [
      { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER');
    let response;
    await f.handlers.command['/extra']({ command: { text: 'list', user_id: 'MARKETER' }, ack: ack(),
      respond: async value => { response = value; }, client: f.client });
    assert.ok(response.blocks[0].text.text.includes('Campaign · Acme'));
    assert.ok(!response.blocks[0].text.text.includes('#'));
    const view = response.blocks[0].accessory;
    await f.invokeAction(view.action_id, { body: { user: { id: 'MARKETER' }, trigger_id: 'T1' },
      action: view, ack: ack(), client: f.client });
    assert.equal(f.openedViews.at(-1).view.title.text, 'Campaign');
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

test('team replies edit request cards and send only short marketer alerts', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  const f = fakeApp();
  const worker = createOutboxWorker({ service, client: f.client, ceoSlackUserId: 'CEO' });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Campaign assets', description: 'Prepare assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    await worker.flush();
    assert.equal(f.sent.filter(m => m.channel === 'D_MARKETER').length, 1);
    assert.equal(f.sent.filter(m => m.channel === 'D_CONTENT').length, 1);
    assert.equal(f.sent.filter(m => m.channel === 'D_ART').length, 1);
    assert.ok(!f.sent.some(m => m.text.includes('Extra #')));
    const contentCard = service.getMessageCard(id, 'CONTENT', 'EFFORT:1');
    const marketerCard = service.getMessageCard(id, 'MARKETER', 'MARKETER');
    const version = () => service.getRequestSummary(id).version;
    service.submitEffort({ requestId: id, department: 'Content', effort: 'Around two days', expectedVersion: version() }, 'CONTENT');
    await worker.flush();
    assert.equal(f.sent.filter(m => m.channel === 'D_CONTENT').length, 1);
    assert.ok(f.updatedMessages.some(m => m.channel === contentCard.channel_id && m.ts === contentCard.message_ts &&
      m.blocks[0].text.text.includes('Around two days')));
    assert.ok(f.updatedMessages.some(m => m.channel === marketerCard.channel_id && m.ts === marketerCard.message_ts &&
      m.blocks[0].text.text.includes('pending effort')));
    assert.deepEqual(f.sent.filter(m => m.channel === 'D_MARKETER').map(m => m.text).slice(1),
      ['🔴 Content replied · Campaign assets']);
    service.submitEffort({ requestId: id, department: 'Art', effort: 'After the brief', expectedVersion: version() }, 'ART');
    await worker.flush();
    assert.deepEqual(f.sent.filter(m => m.channel === 'D_MARKETER').map(m => m.text).slice(1),
      ['🔴 Content replied · Campaign assets', '✅ Estimates ready · Campaign assets']);
    assert.equal(f.sent.filter(m => m.channel === 'D_ART').length, 1);
  } finally { service.close(); }
});

test('submitting from an assignee DM leaves one DM and shows the filled request modal', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  const f = fakeApp();
  const worker = createOutboxWorker({ service, client: f.client, ceoSlackUserId: 'CEO' });
  registerSlackHandlers(f.app, { service, ceoSlackUserId: 'CEO', departments: ['Content', 'Art', 'Storytelling'],
    flushOutbox: worker.flush, syncCards: worker.syncCards });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Launch', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    await worker.flush();
    const contentDm = f.sent.find(m => m.channel === 'D_CONTENT');
    const submit = contentDm.blocks.flatMap(b => b.elements || []).find(e => e.text.text === 'Submit Content effort');
    await f.invokeAction(submit.action_id, { body: { user: { id: 'CONTENT' }, trigger_id: 'T1',
      channel: { id: 'D_CONTENT' }, message: { ts: '2' } }, action: submit, ack: ack(), client: f.client });
    const form = f.openedViews.at(-1).view;
    assert.equal(form.callback_id, 'extra_form');
    let formResponse;
    await f.handlers.view.extra_form({ body: { user: { id: 'CONTENT' } }, view: { private_metadata: form.private_metadata,
      blocks: form.blocks, state: { values: { amount: { value: { value: 'About two days' } },
        note: { value: { value: 'Needs review' } } } } }, ack: async value => { formResponse = value; }, client: f.client });
    assert.equal(formResponse.response_action, 'update');
    assert.equal(formResponse.view.callback_id, 'extra_request');
    assert.ok(formResponse.view.blocks[0].text.text.includes('About two days'));
    assert.equal(f.sent.filter(m => m.channel === 'D_CONTENT').length, 1);
    assert.deepEqual(f.sent.filter(m => m.channel === 'D_MARKETER').map(m => m.text).slice(1),
      ['🔴 Content replied · Launch']);
    assert.equal(service.getRequestSummary(id).departments.find(d => d.department_key === 'Content').effort_text, 'About two days');
  } finally { service.close(); }
});

test('CEO and Content-first delivery each get one actionable card', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4],
    now: () => new Date('2026-09-29T08:00:00Z') });
  const f = fakeApp();
  const worker = createOutboxWorker({ service, client: f.client, ceoSlackUserId: 'CEO' });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Launch', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    const version = () => service.getRequestSummary(id).version;
    await worker.flush();
    service.submitEffort({ requestId: id, department: 'Content', effort: 'Two days', expectedVersion: version() }, 'CONTENT');
    service.submitEffort({ requestId: id, department: 'Art', effort: 'Three days', expectedVersion: version() }, 'ART');
    await worker.flush();
    const approval = service.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER');
    await worker.flush();
    assert.equal(f.sent.filter(m => m.channel === 'D_CEO').length, 1);
    const ceoCard = service.getMessageCard(id, 'CEO', `CEO:${approval.approvalId}`);
    service.recordCeoDecision({ requestId: id, approvalId: approval.approvalId, decision: 'APPROVE',
      note: 'Proceed', expectedVersion: version() }, 'CEO');
    await worker.flush();
    assert.equal(f.sent.filter(m => m.channel === 'D_CEO').length, 1);
    assert.ok(f.updatedMessages.some(m => m.channel === ceoCard.channel_id && m.ts === ceoCard.message_ts));
    assert.ok(f.sent.some(m => m.channel === 'D_MARKETER' && m.text === '✅ CEO approved · Launch'));
    service.requestDeliveryTimes({ requestId: id, expectedVersion: version() }, 'MARKETER');
    await worker.flush();
    assert.equal(f.sent.filter(m => m.channel === 'D_CONTENT').length, 2);
    assert.equal(f.sent.filter(m => m.channel === 'D_ART').length, 1);
    service.submitDeliveryEstimate({ requestId: id, department: 'Content', deliveryAt: '2026-10-05T10:00:00Z',
      expectedVersion: version() }, 'CONTENT');
    await worker.flush();
    assert.equal(f.sent.filter(m => m.channel === 'D_ART').length, 2);
    assert.equal(f.sent.filter(m => m.channel === 'D_CONTENT').length, 2);
    service.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: '2026-10-06T10:00:00Z',
      expectedVersion: version() }, 'ART');
    await worker.flush();
    assert.ok(f.sent.some(m => m.channel === 'D_MARKETER' && m.text === '✅ Delivery dates ready · Launch'));
    service.approveFinalDelivery({ requestId: id, expectedVersion: version() }, 'MARKETER');
    await worker.flush();
    assert.ok(f.sent.some(m => m.channel === 'D_CONTENT' && m.text === '🚀 Approved to start · Launch'));
    assert.ok(f.sent.some(m => m.channel === 'D_ART' && m.text === '🚀 Approved to start · Launch'));
    assert.ok(!f.sent.some(m => m.channel === 'D_MARKETER' && m.text.includes('Approved to start')));
  } finally { service.close(); }
});

test('re-request creates a distinct round card while the old card becomes read-only', async () => {
  const service = createExtraService({ ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4] });
  const f = fakeApp();
  const worker = createOutboxWorker({ service, client: f.client, ceoSlackUserId: 'CEO' });
  try {
    const id = service.createRequest({ client: 'Acme', title: 'Launch', description: 'Assets', departments: [
      { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    const version = () => service.getRequestSummary(id).version;
    await worker.flush();
    const oldCard = service.getMessageCard(id, 'ART', 'EFFORT:1');
    service.submitEffort({ requestId: id, department: 'Art', effort: 'Three days', expectedVersion: version() }, 'ART');
    await worker.flush();
    service.reRequestEfforts({ requestId: id, departments: ['Art'], note: 'Include revisions', expectedVersion: version() }, 'MARKETER');
    await worker.flush();
    await worker.syncCards(id);
    assert.equal(f.sent.filter(m => m.channel === 'D_ART').length, 2);
    const newCard = service.getMessageCard(id, 'ART', 'EFFORT:2');
    assert.ok(newCard);
    assert.notEqual(newCard.message_ts, oldCard.message_ts);
    assert.ok(f.sent.filter(m => m.channel === 'D_ART').at(-1).blocks[0].text.text.includes('Include revisions'));
    const oldUpdate = f.updatedMessages.filter(m => m.channel === oldCard.channel_id && m.ts === oldCard.message_ts).at(-1);
    assert.ok(oldUpdate.blocks[0].text.text.includes('This round is complete'));
    assert.ok(!oldUpdate.blocks.flatMap(b => b.elements || []).some(b => b.text.text.includes('Submit Art effort')));
  } finally { service.close(); }
});
