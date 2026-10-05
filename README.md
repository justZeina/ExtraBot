# ExtraBot core

ExtraBot implements an internal extras-request workflow in JavaScript with SQLite persistence. The core service has no Slack dependency; an optional Bolt adapter connects it to Slack through Socket Mode.

## Requirements and setup

- Node.js 24 or newer. The core uses bundled `node:sqlite` (experimental in Node 24); run `npm install` for the Slack adapter's Bolt dependency.
- A writable path for the SQLite database.
- The configured CEO Slack user ID is `U0C542YNA7M`.
- The configured working week is Sunday–Thursday (`0,1,2,3,4`, where Sunday is `0`).
- Optional Cairo calendar holidays as `YYYY-MM-DD` strings.

Run migrations with `node scripts/migrate.js`. Set `EXTRABOT_DB_PATH` first to choose a database file; otherwise this script creates `./extrabot.sqlite`. Migrations also run automatically when the service opens a database. Run the full local example with `node scripts/demo.js` and tests with `node --test`. The demo uses an in-memory database unless `EXTRABOT_DB_PATH` is set. It loads the configured CEO ID and Sunday–Thursday calendar from `src/config.js`. Override these with `EXTRABOT_CEO_SLACK_USER_ID`, `EXTRABOT_WORKING_WEEKDAYS` (comma-separated weekday numbers), or `EXTRABOT_HOLIDAYS` (comma-separated Cairo dates) if they change.

For Slack, put `SLACK_BOT_TOKEN=xoxb-...` and `SLACK_APP_TOKEN=xapp-...` in the repository's `.env` file. It is ignored by Git. `npm run check:slack-config` loads `.env` and checks that both values are present with the expected prefixes, without printing them. `npm run check:slack-auth` verifies the bot token and required scopes with Slack without printing the token. The request form offers Content, Art, and Storytelling. Set `EXTRABOT_DEPARTMENTS` in `.env` to replace that list. The core and demo still run without Slack.

## Run in Slack

1. In your Slack app settings, enable **Socket Mode** and **Interactivity & Shortcuts**. Add the bot scopes `commands`, `chat:write`, and `im:write` under **OAuth & Permissions**. Install or reinstall the app to the workspace after changing scopes. The app-level token needs `connections:write`.
2. Create the `/extra` slash command and a global shortcut named **New Extra Request** with callback ID `extra_new`. [slack-app-manifest.json](slack-app-manifest.json) lists the exact app settings. With Socket Mode, neither feature needs a public request URL.
3. Keep the `xoxb-` and `xapp-` tokens in `.env`, then run `npm install` followed by `npm start`. Keep this process running while people use the bot. The default database is `./extrabot.sqlite`; set `EXTRABOT_DB_PATH` to choose another path.
4. In Slack, type `/extra` to create a request with Title, Client, Description, and optional Content, Art, and Storytelling assignees. At least one assignee is required. Use `/extra list` to find requests you participate in. The creation modal confirms the request; the marketer and each assigned person receive one request card in DM.

The Slack flow follows marketer assignment → simultaneous team effort requests → marketer sends the collected estimates to the CEO or re-requests selected teams → CEO approves or rejects with an optional note. On rejection, the marketer can re-request effort or dismiss the request permanently. On approval, the marketer requests delivery dates, with or without a note. Content responds first when selected; the other teams receive Content's date and must submit dates on or after it. The marketer then approves the schedule and teams receive a start-work message, or re-requests selected delivery dates. Selecting Content for a delivery re-request also re-requests every other team, preserving the Content-first sequence. Slack messages show the request title and client, while internal IDs remain in the database and action payloads.

The app opens DMs using `conversations.open`, so `im:write` is required. Actions and form submissions are acknowledged promptly. Every form saves against the request version shown when it opened; if it became stale, use **View current request** on the latest request message. Background timers check reminders every minute and send pending outbox messages every five seconds. The bot must keep running to process both. Failed sends are retried with backoff.

```js
import { createExtraService } from './src/service.js';
import { loadConfig } from './src/config.js';

const service = createExtraService({
  dbPath: './extrabot.sqlite',
  ...loadConfig()
});

const request = service.createRequest({
  title: 'Campaign extras',
  description: 'Prepare launch assets',
  departments: [
    { department: 'Content', assigneeId: 'U_CONTENT' },
    { department: 'Art', assigneeId: 'U_ART' }
  ]
}, 'U_MARKETER');

const version = service.getRequestSummary(request.id).version;
service.submitEffort({
  requestId: request.id,
  department: 'Content',
  effort: { value: 1.5, unit: 'working_days' },
  note: 'Includes review',
  expectedVersion: version
}, 'U_CONTENT');

console.log(service.getRequestSummary(request.id));
service.close();
```

`expectedVersion` is required on every user-initiated mutation after creation. Read the current version from `getRequestSummary`; if another action changed the request, the service throws `STALE_VERSION` and the handler should refresh the view. Other error codes are `FORBIDDEN`, `INVALID_STATE`, `VALIDATION_ERROR`, and `NOT_FOUND`.

## Workflow and data

The service moves through `COLLECTING_EFFORT`, `REVIEWING_EFFORT`, `AWAITING_CEO`, `CEO_REJECTED` or `APPROVED_AWAITING_DELIVERY_REQUEST`, `COLLECTING_DELIVERY`, `REVIEWING_DELIVERY`, and `FINALIZED` or `DISMISSED`. It validates the actor and state inside each mutation. Each mutation and its notification intents run in one SQLite transaction. Older requests using `CEO_CHANGES_REQUESTED` and proposal records remain readable.

The Slack effort field accepts any nonempty text, including rough estimates and explanations. The text is shown in marketer and CEO summaries. The service still accepts the older `{ value, unit }` input with `hours`, `working_days`, or `working_weeks` for existing integrations; those entries retain their calculated minutes. Reminder due times add seven *working* hours between 10:00 and 17:00 in `Africa/Cairo`, skipping configured nonworking days and holidays. Run `processDueReminders()` periodically; each job and outbox message has a stable ID, so restarts do not duplicate reminders.

Delivery input must be an ISO 8601 timestamp containing `Z` or an explicit UTC offset, such as `2026-10-05T13:00:00+03:00`. Timestamps are stored in UTC. Summary output includes `estimatedDeliveryCairo` per department and `finalDeliveryCairo` for display. Content must submit first when selected; all other department dates must be at or after Content's date. The latest approved department date becomes the overall final date.

The CEO approval snapshot includes title, description, current effort values, notes, comments, and effort proposals. A later CEO request shows a structured `changes` array compared with that snapshot. `getRequestHistory` returns immutable approval snapshots, proposals, comments, and audit events.

## Service and Slack handler mapping

Pass the Slack actor ID as the second argument. The core stores assignee IDs supplied by the eventual `users_select` dropdown; it does not fetch workspace members.

| Slack action | Service method |
|---|---|
| Request modal submission | `createRequest(input, actorId)` |
| Change department assignee | `assignDepartment(input, actorId)` |
| Edit title or description | `updateRequestDetails(input, actorId)` |
| Effort submission or revision | `submitEffort(input, actorId)` / `reviseOwnEffort(input, actorId)` |
| Re-request selected effort estimates | `reRequestEfforts(input, actorId)` |
| Lock and request CEO approval | `lockAndRequestCeoApproval(input, actorId)` |
| CEO approval or rejection, with optional note | `recordCeoDecision(input, actorId)` |
| Dismiss after rejection | `dismissRequest(input, actorId)` |
| Request delivery dates, with optional note | `requestDeliveryTimes(input, actorId)` |
| Department estimated delivery | `submitDeliveryEstimate(input, actorId)` |
| Re-request selected delivery dates | `reRequestDeliveries(input, actorId)` |
| Marketer final schedule approval | `approveFinalDelivery(input, actorId)` |
| Render current view and history | `getRequestSummary(id)` / `getRequestHistory(id)` |

Effort re-requests take selected department names and an optional note. CEO decisions take `approvalId`, `decision: 'APPROVE' | 'REJECT'`, optional `note`, and `expectedVersion`. The approval ID and version together reject old button clicks. Older proposal methods remain in the service for existing records, but the Slack flow uses re-requests instead.

## Notifications

`getPendingNotifications()` returns outbox rows with parsed `payload` objects containing `requestId`, `recipientId`, and event details. The Bolt sender claims each row before delivery, marks successful rows `SENT`, and retries failures after a delay. `processDueReminders()` creates due reminder events. Database request IDs are internal; Slack message timestamps identify cards to edit in place.

## Slack message policy

- Creation sends one marketer card and one effort card per assigned person. Multiple departments assigned to the same person share that effort card.
- Submitting effort or a delivery date updates the person's card and the marketer card. The submitter sees the completed request in the modal. The marketer receives only a short emoji alert, such as `🔴 Content replied · Campaign assets`.
- The last team reply sends a single `✅ Estimates ready` or `✅ Delivery dates ready` alert instead of a separate reply alert. Decision buttons live on the updated marketer card.
- Re-requests create one clearly marked new-round card for each selected person; earlier round cards become read-only. The CEO receives one actionable card per approval request. The CEO's decision updates that card and produces one short marketer alert.
- Content receives the first delivery card when assigned. Other departments receive their delivery card after Content submits. Final approval sends one short `🚀 Approved to start` alert to each assigned person.
- `npm start` creates a lock beside the database so a second bot process cannot connect with the same database. The lock is removed on normal exit, and stale locks are cleared at startup.
