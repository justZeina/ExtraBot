import { formatCairo } from '../time.js';

const plain = text => ({ type: 'plain_text', text: String(text) });
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const clipped = (value, max = 2500) => escape(String(value ?? '')).slice(0, max);
const hasEffort = department => department.effort_submitted_at != null;
const effortText = department => department.effort_text ?? (department.effort_input_value == null
  ? 'pending' : `${department.effort_input_value} ${department.effort_input_unit}`);
const input = (id, label, element, optional = false) => ({ type: 'input', block_id: id, label: plain(label), element: { ...element, action_id: 'value' }, optional });
const textInput = (id, label, initial = undefined, multiline = false, optional = false) => input(id, label,
  { type: 'plain_text_input', ...(initial != null ? { initial_value: String(initial) } : {}), multiline }, optional);
const button = (label, action, data, style) => ({ type: 'button', text: plain(label), action_id: action,
  value: JSON.stringify(data), ...(style ? { style } : {}) });
const actionBlocks = buttons => {
  const blocks = [];
  for (let i = 0; i < buttons.length; i += 5) blocks.push({ type: 'actions', elements: buttons.slice(i, i + 5) });
  return blocks;
};
const modal = (callbackId, title, blocks, metadata = '') => ({ type: 'modal', callback_id: callbackId,
  title: plain(title), submit: plain('Save'), close: plain('Cancel'), private_metadata: metadata, blocks });

export function parseDepartments(raw) {
  const values = raw.split(',').map(x => x.trim()).filter(Boolean);
  if (!values.length || values.length > 15 || new Set(values.map(x => x.toLowerCase())).size !== values.length) {
    throw new Error('EXTRABOT_DEPARTMENTS must list 1 to 15 unique department names');
  }
  return values;
}

export function createDetailsView(departments) {
  const view = modal('extra_create', 'New Extra Request', [
    textInput('title', 'Title'),
    textInput('client', 'Client'),
    textInput('description', 'Description', undefined, true),
    ...departments.map((name, index) => input(`assignee_${index}`, `${name} assignee`,
      { type: 'users_select', placeholder: plain('Choose a person (optional)') }, true))
  ]);
  view.submit = plain('Send');
  return view;
}

export function formView(kind, context, summary, departments) {
  const metadata = JSON.stringify({ kind, ...context, expectedVersion: summary.version });
  const department = context.department;
  const effortUnit = { type: 'static_select', placeholder: plain('Choose unit'), options: [
    { text: plain('Hours'), value: 'hours' },
    { text: plain('Working days'), value: 'working_days' },
    { text: plain('Working weeks'), value: 'working_weeks' }
  ] };
  const blocks = [];
  const details = () => ({ type: 'section', text: { type: 'mrkdwn', text:
    `*${clipped(summary.title, 150)}*\n*Client:* ${clipped(summary.client || '—', 100)}\n*Description:* ${clipped(summary.description, 1000)}\n*Requested by:* <@${summary.marketer_slack_user_id}>` } });
  if (kind === 'effort') {
    blocks.push(details());
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${clipped(department)} effort request · round ${summary.effort_round}*` }] });
    const existing = summary.departments.find(d => d.department_key === department);
    blocks.push(textInput('amount', 'Effort estimate', existing && hasEffort(existing) ? effortText(existing) : undefined, true));
    blocks.push(textInput('note', 'Optional Note', undefined, true, true));
  } else if (['propose_effort', 'counter_effort'].includes(kind)) {
    blocks.push(textInput('amount', 'Effort amount, e.g. 2.5'));
    blocks.push(input('unit', 'Unit', effortUnit));
    blocks.push(textInput('note', kind === 'propose_effort' ? 'Reason for proposal' : 'Note or question', undefined, true, kind !== 'propose_effort'));
  } else if (kind === 'delivery') {
    blocks.push(details());
    const content = summary.departments.find(d => d.department_key.toLowerCase() === 'content');
    if (department?.toLowerCase() !== 'content' && content?.estimated_delivery_at) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Content estimated delivery: *${formatCairo(content.estimated_delivery_at)}*. Your date must be on or after this.` } });
    }
    blocks.push(input('delivery_at', 'Estimated delivery date and time', { type: 'datetimepicker' }));
  } else if (['propose_delivery', 'counter_delivery'].includes(kind)) {
    blocks.push(input('delivery_at', 'Estimated delivery date and time', { type: 'datetimepicker' }));
    blocks.push(textInput('note', kind === 'propose_delivery' ? 'Reason for earlier date' : 'Note', undefined, true, kind !== 'propose_delivery'));
  } else if (kind === 'rerequest_effort' || kind === 'rerequest_delivery') {
    blocks.push(details());
    blocks.push(input('departments', 'Teams to re-request', { type: 'multi_static_select',
      placeholder: plain('Choose one or more teams'),
      options: summary.departments.map(d => ({ text: plain(d.department_key), value: d.department_key })) }));
    if (kind === 'rerequest_delivery' && summary.departments.some(d => d.department_key.toLowerCase() === 'content')) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'If Content is selected, every other team will be re-requested after Content replies.' }] });
    }
    blocks.push(textInput('note', 'Optional Note', undefined, true, true));
  } else if (kind === 'ceo_decision') {
    blocks.push(details());
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary.departments.map(d =>
      `• *${clipped(d.department_key)}:* ${clipped(effortText(d), 300)}${d.effort_note ? ` · ${clipped(d.effort_note, 180)}` : ''}`).join('\n') } });
    blocks.push(textInput('note', 'Optional Note', undefined, true, true));
  } else if (kind === 'delivery_request') {
    blocks.push(details());
    blocks.push(textInput('note', 'Optional Note', undefined, true, true));
  } else if (kind === 'comment' || kind === 'ceo_changes') {
    blocks.push(textInput('note', kind === 'comment' ? 'Question, answer, or note' : 'Changes requested', undefined, true));
  } else if (kind === 'assign') {
    blocks.push(input('department', 'Department', { type: 'static_select', options: departments.map(name => ({ text: plain(name), value: name })) }));
    blocks.push(input('assignee', 'Assigned person', { type: 'users_select', placeholder: plain('Choose a person') }));
  } else if (kind === 'details') {
    blocks.push(textInput('client', 'Client', summary.client));
    blocks.push(textInput('title', 'Title', summary.title));
    blocks.push(textInput('description', 'Description', summary.description, true));
  } else if (kind === 'finalize') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Review delivery dates before approval.*\n${summary.departments.map(d => `• ${clipped(d.department_key)}: ${formatCairo(d.estimated_delivery_at)}`).join('\n')}` } });
    blocks.push(textInput('note', 'Final note (optional)', undefined, true, true));
  } else throw new Error(`Unknown form ${kind}`);
  const view = modal('extra_form', `${kind.replaceAll('_', ' ').slice(0, 20)}`, blocks, metadata);
  view.submit = plain(kind === 'finalize' ? 'Approve' : kind === 'ceo_decision' ? context.decision === 'APPROVE' ? 'Approve' : 'Reject'
    : kind === 'rerequest_effort' || kind === 'rerequest_delivery' ? 'Re-request'
      : kind === 'ceo_changes' ? 'Send edits' : kind === 'propose_effort' || kind === 'propose_delivery' ? 'Propose' : 'Send');
  return view;
}

function action(label, actionId, requestId, extra = {}, style) {
  return button(label, actionId, { requestId, ...extra }, style);
}

export function canView(summary, actor, ceoId) {
  return actor === summary.marketer_slack_user_id || actor === ceoId || summary.departments.some(d => d.assignee_slack_user_id === actor);
}

export function statusLabel(status) {
  return ({ COLLECTING_EFFORT: 'Waiting for team effort estimates', REVIEWING_EFFORT: 'Ready for marketer review',
    AWAITING_CEO: 'Waiting for CEO decision', CEO_CHANGES_REQUESTED: 'CEO requested edits',
    CEO_REJECTED: 'Rejected by CEO · marketer decision needed',
    APPROVED_AWAITING_DELIVERY_REQUEST: 'CEO approved · awaiting delivery request',
    COLLECTING_DELIVERY: 'Collecting delivery dates',
    REVIEWING_DELIVERY: 'Ready for marketer approval', FINALIZED: 'Approved · teams may start',
    DISMISSED: 'Dismissed permanently' })[status] || status;
}

export function summaryMessage(summary, actor, ceoId, configuredDepartments) {
  const id = summary.id;
  const lines = [`*${clipped(summary.title, 200)}*`, `*Client:* ${clipped(summary.client || '—', 150)}`,
    `*Description:* ${clipped(summary.description, 1000)}`, `*Requested by:* <@${summary.marketer_slack_user_id}>`,
    `*Status:* ${statusLabel(summary.status)} · *Effort round:* ${summary.effort_round} · *Delivery round:* ${summary.delivery_round}`];
  const contentDelivery = summary.departments.find(d => d.department_key.toLowerCase() === 'content')?.estimated_delivery_at;
  for (const d of summary.departments) {
    const effort = hasEffort(d) ? clipped(effortText(d), 300) : 'pending effort';
    const delivery = d.estimated_delivery_at ? (contentDelivery && d.department_key.toLowerCase() !== 'content'
      ? ` · delivery window ${formatCairo(contentDelivery)} → ${formatCairo(d.estimated_delivery_at)}`
      : ` · delivery ${formatCairo(d.estimated_delivery_at)}`) : '';
    const notes = [d.effort_note, d.delivery_note].filter(Boolean).map(x => clipped(x, 160)).join(' / ');
    lines.push(`• *${clipped(d.department_key, 80)}* — <@${d.assignee_slack_user_id}> · ${effort}${delivery}${notes ? ` · note: ${notes}` : ''}`);
  }
  if (summary.final_delivery_at) lines.push(`*Final delivery:* ${formatCairo(summary.final_delivery_at)}`);
  if (summary.final_note) lines.push(`*Final note:* ${clipped(summary.final_note, 350)}`);
  if (summary.latestApproval?.decision === 'CHANGES_REQUESTED') lines.push(`*CEO response:* ${clipped(summary.latestApproval.comment || 'Rejected', 350)}`);
  if (summary.latestApproval?.decision === 'APPROVED' && summary.latestApproval.comment) lines.push(`*CEO note:* ${clipped(summary.latestApproval.comment, 350)}`);
  if (summary.pendingProposals.length) {
    lines.push('*Pending proposals:*');
    for (const p of summary.pendingProposals) {
      const d = summary.departments.find(x => x.id === p.request_department_id);
      const before = p.kind === 'EFFORT' ? `${p.current_value} min` : formatCairo(p.current_value);
      const after = p.kind === 'EFFORT' ? `${p.proposed_value} min` : formatCairo(p.proposed_value);
      lines.push(`• ${clipped(d?.department_key || '', 60)}: ${before} → ${after}. ${clipped(p.note, 200)}`);
    }
  }
  if (summary.recentComments?.length) {
    lines.push('*Recent notes:*');
    for (const c of summary.recentComments.slice(-5)) lines.push(`• ${clipped(c.department_key || 'General', 50)} · <@${c.author_slack_user_id}>: ${clipped(c.body, 180)}`);
  }
  const buttons = [];
  const marketer = actor === summary.marketer_slack_user_id;
  const effortOpen = ['COLLECTING_EFFORT', 'REVIEWING_EFFORT', 'CEO_CHANGES_REQUESTED'].includes(summary.status);
  const deliveryOpen = ['COLLECTING_DELIVERY', 'REVIEWING_DELIVERY'].includes(summary.status);
  if (marketer && effortOpen) {
    buttons.push(action('Edit request', 'extra_open_form', id, { kind: 'details' }));
  }
  for (const d of summary.departments) {
    const own = d.assignee_slack_user_id === actor;
    if (own && summary.status === 'COLLECTING_EFFORT') buttons.push(action(`${hasEffort(d) ? 'Update' : 'Submit'} effort: ${d.department_key}`,
      'extra_open_form', id, { kind: 'effort', department: d.department_key }));
    if (own && deliveryOpen && (d.department_key.toLowerCase() === 'content' || !summary.departments.some(x => x.department_key.toLowerCase() === 'content' && !x.estimated_delivery_at))) {
      buttons.push(action(`Delivery: ${d.department_key}`, 'extra_open_form', id, { kind: 'delivery', department: d.department_key }));
    }
  }
  for (const p of summary.pendingProposals) {
    const d = summary.departments.find(x => x.id === p.request_department_id);
    if (d?.assignee_slack_user_id === actor) {
      buttons.push(action(`Accept ${d.department_key} proposal`, 'extra_accept', id, { proposalId: p.id, kind: p.kind }));
      buttons.push(action(`Counter ${d.department_key} proposal`, 'extra_open_form', id,
        { kind: p.kind === 'EFFORT' ? 'counter_effort' : 'counter_delivery', proposalId: p.id, department: d.department_key }));
    }
  }
  if (marketer && effortOpen && summary.departments.every(hasEffort) && !summary.pendingProposals.some(p => p.kind === 'EFFORT')) {
    buttons.push(action('Send to CEO', 'extra_lock', id, {}, 'primary'));
    buttons.push(action('Re-request estimates', 'extra_open_form', id, { kind: 'rerequest_effort' }));
  }
  if (marketer && summary.status === 'CEO_REJECTED') {
    buttons.push(action('Re-request estimates', 'extra_open_form', id, { kind: 'rerequest_effort' }));
    buttons.push(action('Dismiss permanently', 'extra_dismiss', id, {}, 'danger'));
  }
  if (marketer && summary.status === 'APPROVED_AWAITING_DELIVERY_REQUEST') {
    buttons.push(action('Request delivery time', 'extra_request_delivery', id, {}, 'primary'));
    buttons.push(action('Request with note', 'extra_open_form', id, { kind: 'delivery_request' }));
  }
  if (marketer && deliveryOpen && summary.departments.every(d => d.estimated_delivery_at) && !summary.pendingProposals.some(p => p.kind === 'DELIVERY')) {
    buttons.push(action('Approve and start', 'extra_finalize', id, {}, 'primary'));
    buttons.push(action('Re-request delivery', 'extra_open_form', id, { kind: 'rerequest_delivery' }));
  }
  if (actor === ceoId && summary.status === 'AWAITING_CEO') {
    buttons.push(action('Approve', 'extra_open_form', id, { kind: 'ceo_decision', decision: 'APPROVE', approvalId: summary.latestApproval.id }, 'primary'));
    buttons.push(action('Reject', 'extra_open_form', id, { kind: 'ceo_decision', decision: 'REJECT', approvalId: summary.latestApproval.id }, 'danger'));
  }
  const uniqueButtons = buttons.map((element, index) => ({ ...element, action_id: `${element.action_id}:${index}` }));
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } }, ...actionBlocks(uniqueButtons)];
  return { text: `${summary.title} — ${statusLabel(summary.status)}`, blocks };
}

export function requestView(summary, actor, ceoId, configuredDepartments) {
  const blocks = summaryMessage(summary, actor, ceoId, configuredDepartments).blocks;
  return { type: 'modal', callback_id: 'extra_request', title: plain(summary.title.slice(0, 24)),
    close: plain('Close'), blocks };
}

export function createdView(summary) {
  return { type: 'modal', callback_id: 'extra_created', title: plain('Request sent'), close: plain('Done'),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text:
      `*${clipped(summary.title, 180)}* was sent. Assigned teams have been asked for their effort estimates.` } }] };
}

export function cardMessage(summary, card, ceoId, configuredDepartments) {
  const actor = card.recipient_slack_user_id;
  if (card.kind === 'MARKETER' || card.kind === 'MARKETER_PROGRESS') {
    return summaryMessage(summary, actor, ceoId, configuredDepartments);
  }
  if (card.kind.startsWith('CEO:')) {
    const message = summaryMessage(summary, actor, ceoId, configuredDepartments);
    if (Number(card.kind.slice(4)) !== summary.latestApproval?.id) {
      return { ...message, blocks: message.blocks.filter(block => block.type !== 'actions') };
    }
    return message;
  }
  const [phase, rawRound] = card.kind.split(':');
  if (phase !== 'EFFORT' && phase !== 'DELIVERY') return summaryMessage(summary, actor, ceoId, configuredDepartments);
  const round = Number(rawRound);
  const assigned = JSON.parse(card.departments_json || '[]');
  const rows = summary.departments.filter(d => assigned.includes(d.department_key));
  const isEffort = phase === 'EFFORT';
  const currentRound = isEffort ? summary.effort_round : summary.delivery_round;
  const active = round === currentRound && (isEffort ? summary.status === 'COLLECTING_EFFORT' : summary.status === 'COLLECTING_DELIVERY');
  const lines = [`*${clipped(summary.title, 180)}*`, `*Client:* ${clipped(summary.client || '—', 120)}`,
    `*Description:* ${clipped(summary.description, 900)}`, `*Requested by:* <@${summary.marketer_slack_user_id}>`,
    `*${isEffort ? 'Effort estimate' : 'Delivery date'} · round ${round}*`];
  if (card.note) lines.push(`*Marketer note:* ${clipped(card.note, 500)}`);
  if (round !== currentRound) lines.push('This round is complete. See the latest request for current actions.');
  else lines.push(`*Status:* ${statusLabel(summary.status)}`);
  const content = summary.departments.find(d => d.department_key.toLowerCase() === 'content');
  const buttons = [];
  for (const d of rows) {
    if (d.assignee_slack_user_id !== actor) continue;
    lines.push(`• *${clipped(d.department_key)}:* ${isEffort
      ? hasEffort(d) ? clipped(effortText(d), 300) : 'pending'
      : d.estimated_delivery_at ? formatCairo(d.estimated_delivery_at) : 'pending'}`);
    if (isEffort && d.effort_note) lines.push(`  Note: ${clipped(d.effort_note, 250)}`);
    if (!isEffort && d.delivery_note) lines.push(`  Note: ${clipped(d.delivery_note, 250)}`);
    if (active && (isEffort || d.department_key.toLowerCase() === 'content' || !content || content.estimated_delivery_at)) {
      buttons.push(action(isEffort ? `${hasEffort(d) ? 'Edit' : 'Submit'} ${d.department_key} effort`
        : `${d.estimated_delivery_at ? 'Edit' : 'Submit'} ${d.department_key} date`,
      `extra_open_form:${buttons.length}`, summary.id, { kind: isEffort ? 'effort' : 'delivery',
        department: d.department_key, round, roundType: isEffort ? 'effort' : 'delivery' }, 'primary'));
    }
  }
  if (!isEffort && content?.estimated_delivery_at && !assigned.some(name => name.toLowerCase() === 'content')) {
    lines.push(`*Content delivery:* ${formatCairo(content.estimated_delivery_at)}. Choose a date on or after this.`);
  }
  buttons.push(button('View current request', 'extra_view', { requestId: summary.id }));
  return { text: `${summary.title} · ${isEffort ? 'effort' : 'delivery'} round ${round}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } }, ...actionBlocks(buttons)] };
}

export function shortAlert(event, summary, payload = {}) {
  const title = clipped(summary.title, 180);
  const department = clipped(payload.department || 'Team', 80);
  const messages = {
    EFFORT_SUBMITTED: `🔴 ${department} ${payload.revised ? 'updated its estimate' : 'replied'} · ${title}`,
    DELIVERY_SUBMITTED: `🔴 ${department} ${payload.revised ? 'updated its date' : 'replied'} · ${title}`,
    ALL_EFFORTS_COLLECTED: `✅ Estimates ready · ${title}`,
    ALL_DELIVERY_ESTIMATES_COLLECTED: `✅ Delivery dates ready · ${title}`,
    CEO_APPROVED: `✅ CEO approved · ${title}`,
    CEO_REJECTED: `❌ CEO rejected · ${title}`,
    FINAL_DELIVERY_APPROVED: `🚀 Approved to start · ${title}`,
    EFFORT_REMINDER: `⏰ Effort estimate still needed · ${title}`,
    QUESTION_ADDED: `💬 New note · ${title}`
  };
  return { text: messages[event] || `🔔 ${clipped(event, 80)} · ${title}` };
}

const eventTitles = {
  EFFORT_REQUESTED: 'Please submit your effort estimate', EFFORT_REMINDER: 'Effort estimate reminder',
  EFFORT_REREQUESTED: 'Updated effort estimate requested',
  EFFORT_SUBMITTED: 'Effort estimate submitted', QUESTION_ADDED: 'New question or note',
  EFFORT_CHANGE_PROPOSED: 'Effort change proposed', PROPOSAL_RESPONDED: 'Proposal answered',
  ALL_EFFORTS_COLLECTED: 'All effort estimates are ready', CEO_APPROVAL_REQUESTED: 'CEO approval requested',
  CEO_CHANGES_REQUESTED: 'CEO requested changes', CEO_REJECTED: 'CEO rejected the estimates', CEO_APPROVED: 'CEO approved the estimates',
  CONTENT_DELIVERY_REQUESTED: 'Content delivery estimate requested', OTHER_DELIVERY_REQUESTED: 'Delivery estimate requested',
  DELIVERY_REREQUESTED: 'Updated delivery date requested',
  DELIVERY_SUBMITTED: 'Delivery estimate submitted', DELIVERY_CHANGE_PROPOSED: 'Earlier delivery proposed',
  ALL_DELIVERY_ESTIMATES_COLLECTED: 'All delivery estimates are ready', FINAL_DELIVERY_APPROVED: 'Approved — start executing'
};

export function notificationMessage(notification, summary) {
  const p = notification.payload;
  const event = notification.event_type;
  const round = p.round ?? (event.includes('DELIVERY') ? summary.delivery_round : summary.effort_round);
  const lines = [`*${clipped(summary.title, 150)} · ${event.includes('DELIVERY') ? 'delivery' : 'effort'} round ${round}*`,
    `*${eventTitles[event] || event}*`,
    `*Client:* ${clipped(summary.client || '—', 120)}`, `*Description:* ${clipped(summary.description, 500)}`,
    `*Requested by:* <@${summary.marketer_slack_user_id}>`, `*Status:* ${statusLabel(summary.status)}`];
  if (p.department) lines.push(`Department: ${clipped(p.department, 80)}`);
  if (p.assigneeId) lines.push(`Submitted by: <@${p.assigneeId}>`);
  if (p.effortText != null) lines.push(`*Effort:* ${clipped(p.effortText, 300)}`);
  if (p.deliveryAt) lines.push(`*Delivery date:* ${formatCairo(p.deliveryAt)}`);
  if (p.note) lines.push(`Note: ${clipped(p.note, 700)}`);
  if (p.finalDeliveryAt) lines.push(`Final delivery: ${formatCairo(p.finalDeliveryAt)}`);
  if (p.contentDeliveryAt) lines.push(`Content delivery: ${formatCairo(p.contentDeliveryAt)}. Choose a date on or after this.`);
  if (event === 'EFFORT_SUBMITTED') {
    const pending = p.pendingDepartments ?? summary.departments.filter(d => !hasEffort(d)).map(d => ({ department: d.department_key, assigneeId: d.assignee_slack_user_id }));
    lines.push(`*Still pending:* ${pending.length ? pending.map(d => `${clipped(d.department)} <@${d.assigneeId}>`).join(', ') : 'None'}`);
  }
  if (event === 'DELIVERY_SUBMITTED') {
    const pending = p.pendingDepartments ?? summary.departments.filter(d => d.estimated_delivery_at == null).map(d => ({ department: d.department_key, assigneeId: d.assignee_slack_user_id }));
    lines.push(`*Still pending:* ${pending.length ? pending.map(d => `${clipped(d.department)} <@${d.assigneeId}>`).join(', ') : 'None'}`);
  }
  if (event === 'ALL_EFFORTS_COLLECTED' || event === 'CEO_APPROVAL_REQUESTED') {
    const estimates = p.estimates ?? p.snapshot?.departments.map(d => ({ department: d.department,
      text: d.effortText ?? (d.effortInputValue == null ? null : `${d.effortInputValue} ${d.effortInputUnit}`), note: d.effortNote })) ?? summary.departments.map(d => ({ department: d.department_key,
      text: effortText(d), note: d.effort_note }));
    for (const d of estimates) lines.push(`• ${clipped(d.department)}: ${clipped(d.text ?? (d.value == null ? 'pending' : `${d.value} ${d.unit ?? ''}`), 300)}${d.note ? ` · ${clipped(d.note, 140)}` : ''}`);
  }
  if (event === 'ALL_DELIVERY_ESTIMATES_COLLECTED') {
    const dates = p.dates ?? summary.departments.map(d => ({ department: d.department_key, deliveryAt: d.estimated_delivery_at }));
    for (const d of dates) lines.push(`• ${clipped(d.department)}: ${d.deliveryAt ? formatCairo(d.deliveryAt) : 'pending'}`);
  }
  if (event === 'FINAL_DELIVERY_APPROVED') lines.push('*Approval:* Start executing your assigned work.');
  const actions = [];
  const id = summary.id;
  if (['EFFORT_REQUESTED', 'EFFORT_REREQUESTED', 'EFFORT_REMINDER'].includes(event)) {
    actions.push(action('Submit effort', 'extra_open_form:0', id, { kind: 'effort', department: p.department,
      round, roundType: 'effort' }, 'primary'));
  } else if (['CONTENT_DELIVERY_REQUESTED', 'OTHER_DELIVERY_REQUESTED', 'DELIVERY_REREQUESTED'].includes(event)) {
    actions.push(action('Submit delivery date', 'extra_open_form:0', id, { kind: 'delivery', department: p.department,
      round, roundType: 'delivery' }, 'primary'));
  } else if (event === 'ALL_EFFORTS_COLLECTED') {
    actions.push(action('Send to CEO', 'extra_lock', id, { round, roundType: 'effort' }, 'primary'));
    actions.push(action('Re-request estimates', 'extra_open_form:0', id, { kind: 'rerequest_effort', round, roundType: 'effort' }));
  } else if (event === 'CEO_APPROVAL_REQUESTED') {
    actions.push(action('Approve', 'extra_open_form:0', id, { kind: 'ceo_decision', decision: 'APPROVE', approvalId: p.approvalId }, 'primary'));
    actions.push(action('Reject', 'extra_open_form:1', id, { kind: 'ceo_decision', decision: 'REJECT', approvalId: p.approvalId }, 'danger'));
  } else if (event === 'CEO_REJECTED') {
    actions.push(action('Re-request estimates', 'extra_open_form:0', id, { kind: 'rerequest_effort' }));
    actions.push(action('Dismiss permanently', 'extra_dismiss', id, {}, 'danger'));
  } else if (event === 'CEO_APPROVED') {
    actions.push(action('Request delivery time', 'extra_request_delivery', id, {}, 'primary'));
    actions.push(action('Request with note', 'extra_open_form:0', id, { kind: 'delivery_request' }));
  } else if (event === 'ALL_DELIVERY_ESTIMATES_COLLECTED') {
    actions.push(action('Approve and start', 'extra_finalize', id, { round, roundType: 'delivery' }, 'primary'));
    actions.push(action('Re-request delivery', 'extra_open_form:0', id, { kind: 'rerequest_delivery', round, roundType: 'delivery' }));
  }
  if (!['ALL_EFFORTS_COLLECTED', 'CEO_APPROVAL_REQUESTED', 'CEO_REJECTED', 'CEO_APPROVED',
    'ALL_DELIVERY_ESTIMATES_COLLECTED'].includes(event)) {
    actions.push(button('View current request', 'extra_view', { requestId: id }));
  }
  return { text: `${eventTitles[event] || event} — ${summary.title} · round ${round}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } }, ...actionBlocks(actions)] };
}

export function readValue(view, blockId) { return view.state.values[blockId]?.value; }
