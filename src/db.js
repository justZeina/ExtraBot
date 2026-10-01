import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=1').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
    CREATE TABLE IF NOT EXISTS extra_requests (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      marketer_slack_user_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      ceo_approved_version INTEGER, final_delivery_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT
    );
    CREATE TABLE IF NOT EXISTS request_departments (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      department_key TEXT NOT NULL COLLATE NOCASE, assignee_slack_user_id TEXT NOT NULL,
      effort_minutes INTEGER, effort_input_value REAL, effort_input_unit TEXT, effort_note TEXT, effort_submitted_at TEXT,
      estimated_delivery_at TEXT, delivery_note TEXT, delivery_submitted_at TEXT,
      UNIQUE(request_id, department_key)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      request_department_id INTEGER NOT NULL REFERENCES request_departments(id),
      kind TEXT NOT NULL CHECK(kind IN ('EFFORT','DELIVERY')),
      proposed_by_slack_user_id TEXT NOT NULL, current_value TEXT NOT NULL, proposed_value TEXT NOT NULL,
      proposed_input_value REAL, proposed_input_unit TEXT, note TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','COUNTERED','WITHDRAWN')),
      response_note TEXT, responded_by_slack_user_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS request_comments (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      request_department_id INTEGER REFERENCES request_departments(id),
      author_slack_user_id TEXT NOT NULL, body TEXT NOT NULL,
      parent_comment_id INTEGER REFERENCES request_comments(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approval_decisions (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      request_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      change_summary_json TEXT, decision TEXT CHECK(decision IN ('APPROVED','CHANGES_REQUESTED')),
      comment TEXT, ceo_slack_user_id TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      actor_slack_user_id TEXT NOT NULL, event_type TEXT NOT NULL,
      before_json TEXT, after_json TEXT, note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      event_type TEXT NOT NULL, recipient_slack_user_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED')),
      attempt_count INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, sent_at TEXT,
      created_at TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS reminder_jobs (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES extra_requests(id),
      request_department_id INTEGER NOT NULL REFERENCES request_departments(id),
      kind TEXT NOT NULL, due_at TEXT NOT NULL, sent_at TEXT, cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_status ON extra_requests(status);
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(status, available_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminder_jobs(due_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_proposals_pending ON proposals(request_id, status);
  `);
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec("ALTER TABLE extra_requests ADD COLUMN client TEXT NOT NULL DEFAULT ''");
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE extra_requests ADD COLUMN final_note TEXT');
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(3,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=4').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE extra_requests ADD COLUMN effort_round INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE extra_requests ADD COLUMN delivery_round INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE extra_requests ADD COLUMN delivery_request_note TEXT;`);
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(4,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=5').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE notification_outbox ADD COLUMN claim_token TEXT;
        ALTER TABLE notification_outbox ADD COLUMN claimed_at TEXT;
        CREATE TABLE request_message_cards (
          request_id INTEGER NOT NULL REFERENCES extra_requests(id),
          recipient_slack_user_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_ts TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(request_id, recipient_slack_user_id, kind)
        );`);
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(5,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version=6').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE request_departments ADD COLUMN effort_text TEXT');
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(6,?)').run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
