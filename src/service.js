import { openDatabase } from './db.js';
import { fail, requireText } from './errors.js';
import { addWorkingMinutes, formatCairo, normalizeEffort, parseInstant, validateCalendar } from './time.js';

const EFFORT_STATES = ['COLLECTING_EFFORT', 'REVIEWING_EFFORT', 'CEO_CHANGES_REQUESTED'];
const DELIVERY_STATES = ['COLLECTING_DELIVERY', 'REVIEWING_DELIVERY'];
const json = value => JSON.stringify(value ?? null);

export function createExtraService({ dbPath = ':memory:', ceoSlackUserId, workingWeekdays, holidays = [], now = () => new Date() }) {
  const ceoId = requireText(ceoSlackUserId, 'ceoSlackUserId');
  const calendar = validateCalendar({ workingWeekdays, holidays });
  const db = openDatabase(dbPath);
  const stamp = () => new Date(now()).toISOString();
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function request(id) {
    const row = one('SELECT * FROM extra_requests WHERE id=?', id);
    if (!row) fail('NOT_FOUND', 'request not found');
    return row;
  }
  function department(requestId, key) {
    const row = one('SELECT * FROM request_departments WHERE request_id=? AND department_key=?', requestId, requireText(key, 'department'));
    if (!row) fail('NOT_FOUND', 'department not found on request');
    return row;
  }
  function departmentById(id) {
    const row = one('SELECT * FROM request_departments WHERE id=?', id);
    if (!row) fail('NOT_FOUND', 'department not found');
    return row;
  }
  function expectActor(actual, actorId) {
    if (actual !== requireText(actorId, 'actorId')) fail('FORBIDDEN', 'actor is not allowed to perform this action');
  }
  function expectState(req, states) {
    if (!states.includes(req.status)) fail('INVALID_STATE', `action is unavailable in ${req.status}`);
  }
  function checkVersion(req, expectedVersion) {
    if (!Number.isInteger(expectedVersion)) fail('VALIDATION_ERROR', 'expectedVersion is required');
    if (req.version !== expectedVersion) fail('STALE_VERSION', `request is at version ${req.version}`);
  }
  function mutate(requestId, expectedVersion, fn) {
    return transaction(() => {
      const req = request(requestId);
      checkVersion(req, expectedVersion);
      const result = fn(req);
      const t = stamp();
      run('UPDATE extra_requests SET version=version+1, updated_at=? WHERE id=? AND version=?', t, requestId, expectedVersion);
      return { ...result, version: expectedVersion + 1 };
    });
  }
  function audit(reqId, actor, type, before, after, note = null) {
    run('INSERT INTO audit_events(request_id,actor_slack_user_id,event_type,before_json,after_json,note,created_at) VALUES(?,?,?,?,?,?,?)',
      reqId, actor, type, before == null ? null : json(before), after == null ? null : json(after), note, stamp());
  }
  function notify(reqId, type, recipient, payload, key) {
    const t = stamp();
    run('INSERT OR IGNORE INTO notification_outbox(request_id,event_type,recipient_slack_user_id,payload_json,available_at,created_at,dedupe_key) VALUES(?,?,?,?,?,?,?)',
      reqId, type, recipient, json({ requestId: reqId, recipientId: recipient, ...payload }), t, t, key);
  }
  function notifyAssignments(reqId, type, teamRows, payload, keyPrefix) {
    const byRecipient = new Map();
    for (const d of teamRows) {
      const names = byRecipient.get(d.assignee_slack_user_id) ?? [];
      names.push(d.department_key);
      byRecipient.set(d.assignee_slack_user_id, names);
    }
    for (const [recipient, names] of byRecipient) {
      notify(reqId, type, recipient, { ...payload, departments: names, department: names[0] }, `${keyPrefix}:${recipient}`);
    }
  }
  function pending(reqId, kind) {
    return one("SELECT COUNT(*) AS n FROM proposals WHERE request_id=? AND status='PENDING' AND kind=?", reqId, kind).n;
  }
  function departments(reqId) { return all('SELECT * FROM request_departments WHERE request_id=? ORDER BY id', reqId); }
  function hasEffort(d) { return d.effort_submitted_at != null; }
  function effortLabel(d) { return d.effort_text ?? (d.effort_input_value == null ? null : `${d.effort_input_value} ${d.effort_input_unit}`); }
  function allEfforts(reqId) { return departments(reqId).every(hasEffort); }
  function allDeliveries(reqId) { return departments(reqId).every(d => d.estimated_delivery_at != null); }
  function validateDeliveryRelation(reqId, d, date) {
    const content = departments(reqId).find(x => x.department_key.toLowerCase() === 'content');
    if (!content) return;
    if (content.id === d.id) {
      if (departments(reqId).some(x => x.id !== d.id && x.estimated_delivery_at && x.estimated_delivery_at < date)) {
        fail('VALIDATION_ERROR', 'Content date cannot be after another department date');
      }
    } else {
      if (!content.estimated_delivery_at) fail('INVALID_STATE', 'Content must submit its delivery estimate first');
      if (date < content.estimated_delivery_at) fail('VALIDATION_ERROR', 'delivery cannot precede Content estimate');
    }
  }
  function setState(req, status, actor, note = null) {
    if (req.status === status) return;
    run('UPDATE extra_requests SET status=? WHERE id=?', status, req.id);
    audit(req.id, actor, 'STATE_CHANGED', { status: req.status }, { status }, note);
    req.status = status;
  }
  function scheduleReminder(reqId, dept, askedAt) {
    const due = addWorkingMinutes(askedAt, 420, calendar);
    run('INSERT INTO reminder_jobs(request_id,request_department_id,kind,due_at) VALUES(?,?,?,?)', reqId, dept.id, 'EFFORT_RESPONSE', due);
  }
  function cancelReminders(deptId) {
    run('UPDATE reminder_jobs SET cancelled_at=? WHERE request_department_id=? AND sent_at IS NULL AND cancelled_at IS NULL', stamp(), deptId);
  }
  function ensureNoPending(reqId, kind) {
    if (pending(reqId, kind)) fail('INVALID_STATE', 'resolve all proposals first');
  }
  function nextEffortState(req, actor) {
    if (allEfforts(req.id) && !pending(req.id, 'EFFORT')) {
      const wasReady = req.status === 'REVIEWING_EFFORT';
      setState(req, 'REVIEWING_EFFORT', actor);
      if (!wasReady) notify(req.id, 'ALL_EFFORTS_COLLECTED', req.marketer_slack_user_id,
        { round: req.effort_round, estimates: departments(req.id).map(d => ({ department: d.department_key,
          text: effortLabel(d), note: d.effort_note })) },
        `efforts-ready:${req.id}:${req.version + 1}`);
    } else if (req.status !== 'CEO_CHANGES_REQUESTED') setState(req, 'COLLECTING_EFFORT', actor);
  }
  function nextDeliveryState(req, actor) {
    if (allDeliveries(req.id) && !pending(req.id, 'DELIVERY')) {
      const wasReady = req.status === 'REVIEWING_DELIVERY';
      setState(req, 'REVIEWING_DELIVERY', actor);
      if (!wasReady) notify(req.id, 'ALL_DELIVERY_ESTIMATES_COLLECTED', req.marketer_slack_user_id,
        { round: req.delivery_round, dates: departments(req.id).map(d => ({ department: d.department_key,
          deliveryAt: d.estimated_delivery_at })) }, `delivery-ready:${req.id}:${req.version + 1}`);
    } else setState(req, 'COLLECTING_DELIVERY', actor);
  }
  function ceoSnapshot(reqId) {
    const req = request(reqId);
    return { client: req.client, title: req.title, description: req.description, departments: departments(reqId).map(d => ({
      department: d.department_key, assigneeSlackUserId: d.assignee_slack_user_id,
      effortMinutes: d.effort_minutes, effortText: effortLabel(d), effortInputValue: d.effort_input_value,
      effortInputUnit: d.effort_input_unit, effortNote: d.effort_note
    })), comments: all('SELECT department_key,author_slack_user_id,body,created_at FROM request_comments c LEFT JOIN request_departments d ON d.id=c.request_department_id WHERE c.request_id=? ORDER BY c.id', reqId),
      proposals: all("SELECT d.department_key,p.kind,p.current_value,p.proposed_value,p.note,p.status,p.response_note FROM proposals p JOIN request_departments d ON d.id=p.request_department_id WHERE p.request_id=? AND p.kind='EFFORT' ORDER BY p.id", reqId) };
  }
  function changeSummary(previous, current) {
    if (!previous) return [];
    const changes = [];
    for (const field of ['client', 'title', 'description']) if (previous[field] !== current[field]) changes.push({ field, before: previous[field], after: current[field] });
    const old = new Map(previous.departments.map(d => [d.department, {
      ...d, effortText: d.effortText ?? (d.effortInputValue == null ? null : `${d.effortInputValue} ${d.effortInputUnit}`)
    }]));
    for (const d of current.departments) {
      const prior = old.get(d.department);
      if (!prior) changes.push({ department: d.department, before: null, after: d });
      else for (const field of ['assigneeSlackUserId', 'effortMinutes', 'effortText', 'effortNote']) {
        if (prior[field] !== d[field]) changes.push({ department: d.department, field, before: prior[field], after: d[field] });
      }
      old.delete(d.department);
    }
    for (const [key, value] of old) changes.push({ department: key, before: value, after: null });
    return changes;
  }
  function latestApproval(reqId) {
    return one('SELECT * FROM approval_decisions WHERE request_id=? ORDER BY id DESC LIMIT 1', reqId);
  }

  function createRequest(input, actorId) {
    const actor = requireText(actorId, 'actorId');
    const client = input?.client == null ? '' : requireText(input.client, 'client');
    const title = requireText(input?.title, 'title');
    const description = requireText(input?.description, 'description');
    const selected = input?.departments;
    if (!Array.isArray(selected) || !selected.length) fail('VALIDATION_ERROR', 'select at least one department');
    const normalized = selected.map(d => ({ department: requireText(d.department, 'department'), assigneeId: requireText(d.assigneeId, 'assigneeId') }));
    if (new Set(normalized.map(d => d.department.toLowerCase())).size !== normalized.length) fail('VALIDATION_ERROR', 'departments must be unique');
    return transaction(() => {
      const t = stamp();
      const id = Number(run('INSERT INTO extra_requests(client,title,description,marketer_slack_user_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', client, title, description, actor, 'COLLECTING_EFFORT', t, t).lastInsertRowid);
      for (const item of normalized) {
        const deptId = Number(run('INSERT INTO request_departments(request_id,department_key,assignee_slack_user_id) VALUES(?,?,?)', id, item.department, item.assigneeId).lastInsertRowid);
        scheduleReminder(id, { id: deptId }, t);
      }
      notify(id, 'MARKETER_CREATED', actor, { title }, `marketer-created:${id}`);
      notifyAssignments(id, 'EFFORT_REQUESTED', departments(id), { title, round: 1 }, `effort-request:${id}:1`);
      audit(id, actor, 'REQUEST_CREATED', null, { client, title, description, departments: normalized });
      return getRequestSummary(id);
    });
  }
  function assignDepartment({ requestId, department: key, assigneeId, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    const target = requireText(assigneeId, 'assigneeId');
    const name = requireText(key, 'department');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, EFFORT_STATES);
      ensureNoPending(req.id, 'EFFORT');
      let d = one('SELECT * FROM request_departments WHERE request_id=? AND department_key=?', req.id, name);
      if (d) {
        if (d.assignee_slack_user_id === target) fail('VALIDATION_ERROR', 'assignee is unchanged');
        cancelReminders(d.id);
        run('UPDATE request_departments SET assignee_slack_user_id=?,effort_minutes=NULL,effort_input_value=NULL,effort_input_unit=NULL,effort_text=NULL,effort_note=NULL,effort_submitted_at=NULL WHERE id=?', target, d.id);
      } else {
        const id = Number(run('INSERT INTO request_departments(request_id,department_key,assignee_slack_user_id) VALUES(?,?,?)', req.id, name, target).lastInsertRowid);
        d = { id, assignee_slack_user_id: null };
      }
      scheduleReminder(req.id, d, stamp());
      notify(req.id, 'EFFORT_REQUESTED', target, { department: name }, `effort-request:${req.id}:${d.id}:${req.version + 1}`);
      audit(req.id, actor, 'DEPARTMENT_ASSIGNED', { department: name, assigneeId: d.assignee_slack_user_id }, { department: name, assigneeId: target });
      nextEffortState(req, actor);
      return { requestId, department: name, assigneeId: target };
    });
  }
  function updateRequestDetails({ requestId, client, title, description, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    const nextTitle = requireText(title, 'title');
    const nextDescription = requireText(description, 'description');
    const nextClient = client == null ? null : requireText(client, 'client');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, EFFORT_STATES);
      run('UPDATE extra_requests SET client=?,title=?,description=? WHERE id=?', nextClient ?? req.client, nextTitle, nextDescription, req.id);
      audit(req.id, actor, 'REQUEST_DETAILS_UPDATED', { client: req.client, title: req.title, description: req.description }, { client: nextClient ?? req.client, title: nextTitle, description: nextDescription });
      return { requestId, client: nextClient ?? req.client, title: nextTitle, description: nextDescription };
    });
  }
  function submitEffort({ requestId, department: key, effort, note = null, expectedVersion }, actorId, revise = false) {
    const actor = requireText(actorId, 'actorId');
    const normalized = typeof effort === 'string' ? null : normalizeEffort(effort, calendar.workingWeekdays.size);
    const estimate = normalized ? `${normalized.value} ${normalized.unit}` : requireText(effort, 'effort estimate');
    return mutate(requestId, expectedVersion, req => {
      expectState(req, EFFORT_STATES);
      const d = department(req.id, key);
      expectActor(d.assignee_slack_user_id, actor);
      if (revise !== hasEffort(d)) fail('INVALID_STATE', revise ? 'no prior estimate to revise' : 'use reviseOwnEffort for an existing estimate');
      if (one("SELECT id FROM proposals WHERE request_department_id=? AND kind='EFFORT' AND status='PENDING'", d.id)) fail('INVALID_STATE', 'respond to the pending proposal first');
      run('UPDATE request_departments SET effort_minutes=?,effort_input_value=?,effort_input_unit=?,effort_text=?,effort_note=?,effort_submitted_at=? WHERE id=?',
        normalized?.minutes ?? null, normalized?.value ?? null, normalized?.unit ?? null, estimate, note, stamp(), d.id);
      cancelReminders(d.id);
      audit(req.id, actor, revise ? 'EFFORT_REVISED' : 'EFFORT_SUBMITTED', { estimate: effortLabel(d), note: d.effort_note }, { estimate, note }, note);
      notify(req.id, 'EFFORT_SUBMITTED', req.marketer_slack_user_id,
        { department: key, assigneeId: actor, effortText: estimate, effortMinutes: normalized?.minutes ?? null,
          revised: revise, round: req.effort_round,
          pendingDepartments: departments(req.id).filter(x => !hasEffort(x)).map(x => ({ department: x.department_key, assigneeId: x.assignee_slack_user_id })) },
        `effort-submitted:${req.id}:${d.id}:${req.version + 1}`);
      nextEffortState(req, actor);
      return { requestId, department: key, effortText: estimate, effortMinutes: normalized?.minutes ?? null };
    });
  }
  function reRequestEfforts({ requestId, departments: selected, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    if (!Array.isArray(selected) || !selected.length || new Set(selected.map(x => String(x).toLowerCase())).size !== selected.length) {
      fail('VALIDATION_ERROR', 'choose one or more unique departments');
    }
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, ['REVIEWING_EFFORT', 'CEO_REJECTED']);
      ensureNoPending(req.id, 'EFFORT');
      const chosen = selected.map(key => department(req.id, key));
      const round = req.effort_round + 1;
      run('UPDATE extra_requests SET effort_round=? WHERE id=?', round, req.id);
      for (const d of chosen) {
        cancelReminders(d.id);
        run('UPDATE request_departments SET effort_minutes=NULL,effort_input_value=NULL,effort_input_unit=NULL,effort_text=NULL,effort_note=NULL,effort_submitted_at=NULL WHERE id=?', d.id);
        scheduleReminder(req.id, d, stamp());
      }
      notifyAssignments(req.id, 'EFFORT_REREQUESTED', chosen, { round, note }, `effort-rerequest:${req.id}:${round}`);
      setState(req, 'COLLECTING_EFFORT', actor, note);
      audit(req.id, actor, 'EFFORT_REREQUESTED', null, { departments: chosen.map(d => d.department_key), round, note }, note);
      return { requestId, departments: chosen.map(d => d.department_key), round };
    });
  }
  function addComment({ requestId, department: key = null, body, parentCommentId = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    const text = requireText(body, 'body');
    return mutate(requestId, expectedVersion, req => {
      expectState(req, [...EFFORT_STATES, ...DELIVERY_STATES]);
      const d = key == null ? null : department(req.id, key);
      if (actor !== req.marketer_slack_user_id && (!d || actor !== d.assignee_slack_user_id)) fail('FORBIDDEN', 'only the marketer or relevant assignee can comment');
      if (parentCommentId != null) {
        const parent = one('SELECT * FROM request_comments WHERE id=?', parentCommentId);
        if (!parent || parent.request_id !== req.id || parent.request_department_id !== d?.id) fail('VALIDATION_ERROR', 'parent comment does not belong to this thread');
      }
      const id = Number(run('INSERT INTO request_comments(request_id,request_department_id,author_slack_user_id,body,parent_comment_id,created_at) VALUES(?,?,?,?,?,?)',
        req.id, d?.id ?? null, actor, text, parentCommentId, stamp()).lastInsertRowid);
      audit(req.id, actor, 'COMMENT_ADDED', null, { id, department: key, body: text, parentCommentId });
      const recipient = actor === req.marketer_slack_user_id ? d?.assignee_slack_user_id : req.marketer_slack_user_id;
      if (recipient) notify(req.id, 'QUESTION_ADDED', recipient, { commentId: id, department: key, body: text }, `comment:${id}`);
      return { commentId: id };
    });
  }
  function propose(kind, { requestId, department: key, value, note, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    const proposalNote = requireText(note, 'note');
    const normalized = kind === 'EFFORT' ? normalizeEffort(value, calendar.workingWeekdays.size) : parseInstant(value, 'deliveryAt');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, kind === 'EFFORT' ? EFFORT_STATES : DELIVERY_STATES);
      const d = department(req.id, key);
      const current = kind === 'EFFORT' ? d.effort_minutes : d.estimated_delivery_at;
      if (current == null) fail('INVALID_STATE', 'assignee must submit an estimate first');
      if (one("SELECT id FROM proposals WHERE request_department_id=? AND kind=? AND status='PENDING'", d.id, kind)) fail('INVALID_STATE', 'a proposal is already pending');
      const next = kind === 'EFFORT' ? normalized.minutes : normalized;
      if (next >= current) fail('VALIDATION_ERROR', 'proposal must be earlier or require less effort');
      if (kind === 'DELIVERY' && next <= stamp()) fail('VALIDATION_ERROR', 'delivery date must be in the future');
      if (kind === 'DELIVERY') validateDeliveryRelation(req.id, d, next);
      const id = Number(run('INSERT INTO proposals(request_id,request_department_id,kind,proposed_by_slack_user_id,current_value,proposed_value,proposed_input_value,proposed_input_unit,note,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        req.id, d.id, kind, actor, String(current), String(next), kind === 'EFFORT' ? normalized.value : null,
        kind === 'EFFORT' ? normalized.unit : null, proposalNote, 'PENDING', stamp()).lastInsertRowid);
      audit(req.id, actor, `${kind}_CHANGE_PROPOSED`, { value: current }, { proposalId: id, value: next }, proposalNote);
      notify(req.id, kind === 'EFFORT' ? 'EFFORT_CHANGE_PROPOSED' : 'DELIVERY_CHANGE_PROPOSED', d.assignee_slack_user_id,
        { proposalId: id, department: key, currentValue: current, proposedValue: next, note: proposalNote }, `proposal:${id}`);
      if (kind === 'EFFORT' && req.status === 'REVIEWING_EFFORT') setState(req, 'COLLECTING_EFFORT', actor);
      if (kind === 'DELIVERY' && req.status === 'REVIEWING_DELIVERY') setState(req, 'COLLECTING_DELIVERY', actor);
      return { proposalId: id, proposedValue: next };
    });
  }
  function respond(kind, { proposalId, decision, counterValue = null, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    const p = one('SELECT * FROM proposals WHERE id=?', proposalId);
    if (!p || p.kind !== kind) fail('NOT_FOUND', 'proposal not found');
    if (!['ACCEPT', 'COUNTER'].includes(decision)) fail('VALIDATION_ERROR', 'decision must be ACCEPT or COUNTER');
    const counter = decision === 'COUNTER' ? (kind === 'EFFORT' ? normalizeEffort(counterValue, calendar.workingWeekdays.size) : parseInstant(counterValue, 'counterDate')) : null;
    return mutate(p.request_id, expectedVersion, req => {
      expectState(req, kind === 'EFFORT' ? EFFORT_STATES : DELIVERY_STATES);
      const fresh = one('SELECT * FROM proposals WHERE id=?', proposalId);
      if (fresh.status !== 'PENDING') fail('INVALID_STATE', 'proposal is already resolved');
      const d = departmentById(fresh.request_department_id);
      expectActor(d.assignee_slack_user_id, actor);
      const current = kind === 'EFFORT' ? d.effort_minutes : d.estimated_delivery_at;
      if (String(current) !== fresh.current_value) fail('STALE_VERSION', 'estimate changed since proposal');
      const next = decision === 'ACCEPT' ? fresh.proposed_value : kind === 'EFFORT' ? counter.minutes : counter;
      if (kind === 'DELIVERY' && next <= stamp()) fail('VALIDATION_ERROR', 'delivery date must be in the future');
      if (kind === 'DELIVERY') validateDeliveryRelation(req.id, d, next);
      if (kind === 'EFFORT') run('UPDATE request_departments SET effort_minutes=?,effort_input_value=?,effort_input_unit=?,effort_text=?,effort_note=?,effort_submitted_at=? WHERE id=?',
        Number(next), decision === 'ACCEPT' ? fresh.proposed_input_value : counter.value,
        decision === 'ACCEPT' ? fresh.proposed_input_unit : counter.unit,
        `${decision === 'ACCEPT' ? fresh.proposed_input_value : counter.value} ${decision === 'ACCEPT' ? fresh.proposed_input_unit : counter.unit}`,
        note, stamp(), d.id);
      else run('UPDATE request_departments SET estimated_delivery_at=?,delivery_note=?,delivery_submitted_at=? WHERE id=?', next, note, stamp(), d.id);
      run('UPDATE proposals SET status=?,response_note=?,responded_by_slack_user_id=?,resolved_at=? WHERE id=?',
        decision === 'ACCEPT' ? 'ACCEPTED' : 'COUNTERED', note, actor, stamp(), proposalId);
      audit(req.id, actor, 'PROPOSAL_RESPONDED', { proposalId, value: current }, { decision, value: next }, note);
      notify(req.id, 'PROPOSAL_RESPONDED', req.marketer_slack_user_id, { proposalId, department: d.department_key, decision, value: next, note }, `proposal-response:${proposalId}`);
      if (kind === 'EFFORT') nextEffortState(req, actor); else nextDeliveryState(req, actor);
      return { proposalId, decision, value: next };
    });
  }
  function lockAndRequestCeoApproval({ requestId, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, ['REVIEWING_EFFORT', 'CEO_CHANGES_REQUESTED']);
      if (!allEfforts(req.id)) fail('INVALID_STATE', 'every department must submit effort');
      ensureNoPending(req.id, 'EFFORT');
      const snapshot = ceoSnapshot(req.id);
      const last = latestApproval(req.id);
      const changes = changeSummary(last ? JSON.parse(last.snapshot_json) : null, snapshot);
      const approvalVersion = req.version + 1;
      const id = Number(run('INSERT INTO approval_decisions(request_id,request_version,snapshot_json,change_summary_json,ceo_slack_user_id,requested_at) VALUES(?,?,?,?,?,?)',
        req.id, approvalVersion, json(snapshot), json(changes), ceoId, stamp()).lastInsertRowid);
      setState(req, 'AWAITING_CEO', actor);
      audit(req.id, actor, 'CEO_APPROVAL_REQUESTED', null, { approvalId: id, requestVersion: approvalVersion, changes });
      notify(req.id, 'CEO_APPROVAL_REQUESTED', ceoId,
        { approvalId: id, requestVersion: approvalVersion, snapshot, changes, round: req.effort_round }, `ceo-request:${id}`);
      return { approvalId: id, requestVersion: approvalVersion, snapshot, changes };
    });
  }
  function recordCeoDecision({ requestId, approvalId, decision, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    if (!['APPROVE', 'REJECT', 'REQUEST_CHANGES'].includes(decision)) fail('VALIDATION_ERROR', 'decision must be APPROVE or REJECT');
    if (decision === 'REQUEST_CHANGES') requireText(note, 'note');
    return mutate(requestId, expectedVersion, req => {
      expectActor(ceoId, actor);
      expectState(req, ['AWAITING_CEO']);
      const approval = latestApproval(req.id);
      if (!approval || approval.id !== approvalId || approval.decision || approval.request_version !== req.version) fail('STALE_VERSION', 'approval is not the current locked version');
      const stored = decision === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
      run('UPDATE approval_decisions SET decision=?,comment=?,decided_at=? WHERE id=?', stored, note, stamp(), approvalId);
      if (decision === 'APPROVE') {
        run('UPDATE extra_requests SET ceo_approved_version=? WHERE id=?', approval.request_version, req.id);
        setState(req, 'APPROVED_AWAITING_DELIVERY_REQUEST', actor);
        notify(req.id, 'CEO_APPROVED', req.marketer_slack_user_id,
          { approvalId, note, round: req.effort_round }, `ceo-approved:${approvalId}`);
      } else if (decision === 'REJECT') {
        setState(req, 'CEO_REJECTED', actor, note);
        notify(req.id, 'CEO_REJECTED', req.marketer_slack_user_id,
          { approvalId, note, round: req.effort_round }, `ceo-rejected:${approvalId}`);
      } else {
        setState(req, 'CEO_CHANGES_REQUESTED', actor, note);
        notify(req.id, 'CEO_CHANGES_REQUESTED', req.marketer_slack_user_id, { approvalId, note }, `ceo-changes:${approvalId}`);
      }
      audit(req.id, actor, `CEO_${decision === 'REJECT' ? 'REJECTED' : stored}`, null, { approvalId, requestVersion: approval.request_version }, note);
      return { approvalId, decision: decision === 'REJECT' ? 'REJECTED' : stored };
    });
  }
  function dismissRequest({ requestId, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, ['CEO_REJECTED']);
      setState(req, 'DISMISSED', actor);
      audit(req.id, actor, 'REQUEST_DISMISSED', null, { status: 'DISMISSED' });
      return { requestId, status: 'DISMISSED' };
    });
  }
  function requestDeliveryTimes({ requestId, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, ['APPROVED_AWAITING_DELIVERY_REQUEST']);
      const round = req.delivery_round + 1;
      run('UPDATE extra_requests SET delivery_round=?,delivery_request_note=? WHERE id=?', round, note, req.id);
      setState(req, 'COLLECTING_DELIVERY', actor, note);
      const allDepartments = departments(req.id);
      const content = allDepartments.find(d => d.department_key.toLowerCase() === 'content');
      notifyAssignments(req.id, content ? 'CONTENT_DELIVERY_REQUESTED' : 'OTHER_DELIVERY_REQUESTED',
        content ? [content] : allDepartments, { contentDeliveryAt: null, note, round },
        `delivery-request:${req.id}:${round}:${content ? 'content' : 'others'}`);
      audit(req.id, actor, 'DELIVERY_TIMES_REQUESTED', null, { round, note }, note);
      return { requestId, round };
    });
  }
  function reRequestDeliveries({ requestId, departments: selected, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    if (!Array.isArray(selected) || !selected.length || new Set(selected.map(x => String(x).toLowerCase())).size !== selected.length) {
      fail('VALIDATION_ERROR', 'choose one or more unique departments');
    }
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, ['REVIEWING_DELIVERY']);
      ensureNoPending(req.id, 'DELIVERY');
      const allDepartments = departments(req.id);
      const content = allDepartments.find(d => d.department_key.toLowerCase() === 'content');
      const selectedIds = new Set(selected.map(key => department(req.id, key).id));
      if (content && selectedIds.has(content.id)) for (const d of allDepartments) selectedIds.add(d.id);
      const chosen = allDepartments.filter(d => selectedIds.has(d.id));
      const round = req.delivery_round + 1;
      run('UPDATE extra_requests SET delivery_round=?,delivery_request_note=? WHERE id=?', round, note, req.id);
      for (const d of chosen) {
        run('UPDATE request_departments SET estimated_delivery_at=NULL,delivery_note=NULL,delivery_submitted_at=NULL WHERE id=?', d.id);
      }
      setState(req, 'COLLECTING_DELIVERY', actor, note);
      notifyAssignments(req.id, 'DELIVERY_REREQUESTED', content && selectedIds.has(content.id) ? [content] : chosen,
        { contentDeliveryAt: content && !selectedIds.has(content.id) ? content.estimated_delivery_at : null, note, round },
        `delivery-rerequest:${req.id}:${round}`);
      audit(req.id, actor, 'DELIVERY_REREQUESTED', null, { departments: chosen.map(d => d.department_key), round, note }, note);
      return { requestId, departments: chosen.map(d => d.department_key), round };
    });
  }
  function submitDeliveryEstimate({ requestId, department: key, deliveryAt, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    const date = parseInstant(deliveryAt, 'deliveryAt');
    return mutate(requestId, expectedVersion, req => {
      expectState(req, DELIVERY_STATES);
      if (date <= stamp()) fail('VALIDATION_ERROR', 'delivery date must be in the future');
      const d = department(req.id, key);
      expectActor(d.assignee_slack_user_id, actor);
      const content = departments(req.id).find(x => x.department_key.toLowerCase() === 'content');
      validateDeliveryRelation(req.id, d, date);
      if (one("SELECT id FROM proposals WHERE request_department_id=? AND kind='DELIVERY' AND status='PENDING'", d.id)) fail('INVALID_STATE', 'respond to the pending proposal first');
      run('UPDATE request_departments SET estimated_delivery_at=?,delivery_note=?,delivery_submitted_at=? WHERE id=?', date, note, stamp(), d.id);
      audit(req.id, actor, d.estimated_delivery_at ? 'DELIVERY_REVISED' : 'DELIVERY_SUBMITTED', { deliveryAt: d.estimated_delivery_at }, { deliveryAt: date }, note);
      notify(req.id, 'DELIVERY_SUBMITTED', req.marketer_slack_user_id,
        { department: key, assigneeId: actor, deliveryAt: date, revised: Boolean(d.estimated_delivery_at), round: req.delivery_round,
          pendingDepartments: departments(req.id).filter(x => x.estimated_delivery_at == null).map(x => ({ department: x.department_key, assigneeId: x.assignee_slack_user_id })) },
        `delivery-submitted:${req.id}:${d.id}:${req.version + 1}`);
      if (content?.id === d.id && !d.estimated_delivery_at) {
        notifyAssignments(req.id, req.delivery_round > 1 ? 'DELIVERY_REREQUESTED' : 'OTHER_DELIVERY_REQUESTED',
          departments(req.id).filter(x => x.id !== d.id && !x.estimated_delivery_at),
          { contentDeliveryAt: date, note: req.delivery_request_note, round: req.delivery_round },
          `delivery-request:${req.id}:${req.delivery_round}:others`);
      }
      nextDeliveryState(req, actor);
      return { requestId, department: key, deliveryAt: date };
    });
  }
  function approveFinalDelivery({ requestId, note = null, expectedVersion }, actorId) {
    const actor = requireText(actorId, 'actorId');
    return mutate(requestId, expectedVersion, req => {
      expectActor(req.marketer_slack_user_id, actor);
      expectState(req, ['REVIEWING_DELIVERY']);
      if (!allDeliveries(req.id)) fail('INVALID_STATE', 'every department must submit a delivery estimate');
      ensureNoPending(req.id, 'DELIVERY');
      const finalDeliveryAt = departments(req.id).map(d => d.estimated_delivery_at).sort().at(-1);
      const t = stamp();
      run('UPDATE extra_requests SET final_delivery_at=?,final_note=?,finalized_at=? WHERE id=?', finalDeliveryAt, note, t, req.id);
      setState(req, 'FINALIZED', actor);
      audit(req.id, actor, 'FINAL_DELIVERY_APPROVED', null, { finalDeliveryAt, note }, note);
      for (const recipient of new Set(departments(req.id).map(d => d.assignee_slack_user_id))) {
        notify(req.id, 'FINAL_DELIVERY_APPROVED', recipient,
          { finalDeliveryAt, note, round: req.delivery_round }, `final:${req.id}:${recipient}`);
      }
      return { requestId, finalDeliveryAt };
    });
  }
  function getRequestSummary(requestId) {
    const req = request(requestId);
    const approval = latestApproval(requestId);
    return { ...req, finalDeliveryCairo: req.final_delivery_at && formatCairo(req.final_delivery_at),
      departments: departments(requestId).map(d => ({ ...d, estimatedDeliveryCairo: d.estimated_delivery_at && formatCairo(d.estimated_delivery_at) })),
      pendingProposals: all("SELECT * FROM proposals WHERE request_id=? AND status='PENDING' ORDER BY id", requestId),
      recentComments: all(`SELECT c.id,c.request_department_id,c.author_slack_user_id,c.body,c.parent_comment_id,c.created_at,d.department_key
        FROM request_comments c LEFT JOIN request_departments d ON d.id=c.request_department_id
        WHERE c.request_id=? ORDER BY c.id DESC LIMIT 10`, requestId).reverse(),
      latestApproval: approval && { ...approval, snapshot: JSON.parse(approval.snapshot_json), changes: JSON.parse(approval.change_summary_json ?? '[]') } };
  }
  function getRequestHistory(requestId) {
    request(requestId);
    return { auditEvents: all('SELECT * FROM audit_events WHERE request_id=? ORDER BY id', requestId).map(x => ({ ...x, before: x.before_json && JSON.parse(x.before_json), after: x.after_json && JSON.parse(x.after_json) })),
      comments: all('SELECT * FROM request_comments WHERE request_id=? ORDER BY id', requestId),
      proposals: all('SELECT * FROM proposals WHERE request_id=? ORDER BY id', requestId),
      approvals: all('SELECT * FROM approval_decisions WHERE request_id=? ORDER BY id', requestId).map(x => ({ ...x, snapshot: JSON.parse(x.snapshot_json), changes: JSON.parse(x.change_summary_json ?? '[]') })) };
  }
  function listRequestsForActor(actorId, limit = 20) {
    const actor = requireText(actorId, 'actorId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VALIDATION_ERROR', 'limit must be 1 to 100');
    return all(`SELECT DISTINCT r.id,r.client,r.title,r.status,r.version,r.updated_at
      FROM extra_requests r LEFT JOIN request_departments d ON d.request_id=r.id
      WHERE r.marketer_slack_user_id=? OR d.assignee_slack_user_id=? OR ?=?
      ORDER BY r.updated_at DESC,r.id DESC LIMIT ?`, actor, actor, actor, ceoId, limit);
  }
  function processDueReminders(nowValue = stamp()) {
    const dueAt = typeof nowValue === 'string' ? parseInstant(nowValue, 'now') : new Date(nowValue).toISOString();
    return transaction(() => {
      const jobs = all(`SELECT j.*,d.assignee_slack_user_id,d.department_key,d.effort_submitted_at,r.status,r.effort_round
        FROM reminder_jobs j JOIN request_departments d ON d.id=j.request_department_id
        JOIN extra_requests r ON r.id=j.request_id
        WHERE j.sent_at IS NULL AND j.cancelled_at IS NULL AND j.due_at<=? ORDER BY j.id`, dueAt);
      const reminders = new Map();
      for (const job of jobs) {
        if (job.effort_submitted_at == null && EFFORT_STATES.includes(job.status)) {
          const key = `${job.request_id}:${job.assignee_slack_user_id}:${job.effort_round}`;
          const group = reminders.get(key) ?? { requestId: job.request_id, recipientId: job.assignee_slack_user_id,
            round: job.effort_round, departments: [], jobIds: [] };
          group.departments.push(job.department_key);
          group.jobIds.push(job.id);
          reminders.set(key, group);
          run('UPDATE reminder_jobs SET sent_at=? WHERE id=?', dueAt, job.id);
        } else run('UPDATE reminder_jobs SET cancelled_at=? WHERE id=?', dueAt, job.id);
      }
      for (const reminder of reminders.values()) {
        notify(reminder.requestId, 'EFFORT_REMINDER', reminder.recipientId,
          { department: reminder.departments[0], departments: reminder.departments, round: reminder.round },
          `reminder:${reminder.jobIds.join('-')}`);
      }
      return { queued: reminders.size };
    });
  }
  function getPendingNotifications(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('VALIDATION_ERROR', 'limit must be 1 to 1000');
    const nowAt = stamp();
    const expiredAt = new Date(new Date(nowAt).getTime() - 120_000).toISOString();
    return all("SELECT * FROM notification_outbox WHERE status IN ('PENDING','FAILED') AND available_at<=? AND (claim_token IS NULL OR claimed_at<=?) ORDER BY id LIMIT ?", nowAt, expiredAt, limit)
      .map(x => ({ ...x, payload: JSON.parse(x.payload_json) }));
  }
  function claimNotification(id, token) {
    const claim = requireText(token, 'token');
    return transaction(() => {
      const nowAt = stamp();
      const expiredAt = new Date(new Date(nowAt).getTime() - 120_000).toISOString();
      return run("UPDATE notification_outbox SET claim_token=?,claimed_at=? WHERE id=? AND status IN ('PENDING','FAILED') AND available_at<=? AND (claim_token IS NULL OR claimed_at<=?)",
        claim, nowAt, id, nowAt, expiredAt).changes === 1;
    });
  }
  function markNotification(id, status, claimToken = null) {
    if (!['SENT', 'FAILED'].includes(status)) fail('VALIDATION_ERROR', 'notification status must be SENT or FAILED');
    return transaction(() => {
      const row = one('SELECT * FROM notification_outbox WHERE id=?', id);
      if (!row) fail('NOT_FOUND', 'notification not found');
      if (row.status === 'SENT') return { id, status: 'SENT' };
      if (claimToken != null && row.claim_token !== claimToken) fail('STALE_VERSION', 'notification claim is no longer owned');
      const retryDelayMs = Math.min(2 ** Math.min(row.attempt_count, 8) * 5_000, 15 * 60_000);
      const nextAvailable = status === 'FAILED' ? new Date(new Date(stamp()).getTime() + retryDelayMs).toISOString() : row.available_at;
      run('UPDATE notification_outbox SET status=?,attempt_count=attempt_count+1,sent_at=?,available_at=?,claim_token=NULL,claimed_at=NULL WHERE id=?',
        status, status === 'SENT' ? stamp() : null, nextAvailable, id);
      return { id, status };
    });
  }
  function getMessageCard(requestId, recipientId, kind) {
    return one('SELECT * FROM request_message_cards WHERE request_id=? AND recipient_slack_user_id=? AND kind=?',
      requestId, requireText(recipientId, 'recipientId'), requireText(kind, 'kind')) ?? null;
  }
  function listMessageCards(requestId) {
    return all('SELECT * FROM request_message_cards WHERE request_id=? ORDER BY kind,recipient_slack_user_id', requestId);
  }
  function saveMessageCard({ requestId, recipientId, kind, channelId, messageTs, departments: assigned = [], note = null }) {
    return transaction(() => {
      run(`INSERT INTO request_message_cards(request_id,recipient_slack_user_id,kind,channel_id,message_ts,updated_at,departments_json,note)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(request_id,recipient_slack_user_id,kind)
        DO UPDATE SET channel_id=excluded.channel_id,message_ts=excluded.message_ts,updated_at=excluded.updated_at,
          departments_json=excluded.departments_json,note=excluded.note`,
      requestId, requireText(recipientId, 'recipientId'), requireText(kind, 'kind'),
      requireText(channelId, 'channelId'), requireText(messageTs, 'messageTs'), stamp(), json(assigned), note);
    });
  }
  return {
    close: () => db.close(), createRequest, assignDepartment, updateRequestDetails,
    submitEffort: (input, actor) => submitEffort(input, actor, false),
    reviseOwnEffort: (input, actor) => submitEffort(input, actor, true), reRequestEfforts, addComment,
    proposeEffortChange: (input, actor) => propose('EFFORT', input, actor),
    respondToEffortProposal: (input, actor) => respond('EFFORT', input, actor),
    lockAndRequestCeoApproval, recordCeoDecision, dismissRequest, requestDeliveryTimes,
    submitDeliveryEstimate, reRequestDeliveries,
    proposeDeliveryChange: (input, actor) => propose('DELIVERY', input, actor),
    respondToDeliveryProposal: (input, actor) => respond('DELIVERY', input, actor),
    approveFinalDelivery, getRequestSummary, getRequestHistory, listRequestsForActor, processDueReminders,
    getPendingNotifications, claimNotification, markNotification,
    getMessageCard, listMessageCards, saveMessageCard
  };
}
