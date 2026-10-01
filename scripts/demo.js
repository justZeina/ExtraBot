import { createExtraService } from '../src/service.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const service = createExtraService({ dbPath: process.env.EXTRABOT_DB_PATH || ':memory:', ...config });

const request = service.createRequest({ client: 'Acme', title: 'Launch campaign',
  description: 'Prepare the campaign assets', departments: [
    { department: 'Content', assigneeId: 'U_CONTENT' },
    { department: 'Art', assigneeId: 'U_ART' },
    { department: 'Storytelling', assigneeId: 'U_STORYTELLING' }
  ] }, 'U_MARKETER');
const id = request.id;
const version = () => service.getRequestSummary(id).version;

service.submitEffort({ requestId: id, department: 'Content', effort: { value: 1, unit: 'working_days' },
  note: 'Draft and review', expectedVersion: version() }, 'U_CONTENT');
service.submitEffort({ requestId: id, department: 'Art', effort: { value: 3, unit: 'working_days' },
  expectedVersion: version() }, 'U_ART');
service.submitEffort({ requestId: id, department: 'Storytelling', effort: { value: 4, unit: 'hours' },
  expectedVersion: version() }, 'U_STORYTELLING');

service.reRequestEfforts({ requestId: id, departments: ['Art'], note: 'Please include revisions',
  expectedVersion: version() }, 'U_MARKETER');
service.submitEffort({ requestId: id, department: 'Art', effort: { value: 4, unit: 'working_days' },
  note: 'Includes revisions', expectedVersion: version() }, 'U_ART');

let approval = service.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'U_MARKETER');
service.recordCeoDecision({ requestId: id, approvalId: approval.approvalId, decision: 'REJECT',
  note: 'Reduce the storytelling scope', expectedVersion: version() }, config.ceoSlackUserId);
service.reRequestEfforts({ requestId: id, departments: ['Storytelling'],
  note: 'Please estimate a shorter version', expectedVersion: version() }, 'U_MARKETER');
service.submitEffort({ requestId: id, department: 'Storytelling', effort: { value: 3, unit: 'hours' },
  expectedVersion: version() }, 'U_STORYTELLING');

approval = service.lockAndRequestCeoApproval({ requestId: id, expectedVersion: version() }, 'U_MARKETER');
service.recordCeoDecision({ requestId: id, approvalId: approval.approvalId, decision: 'APPROVE',
  note: 'Proceed', expectedVersion: version() }, config.ceoSlackUserId);
service.requestDeliveryTimes({ requestId: id, note: 'Please confirm dates', expectedVersion: version() }, 'U_MARKETER');

const base = new Date(Date.now() + 14 * 86400000);
const dates = [1, 3, 5].map(offset => new Date(base.getTime() + offset * 86400000).toISOString());
service.submitDeliveryEstimate({ requestId: id, department: 'Content', deliveryAt: dates[0], expectedVersion: version() }, 'U_CONTENT');
service.submitDeliveryEstimate({ requestId: id, department: 'Art', deliveryAt: dates[1], expectedVersion: version() }, 'U_ART');
service.submitDeliveryEstimate({ requestId: id, department: 'Storytelling', deliveryAt: dates[2], expectedVersion: version() }, 'U_STORYTELLING');

service.approveFinalDelivery({ requestId: id, expectedVersion: version() }, 'U_MARKETER');
const summary = service.getRequestSummary(id);
const history = service.getRequestHistory(id);
console.log(JSON.stringify({ requestId: id, status: summary.status, version: summary.version,
  effortRound: summary.effort_round, deliveryRound: summary.delivery_round,
  finalDeliveryAt: summary.final_delivery_at, finalDeliveryCairo: summary.finalDeliveryCairo,
  approvalVersions: history.approvals.map(a => a.request_version),
  pendingNotificationCount: service.getPendingNotifications().length }, null, 2));
service.close();
