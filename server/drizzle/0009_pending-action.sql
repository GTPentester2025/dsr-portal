-- Who a case is waiting on.
--
-- A status of "pending" says a case is blocked but not by whom, so a manager
-- scanning the queue cannot tell a case waiting on the requester from one
-- waiting on the legal team. These columns are set when a reply goes out: the
-- recipient decides the party, so it cannot drift from what actually happened.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS pending_party text;   -- 'customer' | 'internal'
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pending_on text;      -- display name(s)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS pending_since timestamptz;

COMMENT ON COLUMN cases.pending_party IS
  'Set automatically when a reply is sent: customer when it went to the requester, internal otherwise.';

CREATE INDEX IF NOT EXISTS cases_pending_idx ON cases (pending_party) WHERE pending_party IS NOT NULL;

-- Templates aimed at colleagues rather than requesters.
INSERT INTO templates (zone_id, request_type, name, subject, body, category)
VALUES
  (NULL, NULL, 'Internal: records request to a system owner',
   'Action needed: records for {{case_ref}}',
   '<p>Hello,</p><p>We have received a <strong>{{request_type}}</strong> privacy request (<strong>{{case_ref}}</strong>) and need your help to answer it.</p><p>Please provide the personal data your system holds for the requester, or confirm that it holds none. Our statutory deadline is <strong>{{due_date}}</strong>, so we need your response well before then.</p><p>Reply to this email and it will be recorded against the case.</p>',
   'internal'),
  (NULL, NULL, 'Internal: legal review required',
   'Legal review: {{case_ref}}',
   '<p>Hello,</p><p>Request <strong>{{case_ref}}</strong> ({{request_type}}) needs a legal view before we respond.</p><p>The question is whether an exemption applies and, if so, which parts of the response should be withheld.</p><p>Deadline for our reply to the requester is <strong>{{due_date}}</strong>.</p>',
   'internal'),
  (NULL, NULL, 'Internal: deletion confirmation from a system owner',
   'Confirm deletion for {{case_ref}}',
   '<p>Hello,</p><p>We must erase the requester''s personal data for <strong>{{case_ref}}</strong>.</p><p>Please delete it from your system and reply confirming what was removed and when. If anything must be retained under a legal obligation, say which records and on what basis.</p><p>Our deadline is <strong>{{due_date}}</strong>.</p>',
   'internal'),
  (NULL, NULL, 'Internal: escalation to the privacy lead',
   'Escalation: {{case_ref}} needs a decision',
   '<p>Hello,</p><p><strong>{{case_ref}}</strong> is at risk of missing its deadline of <strong>{{due_date}}</strong> and needs a decision to move forward.</p><p>Details are on the case: {{case_ref}}.</p>',
   'internal')
ON CONFLICT DO NOTHING;
