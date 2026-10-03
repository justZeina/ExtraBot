import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtraService } from '../src/service.js';
import { loadConfig, loadSlackConfig } from '../src/config.js';
import { addWorkingMinutes, normalizeEffort, validateCalendar } from '../src/time.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'extrabot-'));
  const dbPath = join(dir, 'workflow.sqlite');
  let time = new Date('2026-09-29T08:00:00.000Z'); // 11:00 Cairo
  const open = () => createExtraService({ dbPath, ceoSlackUserId: 'CEO', workingWeekdays: [0, 1, 2, 3, 4], now: () => time });
  let service = open();
  const setTime = value => { time = new Date(value); };
  const refresh = id => service.getRequestSummary(id).version;
  const close = () => { service.close(); rmSync(dir, { recursive: true, force: true }); };
  return { get service() { return service; }, reopen() { service.close(); service = open(); }, setTime, refresh, close };
}
function expectCode(fn, code) { assert.throws(fn, error => error.code === code); }

test('configured CEO and Sunday–Thursday workweek load by default', () => {
  assert.deepEqual(loadConfig({}), { ceoSlackUserId: 'U0C542YNA7M', workingWeekdays: [0, 1, 2, 3, 4], holidays: [] });
});

test('Slack token configuration requires both token types', () => {
  assert.deepEqual(loadSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' }),
    { botToken: 'xoxb-test', appToken: 'xapp-test' });
  expectCode(() => loadSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-test' }), 'VALIDATION_ERROR');
  expectCode(() => loadSlackConfig({ SLACK_BOT_TOKEN: 'xapp-wrong', SLACK_APP_TOKEN: 'xapp-test' }), 'VALIDATION_ERROR');
});

test('working time skips nonworking hours and configured days; efforts use seven-hour days', () => {
  const cal = validateCalendar({ workingWeekdays: [0, 1, 2, 3, 4], holidays: [] });
  assert.equal(addWorkingMinutes('2026-09-30T13:30:00.000Z', 420, cal), '2026-10-01T13:30:00.000Z');
  assert.equal(addWorkingMinutes('2026-10-01T13:30:00.000Z', 420, cal), '2026-10-04T13:30:00.000Z');
  assert.equal(normalizeEffort({ value: 2, unit: 'working_weeks' }, 5).minutes, 4200);
  assert.equal(addWorkingMinutes('2026-09-29T08:00:00.000Z', 420, validateCalendar({ workingWeekdays: [0, 1, 2, 3, 4], holidays: ['2026-09-30'] })), '2026-10-01T08:00:00.000Z');
});

test('effort, CEO revisions, Content-first delivery, and final schedule survive restart', () => {
  const f = fixture();
  try {
    const s = f.service;
    const created = s.createRequest({ title: 'Extras', description: 'Campaign', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }, { department: 'Media', assigneeId: 'MEDIA' }
    ] }, 'MARKETER');
    const id = created.id;
    expectCode(() => s.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'working_days' }, expectedVersion: f.refresh(id) }, 'WRONG'), 'FORBIDDEN');
    expectCode(() => s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER'), 'INVALID_STATE');
    s.submitEffort({ requestId: id, department: 'Content', effort: { value: 1, unit: 'working_days' }, expectedVersion: f.refresh(id) }, 'CONTENT');
    const q = s.addComment({ requestId: id, department: 'Art', body: 'Which formats?', expectedVersion: f.refresh(id) }, 'ART');
    s.addComment({ requestId: id, department: 'Art', body: 'Social.', parentCommentId: q.commentId, expectedVersion: f.refresh(id) }, 'MARKETER');
    s.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'working_days' }, expectedVersion: f.refresh(id) }, 'ART');
    s.submitEffort({ requestId: id, department: 'Media', effort: { value: 2, unit: 'hours' }, expectedVersion: f.refresh(id) }, 'MEDIA');
    const proposal = s.proposeEffortChange({ requestId: id, department: 'Art', value: { value: 2, unit: 'working_days' }, note: 'Can we be faster?', expectedVersion: f.refresh(id) }, 'MARKETER');
    expectCode(() => s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER'), 'INVALID_STATE');
    s.respondToEffortProposal({ proposalId: proposal.proposalId, decision: 'COUNTER', counterValue: { value: 2.5, unit: 'working_days' }, note: 'Need more time.', expectedVersion: f.refresh(id) }, 'ART');
    assert.equal(s.getRequestSummary(id).departments.find(d => d.department_key === 'Art').effort_minutes, 1050);
    const a1 = s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    expectCode(() => s.reviseOwnEffort({ requestId: id, department: 'Art', effort: { value: 2, unit: 'working_days' }, expectedVersion: f.refresh(id) }, 'ART'), 'INVALID_STATE');
    expectCode(() => s.recordCeoDecision({ requestId: id, approvalId: a1.approvalId, decision: 'APPROVE', expectedVersion: f.refresh(id) }, 'MARKETER'), 'FORBIDDEN');
    s.recordCeoDecision({ requestId: id, approvalId: a1.approvalId, decision: 'REQUEST_CHANGES', note: 'Reduce Art.', expectedVersion: f.refresh(id) }, 'CEO');
    s.reviseOwnEffort({ requestId: id, department: 'Art', effort: { value: 2, unit: 'working_days' }, expectedVersion: f.refresh(id) }, 'ART');
    const a2 = s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    assert.ok(a2.changes.some(c => c.department === 'Art' && c.field === 'effortMinutes'));
    expectCode(() => s.recordCeoDecision({ requestId: id, approvalId: a1.approvalId, decision: 'APPROVE', expectedVersion: f.refresh(id) }, 'CEO'), 'STALE_VERSION');
    s.recordCeoDecision({ requestId: id, approvalId: a2.approvalId, decision: 'APPROVE', expectedVersion: f.refresh(id) }, 'CEO');
    s.requestDeliveryTimes({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    const dates = ['2026-10-05T10:00:00Z', '2026-10-06T10:00:00Z', '2026-10-08T10:00:00Z'];
    expectCode(() => s.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: dates[1], expectedVersion: f.refresh(id) }, 'ART'), 'INVALID_STATE');
    s.submitDeliveryEstimate({ requestId: id, department: 'Content', deliveryAt: dates[0], expectedVersion: f.refresh(id) }, 'CONTENT');
    s.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: dates[1], expectedVersion: f.refresh(id) }, 'ART');
    s.submitDeliveryEstimate({ requestId: id, department: 'Media', deliveryAt: dates[2], expectedVersion: f.refresh(id) }, 'MEDIA');
    const dp = s.proposeDeliveryChange({ requestId: id, department: 'Media', value: dates[1], note: 'Earlier?', expectedVersion: f.refresh(id) }, 'MARKETER');
    expectCode(() => s.approveFinalDelivery({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER'), 'INVALID_STATE');
    s.respondToDeliveryProposal({ proposalId: dp.proposalId, decision: 'ACCEPT', expectedVersion: f.refresh(id) }, 'MEDIA');
    s.approveFinalDelivery({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    assert.equal(s.getRequestSummary(id).final_delivery_at, dates[1].replace('Z', '.000Z'));
    expectCode(() => s.approveFinalDelivery({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER'), 'INVALID_STATE');
    const history = s.getRequestHistory(id);
    assert.equal(history.approvals.length, 2);
    assert.equal(history.proposals.length, 2);
    f.reopen();
    assert.equal(f.service.getRequestSummary(id).status, 'FINALIZED');
    assert.equal(f.service.getRequestHistory(id).approvals[0].snapshot.departments.find(d => d.department === 'Art').effortMinutes, 1050);
  } finally { f.close(); }
});

test('reminders are queued once across repeated runs and restarts', () => {
  const f = fixture();
  try {
    const id = f.service.createRequest({ title: 'One', description: 'Two', departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER').id;
    assert.equal(f.service.processDueReminders('2026-09-29T14:00:00Z').queued, 0);
    assert.equal(f.service.processDueReminders('2026-09-30T08:00:00Z').queued, 1);
    assert.equal(f.service.processDueReminders('2026-09-30T09:00:00Z').queued, 0);
    f.reopen();
    assert.equal(f.service.processDueReminders('2026-09-30T09:00:00Z').queued, 0);
    assert.equal(f.service.getPendingNotifications().filter(n => n.event_type === 'EFFORT_REMINDER').length, 1);
    f.service.submitEffort({ requestId: id, department: 'Art', effort: { value: 1, unit: 'hours' }, expectedVersion: f.refresh(id) }, 'ART');
  } finally { f.close(); }
});

test('concurrent versions and invalid input are rejected', () => {
  const f = fixture();
  try {
    const id = f.service.createRequest({ title: 'One', description: 'Two', departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER').id;
    const version = f.refresh(id);
    f.service.addComment({ requestId: id, body: 'Global note', expectedVersion: version }, 'MARKETER');
    expectCode(() => f.service.submitEffort({ requestId: id, department: 'Art', effort: { value: 1, unit: 'hours' }, expectedVersion: version }, 'ART'), 'STALE_VERSION');
    expectCode(() => f.service.submitEffort({ requestId: id, department: 'Art', effort: { value: -1, unit: 'hours' }, expectedVersion: f.refresh(id) }, 'ART'), 'VALIDATION_ERROR');
    expectCode(() => f.service.addComment({ requestId: id, body: 'Unauthorized', expectedVersion: f.refresh(id) }, 'ART'), 'FORBIDDEN');
  } finally { f.close(); }
});

test('a request without Content collects delivery dates in parallel and records title changes', () => {
  const f = fixture();
  try {
    const s = f.service;
    const id = s.createRequest({ title: 'Initial', description: 'Draft', departments: [
      { department: 'Art', assigneeId: 'ART' }, { department: 'Media', assigneeId: 'MEDIA' }
    ] }, 'MARKETER').id;
    s.submitEffort({ requestId: id, department: 'Art', effort: { value: 1, unit: 'hours' }, expectedVersion: f.refresh(id) }, 'ART');
    s.submitEffort({ requestId: id, department: 'Media', effort: { value: 2, unit: 'hours' }, expectedVersion: f.refresh(id) }, 'MEDIA');
    const a1 = s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    s.recordCeoDecision({ requestId: id, approvalId: a1.approvalId, decision: 'REQUEST_CHANGES', note: 'Fix the title.', expectedVersion: f.refresh(id) }, 'CEO');
    s.updateRequestDetails({ requestId: id, title: 'Revised', description: 'Draft', expectedVersion: f.refresh(id) }, 'MARKETER');
    const a2 = s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    assert.ok(a2.changes.some(c => c.field === 'title'));
    s.recordCeoDecision({ requestId: id, approvalId: a2.approvalId, decision: 'APPROVE', expectedVersion: f.refresh(id) }, 'CEO');
    s.requestDeliveryTimes({ requestId: id, expectedVersion: f.refresh(id) }, 'MARKETER');
    s.submitDeliveryEstimate({ requestId: id, department: 'Media', deliveryAt: '2026-10-04T10:00:00Z', expectedVersion: f.refresh(id) }, 'MEDIA');
    s.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: '2026-10-05T10:00:00Z', expectedVersion: f.refresh(id) }, 'ART');
    s.approveFinalDelivery({ requestId: id, note: 'Ready for launch', expectedVersion: f.refresh(id) }, 'MARKETER');
    assert.equal(s.getRequestSummary(id).final_delivery_at, '2026-10-05T10:00:00.000Z');
    assert.equal(s.getRequestSummary(id).final_note, 'Ready for launch');
  } finally { f.close(); }
});

test('outbox delivery can be marked sent and does not reappear', () => {
  const f = fixture();
  try {
    f.service.createRequest({ title: 'One', description: 'Two', departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER');
    const message = f.service.getPendingNotifications().find(n => n.event_type === 'EFFORT_REQUESTED');
    assert.equal(message.payload.recipientId, 'ART');
    f.service.markNotification(message.id, 'FAILED');
    assert.equal(f.service.getPendingNotifications().filter(n => n.id === message.id).length, 0);
    f.setTime('2026-09-29T08:00:06Z');
    assert.equal(f.service.getPendingNotifications().filter(n => n.id === message.id).length, 1);
    f.service.markNotification(message.id, 'SENT');
    f.reopen();
    assert.equal(f.service.getPendingNotifications().filter(n => n.id === message.id).length, 0);
  } finally { f.close(); }
});

test('marketer re-requests selected effort and can re-request or dismiss after CEO rejection', () => {
  const f = fixture();
  try {
    const s = f.service;
    const id = s.createRequest({ client: 'Acme', title: 'Campaign', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    const version = () => f.refresh(id);
    s.submitEffort({ requestId: id, department: 'Content', effort: { value: 2, unit: 'hours' }, expectedVersion: version() }, 'CONTENT');
    s.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'hours' }, expectedVersion: version() }, 'ART');
    s.reRequestEfforts({ requestId: id, departments: ['Art'], note: 'Please include revisions', expectedVersion: version() }, 'MARKETER');
    let summary = s.getRequestSummary(id);
    assert.equal(summary.effort_round, 2);
    assert.equal(summary.status, 'COLLECTING_EFFORT');
    assert.equal(summary.departments.find(d => d.department_key === 'Content').effort_minutes, 120);
    assert.equal(summary.departments.find(d => d.department_key === 'Art').effort_minutes, null);
    assert.ok(s.getPendingNotifications().some(n => n.event_type === 'EFFORT_REREQUESTED' && n.payload.note === 'Please include revisions' && n.payload.round === 2));
    expectCode(() => s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER'), 'INVALID_STATE');
    s.submitEffort({ requestId: id, department: 'Art', effort: { value: 4, unit: 'hours' }, note: 'Revised estimate', expectedVersion: version() }, 'ART');
    const approval = s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER');
    s.recordCeoDecision({ requestId: id, approvalId: approval.approvalId, decision: 'REJECT', note: 'Try a smaller scope', expectedVersion: version() }, 'CEO');
    assert.equal(s.getRequestSummary(id).status, 'CEO_REJECTED');
    s.reRequestEfforts({ requestId: id, departments: ['Content'], expectedVersion: version() }, 'MARKETER');
    summary = s.getRequestSummary(id);
    assert.equal(summary.effort_round, 3);
    assert.equal(summary.departments.find(d => d.department_key === 'Content').effort_minutes, null);
    assert.equal(summary.departments.find(d => d.department_key === 'Art').effort_minutes, 240);
    const second = s.createRequest({ title: 'Another', description: 'Work', departments: [{ department: 'Art', assigneeId: 'ART' }] }, 'MARKETER').id;
    s.submitEffort({ requestId: second, department: 'Art', effort: { value: 1, unit: 'hours' }, expectedVersion: f.refresh(second) }, 'ART');
    const secondApproval = s.lockAndRequestCeoApproval({ requestId: second, expectedVersion: f.refresh(second) }, 'MARKETER');
    s.recordCeoDecision({ requestId: second, approvalId: secondApproval.approvalId, decision: 'REJECT', expectedVersion: f.refresh(second) }, 'CEO');
    s.dismissRequest({ requestId: second, expectedVersion: f.refresh(second) }, 'MARKETER');
    assert.equal(s.getRequestSummary(second).status, 'DISMISSED');
    expectCode(() => s.reRequestEfforts({ requestId: second, departments: ['Art'], expectedVersion: f.refresh(second) }, 'MARKETER'), 'INVALID_STATE');
  } finally { f.close(); }
});

test('delivery request and re-request preserve Content priority and notify all teams on final approval', () => {
  const f = fixture();
  try {
    const s = f.service;
    const id = s.createRequest({ title: 'Campaign', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'CONTENT' }, { department: 'Art', assigneeId: 'ART' }
    ] }, 'MARKETER').id;
    const version = () => f.refresh(id);
    for (const [department, actor] of [['Content', 'CONTENT'], ['Art', 'ART']]) {
      s.submitEffort({ requestId: id, department, effort: { value: 1, unit: 'hours' }, expectedVersion: version() }, actor);
    }
    const approval = s.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'MARKETER');
    s.recordCeoDecision({ requestId: id, approvalId: approval.approvalId, decision: 'APPROVE', note: 'Go ahead', expectedVersion: version() }, 'CEO');
    assert.equal(s.getRequestSummary(id).status, 'APPROVED_AWAITING_DELIVERY_REQUEST');
    assert.equal(s.getPendingNotifications().filter(n => n.event_type.includes('DELIVERY_REQUESTED')).length, 0);
    s.requestDeliveryTimes({ requestId: id, note: 'Please confirm the launch date', expectedVersion: version() }, 'MARKETER');
    let notices = s.getPendingNotifications().filter(n => n.event_type.includes('DELIVERY_REQUESTED'));
    assert.deepEqual(notices.map(n => n.recipient_slack_user_id), ['CONTENT']);
    assert.equal(notices[0].payload.note, 'Please confirm the launch date');
    s.submitDeliveryEstimate({ requestId: id, department: 'Content', deliveryAt: '2026-10-05T10:00:00Z', expectedVersion: version() }, 'CONTENT');
    notices = s.getPendingNotifications().filter(n => n.event_type === 'OTHER_DELIVERY_REQUESTED');
    assert.equal(notices[0].recipient_slack_user_id, 'ART');
    assert.equal(notices[0].payload.contentDeliveryAt, '2026-10-05T10:00:00.000Z');
    s.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: '2026-10-06T10:00:00Z', expectedVersion: version() }, 'ART');
    s.reRequestDeliveries({ requestId: id, departments: ['Content'], note: 'Please reconfirm', expectedVersion: version() }, 'MARKETER');
    assert.equal(s.getRequestSummary(id).delivery_round, 2);
    assert.ok(s.getRequestSummary(id).departments.every(d => d.estimated_delivery_at == null));
    notices = s.getPendingNotifications().filter(n => n.event_type === 'DELIVERY_REREQUESTED');
    assert.deepEqual(notices.map(n => n.recipient_slack_user_id), ['CONTENT']);
    s.submitDeliveryEstimate({ requestId: id, department: 'Content', deliveryAt: '2026-10-07T10:00:00Z', expectedVersion: version() }, 'CONTENT');
    notices = s.getPendingNotifications().filter(n => n.event_type === 'DELIVERY_REREQUESTED');
    assert.equal(notices.at(-1).recipient_slack_user_id, 'ART');
    assert.equal(notices.at(-1).payload.note, 'Please reconfirm');
    s.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: '2026-10-08T10:00:00Z', expectedVersion: version() }, 'ART');
    s.approveFinalDelivery({ requestId: id, expectedVersion: version() }, 'MARKETER');
    const recipients = s.getPendingNotifications().filter(n => n.event_type === 'FINAL_DELIVERY_APPROVED').map(n => n.recipient_slack_user_id);
    assert.deepEqual(new Set(recipients), new Set(['CONTENT', 'ART']));
  } finally { f.close(); }
});

test('one assignee receives one initial request for multiple departments and outbox claims are exclusive', () => {
  const f = fixture();
  try {
    const id = f.service.createRequest({ client: 'Acme', title: 'Campaign', description: 'Assets', departments: [
      { department: 'Content', assigneeId: 'SAME' }, { department: 'Art', assigneeId: 'SAME' }
    ] }, 'MARKETER').id;
    const notices = f.service.getPendingNotifications();
    const assignments = notices.filter(n => n.event_type === 'EFFORT_REQUESTED');
    assert.equal(assignments.length, 1);
    assert.deepEqual(assignments[0].payload.departments, ['Content', 'Art']);
    assert.ok(notices.some(n => n.event_type === 'MARKETER_CREATED' && n.request_id === id));
    assert.equal(f.service.claimNotification(assignments[0].id, 'first'), true);
    assert.equal(f.service.claimNotification(assignments[0].id, 'second'), false);
    f.service.markNotification(assignments[0].id, 'SENT', 'first');
    assert.ok(!f.service.getPendingNotifications().some(n => n.id === assignments[0].id));
  } finally { f.close(); }
});

test('a retried Slack modal submission creates one request', () => {
  const f = fixture();
  try {
    const input = { client: 'Acme', title: 'Campaign', description: 'Assets', submissionKey: 'team:marketer:view-123',
      departments: [{ department: 'Art', assigneeId: 'ART' }] };
    const first = f.service.createRequest(input, 'MARKETER');
    const second = f.service.createRequest(input, 'MARKETER');
    assert.equal(second.id, first.id);
    assert.equal(f.service.listRequestsForActor('MARKETER').length, 1);
    assert.equal(f.service.getPendingNotifications().filter(n => n.event_type === 'EFFORT_REQUESTED').length, 1);
  } finally { f.close(); }
});
