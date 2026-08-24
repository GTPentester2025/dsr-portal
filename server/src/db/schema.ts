import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Reference / configuration
// ---------------------------------------------------------------------------

export const zones = pgTable('zones', {
  id: text('id').primaryKey(), // 'EUR' | 'SAZ' | 'MAZ'
  name: text('name').notNull(),
});

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  zoneId: text('zone_id').notNull().references(() => zones.id),
  name: text('name').notNull(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    // 'admin' | 'zone_manager' | 'approver' | 'auditor'
    role: text('role').notNull(),
    zoneId: text('zone_id').references(() => zones.id), // null => cross-zone (admin)
    teamId: uuid('team_id').references(() => teams.id),
    active: boolean('active').notNull().default(true),
    capacityWeight: integer('capacity_weight').notNull().default(1),
    oooFrom: timestamp('ooo_from', { withTimezone: true }),
    oooTo: timestamp('ooo_to', { withTimezone: true }),
    /** Set by an administrative reset; cleared once the user picks their own. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordSetAt: timestamp('password_set_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_ux').on(t.email)],
);

/** Versioned snapshot of every intake form schema (spec §5: historical cases
 *  must render against the schema version they were submitted under). */
export const formVersions = pgTable(
  'form_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formKey: text('form_key').notNull(), // e.g. 'saz-brazil'
    zoneId: text('zone_id').notNull().references(() => zones.id),
    version: integer('version').notNull(), // source form version
    schema: jsonb('schema').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('form_versions_key_ver_ux').on(t.formKey, t.version)],
);

export const statuses = pgTable('statuses', {
  key: text('key').primaryKey(), // 'new' | 'open' | ...
  label: text('label').notNull(),
  color: text('color').notNull().default('#6b7280'),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  /** System statuses ('overdue', 'closed') cannot be retired. */
  system: boolean('system').notNull().default(false),
});

export const statusTransitions = pgTable(
  'status_transitions',
  {
    fromStatus: text('from_status').notNull().references(() => statuses.key),
    toStatus: text('to_status').notNull().references(() => statuses.key),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);

export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    zoneId: text('zone_id').notNull().references(() => zones.id),
    requestType: text('request_type').notNull(), // 'access' | 'erasure' | ... | '*'
    /** Stored in minutes so short SLAs are expressible and testable. */
    targetMinutes: integer('target_minutes').notNull(),
    businessDays: boolean('business_days').notNull().default(false),
    timezone: text('timezone').notNull().default('UTC'),
    /** ISO dates of public holidays for this zone's calendar. */
    holidays: jsonb('holidays').notNull().default([]),
    pauseAllowed: boolean('pause_allowed').notNull().default(false),
    extensionAllowedDays: integer('extension_allowed_days').notNull().default(0),
    /** Fractions of SLA at which to remind, e.g. [0.75, 0.9, 1.0]. */
    reminderThresholds: jsonb('reminder_thresholds').notNull().default([0.75, 0.9, 1.0]),
    escalationThreshold: jsonb('escalation_threshold').notNull().default(0.9),
  },
  (t) => [uniqueIndex('sla_policies_zone_type_ux').on(t.zoneId, t.requestType)],
);

export const assignmentConfig = pgTable('assignment_config', {
  zoneId: text('zone_id').primaryKey().references(() => zones.id),
  // 'round_robin' | 'least_open' | 'weighted' | 'manual'
  strategy: text('strategy').notNull().default('round_robin'),
  escalationEmail: text('escalation_email'),
  escalationAfterMinutes: integer('escalation_after_minutes').notNull().default(2880),
  /** Last-assigned user id for round-robin. */
  rrCursor: uuid('rr_cursor'),
});

// ---------------------------------------------------------------------------
// Intake / verification
// ---------------------------------------------------------------------------

/** A pre-submission browser session working on one form. Nothing here is a
 *  case; unverified data never touches the cases tables (spec §3). */
export const formDrafts = pgTable(
  'form_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formKey: text('form_key').notNull(),
    sessionId: text('session_id').notNull(),
    verifiedEmail: text('verified_email'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('form_drafts_session_ix').on(t.sessionId)],
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 hex of the raw token; plaintext exists only in the email. */
    tokenHash: text('token_hash').notNull(),
    draftId: uuid('draft_id').notNull().references(() => formDrafts.id),
    sessionId: text('session_id').notNull(),
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('verification_tokens_hash_ux').on(t.tokenHash)],
);

/** Rate-limit counters for verification sends (per email / per IP). */
export const rateCounters = pgTable(
  'rate_counters',
  {
    key: text('key').notNull(), // e.g. 'email:foo@bar.com' | 'ip:1.2.3.4'
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const caseSequences = pgTable(
  'case_sequences',
  {
    zoneId: text('zone_id').notNull().references(() => zones.id),
    year: integer('year').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.year] })],
);

export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseRef: text('case_ref').notNull(), // DSR-EUR-2026-00147
    zoneId: text('zone_id').notNull().references(() => zones.id),
    formKey: text('form_key').notNull(),
    formVersion: integer('form_version').notNull(),
    requestTypes: jsonb('request_types').notNull().default([]),
    /** AES-GCM envelope-encrypted requester identifiers. */
    requesterEmailEnc: text('requester_email_enc').notNull(),
    /** HMAC-SHA256 of lowercased email for equality lookup without decrypting. */
    requesterEmailHmac: text('requester_email_hmac').notNull(),
    requesterNameEnc: text('requester_name_enc'),
    status: text('status').notNull().references(() => statuses.key),
    assigneeId: uuid('assignee_id').references(() => users.id),
    /** Set once a case has been escalated for sitting unassigned. */
    unassignedEscalatedAt: timestamp('unassigned_escalated_at', { withTimezone: true }),
    /** Set when a reply goes out: 'customer' or 'internal'. */
    pendingParty: text('pending_party'),
    pendingOn: text('pending_on'),
    pendingSince: timestamp('pending_since', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    outcomeCode: text('outcome_code'),
    closureNote: text('closure_note'),
  },
  (t) => [
    uniqueIndex('cases_ref_ux').on(t.caseRef),
    index('cases_zone_ix').on(t.zoneId),
    index('cases_status_ix').on(t.status),
    index('cases_email_hmac_ix').on(t.requesterEmailHmac),
  ],
);

export const caseFields = pgTable(
  'case_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => cases.id),
    fieldKey: text('field_key').notNull(),
    /** Plain JSON value, or null when encrypted. */
    valueJson: jsonb('value_json'),
    /** AES-GCM envelope ciphertext for direct-identifier fields. */
    valueEnc: text('value_enc'),
    encrypted: boolean('encrypted').notNull().default(false),
  },
  (t) => [index('case_fields_case_ix').on(t.caseId)],
);

export const caseStatusHistory = pgTable(
  'case_status_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    caseId: uuid('case_id').notNull().references(() => cases.id),
    actorId: uuid('actor_id').references(() => users.id), // null => system
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('case_status_history_case_ix').on(t.caseId)],
);

export const caseComments = pgTable(
  'case_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => cases.id),
    authorId: uuid('author_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('case_comments_case_ix').on(t.caseId)],
);

export const caseAttachments = pgTable(
  'case_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => cases.id),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Opaque storage key — never a servable path. */
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    // 'pending' | 'clean' | 'infected' | 'error'
    scanStatus: text('scan_status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('case_attachments_case_ix').on(t.caseId)],
);

export const slaClocks = pgTable(
  'sla_clocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => cases.id),
    policyId: uuid('policy_id').notNull().references(() => slaPolicies.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    originalDueAt: timestamp('original_due_at', { withTimezone: true }).notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedTotalSecs: integer('paused_total_secs').notNull().default(0),
    // 'running' | 'paused' | 'breached' | 'stopped'
    state: text('state').notNull().default('running'),
    /** Reminder thresholds already fired, e.g. [0.75]. */
    firedThresholds: jsonb('fired_thresholds').notNull().default([]),
    extensionJustification: text('extension_justification'),
    /** Set once the escalation threshold has fired, so it fires only once. */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('sla_clocks_case_ux').on(t.caseId)],
);

// ---------------------------------------------------------------------------
// Templates / mail / audit
// ---------------------------------------------------------------------------

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  zoneId: text('zone_id').references(() => zones.id), // null => global
  requestType: text('request_type'), // null => any
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  /** 'acknowledgement' | 'follow-up' | 'outcome' | 'custom' */
  category: text('category').notNull().default('outcome'),
  version: integer('version').notNull().default(1),
  active: boolean('active').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').references(() => cases.id),
    direction: text('direction').notNull().default('outbound'),
    provider: text('provider').notNull(),
    fromAddr: text('from_addr').notNull(),
    toAddrs: jsonb('to_addrs').notNull(),
    ccAddrs: jsonb('cc_addrs'),
    bccAddrs: jsonb('bcc_addrs'),
    subject: text('subject').notNull(),
    /** What was actually sent, so the record is not just a subject line. */
    bodyHtml: text('body_html'),
    templateId: text('template_id'),
    status: text('status').notNull(), // 'sent' | 'failed'
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_log_case_ix').on(t.caseId)],
);

/** Append-only. Migration installs a trigger rejecting UPDATE/DELETE. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id'),
    actorType: text('actor_type').notNull().default('user'), // 'user' | 'system' | 'public'
    action: text('action').notNull(), // 'case.view' | 'case.status_change' | ...
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    zoneId: text('zone_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    sourceIp: text('source_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_ix').on(t.entityType, t.entityId),
    index('audit_log_created_ix').on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Runtime configuration (editable from the admin UI)
// ---------------------------------------------------------------------------

/**
 * Key/value application settings. Values here take precedence over process
 * env, so operators can configure the portal from the GUI without a redeploy.
 * Secrets (API keys, app passwords) are stored envelope-encrypted and are
 * never returned to the client in plaintext.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  /** Plaintext value; null when the value is a secret. */
  value: text('value'),
  /** AES-GCM ciphertext; null when the value is not a secret. */
  valueEnc: text('value_enc'),
  secret: boolean('secret').notNull().default(false),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
