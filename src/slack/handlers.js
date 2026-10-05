import { WorkflowError } from '../errors.js';
import { canView, createdView, createDetailsView, formView, parseDepartments, requestView, summaryMessage } from './views.js';

function decode(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
function field(view, block) { return view.state.values[block]?.value; }
function text(view, block) { return field(view, block)?.value?.trim() ?? ''; }
function selected(view, block) { return field(view, block)?.selected_option?.value; }
function user(view, block) { return field(view, block)?.selected_user; }
function date(view, block) {
  const seconds = field(view, block)?.selected_date_time;
  return Number.isInteger(seconds) ? new Date(seconds * 1000).toISOString() : null;
}
function legacyEffort(view) { return { value: Number(text(view, 'amount')), unit: selected(view, 'unit') }; }
function messageFor(error) {
  if (error instanceof WorkflowError) return `${error.message} (${error.code}). Open the latest request message to refresh.`;
  return 'Something went wrong. Please try again or check the app logs.';
}

export async function sendDirect(client, recipient, message) {
  const result = await client.conversations.open({ users: recipient });
  if (!result.channel?.id) throw new Error('Slack did not return a DM channel');
  const posted = await client.chat.postMessage({ channel: result.channel.id, ...message });
  return { ...posted, channel: posted.channel ?? result.channel.id };
}

export function registerSlackHandlers(app, { service, ceoSlackUserId, departments, flushOutbox,
  syncCards = async () => {}, logger = console }) {
  const configured = parseDepartments(departments.join(','));
  const registerAction = (actionId, handler) => {
    app.action(actionId, handler);
    app.action(new RegExp(`^${actionId}:\\d+$`), handler);
  };
  const safeDirect = async (client, actor, message) => {
    try { await sendDirect(client, actor, message); } catch (error) { logger.error(`Could not DM actor: ${error.message}`); }
  };
  const afterMutation = async requestId => {
    try { await flushOutbox(); } catch (error) { logger.error(`Outbox delivery failed: ${error.message}`); }
    try { await syncCards(requestId); } catch (error) { logger.error(`Card update failed: ${error.message}`); }
  };
  const show = (requestId, actor) => {
    const summary = service.getRequestSummary(requestId);
    if (!canView(summary, actor, ceoSlackUserId)) throw new WorkflowError('FORBIDDEN', 'You do not have access to this request');
    return summaryMessage(summary, actor, ceoSlackUserId, configured);
  };
  const checkRound = (summary, data) => {
    const current = data.roundType === 'effort' ? summary.effort_round : data.roundType === 'delivery' ? summary.delivery_round : null;
    if (data.round != null && current !== data.round) {
      throw new WorkflowError('STALE_VERSION', 'This message belongs to an earlier request round');
    }
  };

  app.command('/extra', async ({ command, ack, respond, client }) => {
    await ack();
    const instruction = command.text.trim();
    try {
      if (!instruction || instruction === 'new') {
        await client.views.open({ trigger_id: command.trigger_id, view: createDetailsView(configured) });
      } else if (instruction === 'list') {
        const rows = service.listRequestsForActor(command.user_id);
        const blocks = rows.map((row, index) => ({ type: 'section',
          text: { type: 'plain_text', text: `${row.title} · ${row.client || 'No client'} · ${row.status}`.slice(0, 3000) },
          accessory: { type: 'button', text: { type: 'plain_text', text: 'View' },
            action_id: `extra_view:${index}`, value: JSON.stringify({ requestId: row.id }) } }));
        await respond({ response_type: 'ephemeral', text: rows.length ? 'Your requests' : 'No requests found.',
          ...(blocks.length ? { blocks } : {}) });
      } else if (/^\d+$/.test(instruction)) {
        await respond({ response_type: 'ephemeral', ...show(Number(instruction), command.user_id) });
      } else await respond({ response_type: 'ephemeral', text: 'Use `/extra` to create or `/extra list` to find requests.' });
    } catch (error) { await respond({ response_type: 'ephemeral', text: messageFor(error) }); }
  });
  app.shortcut('extra_new', async ({ shortcut, ack, client }) => {
    await ack();
    try { await client.views.open({ trigger_id: shortcut.trigger_id, view: createDetailsView(configured) }); }
    catch (error) { await safeDirect(client, shortcut.user.id, { text: messageFor(error) }); }
  });

  app.view('extra_create', async ({ body, view, ack, client }) => {
    const clientName = text(view, 'client');
    const title = text(view, 'title');
    const description = text(view, 'description');
    const selected = configured.map((name, index) => ({ department: name, assigneeId: user(view, `assignee_${index}`) }))
      .filter(item => item.assigneeId);
    const errors = {};
    if (!clientName) errors.client = 'Client is required.';
    if (!title) errors.title = 'Title is required.';
    if (!description) errors.description = 'Description is required.';
    if (!selected.length) errors.assignee_0 = 'Choose at least one department assignee.';
    if (clientName.length + title.length + description.length > 2400) errors.description = 'Please shorten the request details.';
    if (Object.keys(errors).length) return ack({ response_action: 'errors', errors });
    let created;
    try { created = service.createRequest({ client: clientName, title, description,
      departments: selected, submissionKey: view.id ? `${body.team?.id || 'workspace'}:${body.user.id}:${view.id}` : null }, body.user.id); }
    catch (error) { return ack({ response_action: 'errors', errors: { client: messageFor(error) } }); }
    await ack({ response_action: 'update', view: createdView(created) });
    await afterMutation(created.id);
  });

  registerAction('extra_view', async ({ body, action, ack, client }) => {
    await ack();
    try {
      const requestId = decode(action.value).requestId;
      const summary = service.getRequestSummary(requestId);
      if (!canView(summary, body.user.id, ceoSlackUserId)) throw new WorkflowError('FORBIDDEN', 'You do not have access to this request');
      await client.views.open({ trigger_id: body.trigger_id, view: requestView(summary, body.user.id, ceoSlackUserId, configured) });
    }
    catch (error) { await safeDirect(client, body.user.id, { text: messageFor(error) }); }
  });
  registerAction('extra_open_form', async ({ body, action, ack, client }) => {
    await ack();
    try {
      const context = decode(action.value);
      const summary = service.getRequestSummary(context.requestId);
      if (!canView(summary, body.user.id, ceoSlackUserId)) throw new WorkflowError('FORBIDDEN', 'You do not have access to this request');
      checkRound(summary, context);
      const payload = { trigger_id: body.trigger_id, view: formView(context.kind,
        { ...context, fromRequestView: Boolean(body.view) }, summary, configured) };
      if (body.view?.id) await client.views.update({ view_id: body.view.id, view: payload.view });
      else if (body.view) await client.views.push(payload);
      else await client.views.open(payload);
    } catch (error) { await safeDirect(client, body.user.id, { text: messageFor(error) }); }
  });

  app.view('extra_form', async ({ body, view, ack, client }) => {
    const context = decode(view.private_metadata);
    const actor = body.user.id;
    const base = { requestId: context.requestId, expectedVersion: context.expectedVersion };
    const note = text(view, 'note') || null;
    try {
      switch (context.kind) {
        case 'effort': {
          const d = service.getRequestSummary(base.requestId).departments.find(x => x.department_key === context.department);
          const method = d?.effort_submitted_at == null ? service.submitEffort : service.reviseOwnEffort;
          method({ ...base, department: context.department, effort: text(view, 'amount'), note }, actor);
          break;
        }
        case 'rerequest_effort': service.reRequestEfforts({ ...base,
          departments: field(view, 'departments')?.selected_options?.map(x => x.value) ?? [], note }, actor); break;
        case 'propose_effort': service.proposeEffortChange({ ...base, department: context.department, value: legacyEffort(view), note }, actor); break;
        case 'counter_effort': service.respondToEffortProposal({ proposalId: context.proposalId, expectedVersion: base.expectedVersion, decision: 'COUNTER', counterValue: legacyEffort(view), note }, actor); break;
        case 'delivery': service.submitDeliveryEstimate({ ...base, department: context.department, deliveryAt: date(view, 'delivery_at'), note }, actor); break;
        case 'rerequest_delivery': service.reRequestDeliveries({ ...base,
          departments: field(view, 'departments')?.selected_options?.map(x => x.value) ?? [], note }, actor); break;
        case 'delivery_request': service.requestDeliveryTimes({ ...base, note }, actor); break;
        case 'ceo_decision': service.recordCeoDecision({ ...base, approvalId: context.approvalId, decision: context.decision, note }, actor); break;
        case 'propose_delivery': service.proposeDeliveryChange({ ...base, department: context.department, value: date(view, 'delivery_at'), note }, actor); break;
        case 'counter_delivery': service.respondToDeliveryProposal({ proposalId: context.proposalId, expectedVersion: base.expectedVersion, decision: 'COUNTER', counterValue: date(view, 'delivery_at'), note }, actor); break;
        case 'comment': service.addComment({ ...base, department: context.department ?? null, parentCommentId: context.parentCommentId ?? null, body: note }, actor); break;
        case 'ceo_changes': service.recordCeoDecision({ ...base, approvalId: context.approvalId, decision: 'REQUEST_CHANGES', note }, actor); break;
        case 'assign': service.assignDepartment({ ...base, department: selected(view, 'department'), assigneeId: user(view, 'assignee') }, actor); break;
        case 'details': service.updateRequestDetails({ ...base, client: text(view, 'client'), title: text(view, 'title'), description: text(view, 'description') }, actor); break;
        case 'finalize': service.approveFinalDelivery({ ...base, note }, actor); break;
        default: throw new WorkflowError('VALIDATION_ERROR', 'Unknown form action');
      }
    } catch (error) {
      const firstBlock = view.blocks.find(x => x.type === 'input')?.block_id;
      return ack({ response_action: 'errors', errors: { [firstBlock || 'note']: messageFor(error).slice(0, 2000) } });
    }
    const summary = service.getRequestSummary(base.requestId);
    await ack({ response_action: 'update', view: requestView(summary, actor, ceoSlackUserId, configured) });
    await afterMutation(base.requestId);
  });

  const quick = (actionId, fn) => registerAction(actionId, async ({ body, action, ack, client }) => {
    await ack();
    const data = decode(action.value);
    try {
      const summary = service.getRequestSummary(data.requestId);
      checkRound(summary, data);
      fn(data, summary, body.user.id);
      const refreshed = service.getRequestSummary(data.requestId);
      if (body.view?.id) {
        try {
          await client.views.update({ view_id: body.view.id,
            view: requestView(refreshed, body.user.id, ceoSlackUserId, configured) });
        } catch (error) { logger.error(`Could not refresh request view: ${error.message}`); }
      }
      await afterMutation(data.requestId);
      if (!body.view?.id && body.channel?.id && body.message?.ts &&
        !service.listMessageCards(data.requestId).some(card => card.channel_id === body.channel.id && card.message_ts === body.message.ts)) {
        try { await client.chat.update({ channel: body.channel.id, ts: body.message.ts,
          ...summaryMessage(refreshed, body.user.id, ceoSlackUserId, configured) }); }
        catch (error) { logger.error(`Could not refresh older request message: ${error.message}`); }
      }
    } catch (error) { await safeDirect(client, body.user.id, { text: messageFor(error) }); }
  });
  quick('extra_lock', (data, summary, actor) => service.lockAndRequestCeoApproval({ requestId: data.requestId, expectedVersion: summary.version }, actor));
  quick('extra_finalize', (data, summary, actor) => service.approveFinalDelivery({ requestId: data.requestId, expectedVersion: summary.version }, actor));
  quick('extra_dismiss', (data, summary, actor) => service.dismissRequest({ requestId: data.requestId, expectedVersion: summary.version }, actor));
  quick('extra_request_delivery', (data, summary, actor) => service.requestDeliveryTimes({ requestId: data.requestId, expectedVersion: summary.version }, actor));
  quick('extra_ceo_approve', (data, summary, actor) => service.recordCeoDecision({ requestId: data.requestId, approvalId: data.approvalId, decision: 'APPROVE', expectedVersion: summary.version }, actor));
  quick('extra_accept', (data, summary, actor) => {
    const input = { proposalId: data.proposalId, decision: 'ACCEPT', expectedVersion: summary.version };
    return data.kind === 'EFFORT' ? service.respondToEffortProposal(input, actor) : service.respondToDeliveryProposal(input, actor);
  });
}
