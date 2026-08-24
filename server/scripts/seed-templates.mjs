// Seed the response template library.
//
// Idempotent: a template is matched on (name, zone) and updated in place, so
// re-running never duplicates. Wording is a professional starting point and
// should be reviewed by Legal before go-live.
//
//   node scripts/seed-templates.mjs
import pg from 'pg'

const url = process.env.DATABASE_URL ?? 'postgres://dsr:dsr@127.0.0.1:5433/dsr'

/** Shared shell so every message looks like it came from the same team. */
const wrap = (body) => `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:640px">
${body}
<p style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:13px;color:#666">
Kind regards,<br><strong>{{zone}} Privacy Team</strong><br>
Reference <strong>{{case_ref}}</strong> &middot; please quote this in any reply.
</p>
</div>`

const p = (t) => `<p>${t}</p>`

const TEMPLATES = [
  {
    name: 'Acknowledgement of request',
    category: 'acknowledgement',
    requestType: null,
    subject: 'We have received your privacy request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Thank you for contacting us. We have received your <strong>{{request_type}}</strong> request and it is now with our privacy team.') +
      p('Your reference number is <strong>{{case_ref}}</strong>. We expect to respond by <strong>{{due_date}}</strong>. If we need anything further from you to proceed, we will be in touch before then.') +
      p('You do not need to do anything at this stage.'),
    ),
  },
  {
    name: 'Identity verification required',
    category: 'follow-up',
    requestType: null,
    subject: 'Action needed to verify your identity ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Before we can act on your <strong>{{request_type}}</strong> request, we must be satisfied that you are the person the data relates to. This protects your information from being disclosed to someone else.') +
      p('Please reply to this message attaching <strong>one</strong> of the following:') +
      '<ul><li>A government-issued photo identity document, with the document number partially masked</li><li>A recent utility bill or bank statement showing your name and address</li></ul>' +
      p('We will only use the document to confirm your identity, and will delete it once your request is closed.') +
      p('If we do not hear from you by <strong>{{due_date}}</strong> we may close the request; you are free to submit a new one at any time.'),
    ),
  },
  {
    name: 'Request for clarification',
    category: 'follow-up',
    requestType: null,
    subject: 'We need a little more detail ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Thank you for your <strong>{{request_type}}</strong> request submitted on {{submission_date}}.') +
      p('To make sure we give you a complete and accurate answer, could you confirm the following:') +
      '<ul><li>Which product, service or account your request relates to</li><li>Any email addresses, phone numbers or account identifiers you have used with us</li><li>An approximate date range, if your request concerns a specific period</li></ul>' +
      p('Once we have this we will continue processing your request without further delay.'),
    ),
  },
  {
    name: 'Extension of the response period',
    category: 'follow-up',
    requestType: null,
    subject: 'Your request will take a little longer ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We are writing about your <strong>{{request_type}}</strong> request of {{submission_date}}.') +
      p('Because of the complexity of your request and the number of systems involved, we need more time to respond fully. We are extending the response period and now expect to reply by <strong>{{due_date}}</strong>.') +
      p('We are sorry for the delay. Your request is actively being worked on and no further action is needed from you.'),
    ),
  },
  {
    name: 'Access request fulfilled',
    requestType: 'access',
    subject: 'Your personal data ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have completed your access request of {{submission_date}}.') +
      p('Attached is a copy of the personal data we hold about you, together with an explanation of where it came from, why we process it, how long we keep it and who we share it with.') +
      p('If anything in the file looks inaccurate or incomplete, you may ask us to correct it. You also have the right to complain to your local supervisory authority.'),
    ),
  },
  {
    name: 'Deletion completed',
    requestType: 'erasure',
    subject: 'Your data has been deleted ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have completed your deletion request of {{submission_date}}.') +
      p('The personal data we held about you has been erased from our active systems, and our suppliers who processed it on our behalf have been instructed to do the same.') +
      p('Please note we must keep a minimal record of your request itself, and a limited set of data where the law requires us to retain it, for example for tax or fraud-prevention purposes. That data is locked from any other use.'),
    ),
  },
  {
    name: 'Rectification completed',
    requestType: 'rectify',
    subject: 'Your details have been corrected ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have updated the information you asked us to correct, following your request of {{submission_date}}.') +
      p('Where we had shared the earlier version with other organisations, we have notified them of the correction.') +
      p('Please review the change and let us know if anything is still not right.'),
    ),
  },
  {
    name: 'Portability data provided',
    requestType: 'port',
    subject: 'Your data, ready to move ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Following your portability request of {{submission_date}}, attached is the personal data you provided to us, in a structured, commonly used and machine-readable format.') +
      p('You are free to pass this file to another provider. If you would like us to transmit it directly to another organisation and it is technically feasible, reply to this message and we will arrange it.'),
    ),
  },
  {
    name: 'Objection upheld',
    requestType: 'object',
    subject: 'We have stopped processing your data ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have considered your objection of {{submission_date}} and have stopped the processing you objected to.') +
      p('You will no longer receive the communications concerned, and your details have been added to our suppression list so this preference is respected in future.'),
    ),
  },
  {
    name: 'Objection not upheld',
    requestType: 'object',
    subject: 'Outcome of your objection ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have carefully considered your objection of {{submission_date}}.') +
      p('On this occasion we are continuing the processing, because we have compelling legitimate grounds that override your interests, rights and freedoms, or because the processing is needed to establish, exercise or defend legal claims.') +
      p('We appreciate this may not be the answer you hoped for. If you disagree you may complain to your local supervisory authority, or reply to this message with any further information you would like us to consider.'),
    ),
  },
  {
    name: 'Consent withdrawn',
    requestType: 'opt-out',
    subject: 'Your preferences have been updated ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have recorded your withdrawal of consent, received on {{submission_date}}.') +
      p('You will stop receiving the communications concerned. Please allow a few days for the change to reach every channel.') +
      p('Withdrawing consent does not affect processing carried out before you withdrew it, and we may still contact you where we have another lawful basis, for example about an order or a safety notice.'),
    ),
  },
  {
    name: 'Request partially fulfilled',
    requestType: null,
    subject: 'Outcome of your request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have completed your <strong>{{request_type}}</strong> request of {{submission_date}}.') +
      p('We have been able to action most of what you asked for. We were unable to action part of it, because the data concerned includes information about other people, or is covered by an exemption that applies to us.') +
      p('The attached response sets out exactly what we have and have not done, and why. If you would like us to reconsider any part, simply reply to this message.'),
    ),
  },
  {
    name: 'Request refused',
    requestType: null,
    subject: 'We are unable to action your request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have considered your <strong>{{request_type}}</strong> request of {{submission_date}} and are unable to action it on this occasion.') +
      p('This is because the request is manifestly unfounded or excessive, or because an exemption available to us applies. The attached response explains our reasoning in full.') +
      p('You have the right to complain to your local supervisory authority, and to seek a judicial remedy. If you believe we have misunderstood your request, please reply and we will look again.'),
    ),
  },
  {
    name: 'Identity not verified, request closed',
    requestType: null,
    subject: 'We have closed your request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('On {{submission_date}} we received a <strong>{{request_type}}</strong> request in your name, and asked for information to confirm your identity.') +
      p('As we have not been able to verify it, we are closing the request without action. We cannot release or change personal data without being confident who we are dealing with.') +
      p('You are very welcome to submit a fresh request at any time.'),
    ),
  },
  {
    name: 'Request outside our control',
    requestType: null,
    subject: 'Your request has been redirected ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Thank you for your request of {{submission_date}}.') +
      p('The data you have asked about is not controlled by our organisation, so we are not able to action the request ourselves.') +
      p('We have set out in the attached response who the responsible organisation appears to be, so that you can approach them directly. We are sorry we could not help further on this occasion.'),
    ),
  },
  {
    name: 'Request withdrawn by the requester',
    requestType: null,
    subject: 'Your request has been withdrawn ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('As you asked, we have withdrawn your <strong>{{request_type}}</strong> request of {{submission_date}} and closed the case.') +
      p('Nothing further will happen, and no changes have been made to your data as a result of it. If you change your mind you can submit a new request at any time.'),
    ),
  },
  // A couple of zone-specific variants where the regime differs materially.
  {
    name: 'LGPD confirmation of processing',
    zone: 'SAZ',
    requestType: 'confirmation',
    subject: 'Confirmation of processing ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Following your request of {{submission_date}} under Article 18 of the LGPD, we confirm that we do process personal data relating to you.') +
      p('The attached response sets out the categories of data, the purposes and legal basis for processing, how long we keep it, and the public and private entities with which we share it.') +
      p('You may at any time ask us to correct, anonymise, block or delete that data, or ask about the consequences of refusing consent.'),
    ),
  },
  {
    name: 'ARCO rights response',
    zone: 'MAZ',
    requestType: null,
    subject: 'Response to your ARCO request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We have completed the ARCO request (access, rectification, cancellation or opposition) that you submitted on {{submission_date}}.') +
      p('The attached response explains the determination we have reached and the steps we have taken.') +
      p('If you disagree with our determination, you may bring the matter before the competent data protection authority within the time limits set by local law.'),
    ),
  },
  // ---- follow-ups -----------------------------------------------------------
  // The library was heavy on outcome letters and thin on the messages a case
  // actually needs while it is open. These cover the common waits.
  {
    name: 'Reminder: we are still waiting for you',
    category: 'follow-up',
    requestType: null,
    subject: 'Reminder about your privacy request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We wrote to you on {{submission_date}} about your <strong>{{request_type}}</strong> request and have not yet had a reply.') +
      p('We cannot take the request further until we hear from you. Your reference is <strong>{{case_ref}}</strong>.') +
      p('If we do not receive a response, we may close the request. You are free to submit a new one at any time.'),
    ),
  },
  {
    name: 'Progress update',
    category: 'follow-up',
    requestType: null,
    subject: 'Update on your privacy request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We wanted to let you know that work on your <strong>{{request_type}}</strong> request is under way.') +
      p('We are still on track to respond by <strong>{{due_date}}</strong> and will contact you if anything changes.') +
      p('There is nothing you need to do. Your reference is <strong>{{case_ref}}</strong>.'),
    ),
  },
  {
    name: 'Additional information received, thank you',
    category: 'follow-up',
    requestType: null,
    subject: 'Thank you — we have what we need ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Thank you for sending the information we asked for. We now have what we need to continue with your request.') +
      p('We expect to respond by <strong>{{due_date}}</strong>. Your reference remains <strong>{{case_ref}}</strong>.'),
    ),
  },
  {
    name: 'Request transferred to another team',
    category: 'follow-up',
    requestType: null,
    subject: 'Your request has been passed to the right team ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Your <strong>{{request_type}}</strong> request has been passed to the team best placed to handle it.') +
      p('This does not change the deadline. We still expect to respond by <strong>{{due_date}}</strong>.') +
      p('Your reference is unchanged: <strong>{{case_ref}}</strong>.'),
    ),
  },
  {
    name: 'Scope confirmation before we proceed',
    category: 'follow-up',
    requestType: null,
    subject: 'Confirming the scope of your request ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('Before we proceed, we would like to confirm what you are asking for, so that our response is useful to you.') +
      p('Please confirm the period and the systems or services your request covers. If you would like everything we hold, simply reply saying so.') +
      p('The deadline of <strong>{{due_date}}</strong> still applies. Your reference is <strong>{{case_ref}}</strong>.'),
    ),
  },
  {
    name: 'Apology for a delayed response',
    category: 'follow-up',
    requestType: null,
    subject: 'We are sorry for the delay ({{case_ref}})',
    body: wrap(
      p('Dear {{requester_name}},') +
      p('We are sorry that we have not yet responded to your <strong>{{request_type}}</strong> request within the time we promised.') +
      p('Your request has not been forgotten. It is with {{assignee_name}}, and we are working to complete it as quickly as we can.') +
      p('We will write again with a substantive response. Your reference is <strong>{{case_ref}}</strong>.'),
    ),
  },
]

const client = new pg.Client(url)
await client.connect()

// Attribute the seeds to a real user where one exists.
const owner = (
  await client.query(
    `SELECT id FROM users WHERE role IN ('super_admin','admin') ORDER BY created_at LIMIT 1`,
  )
).rows[0]?.id ?? null

let created = 0
let updated = 0

for (const t of TEMPLATES) {
  const zone = t.zone ?? null
  const existing = await client.query(
    'SELECT id, version FROM templates WHERE name = $1 AND zone_id IS NOT DISTINCT FROM $2',
    [t.name, zone],
  )
  if (existing.rowCount) {
    await client.query(
      `UPDATE templates
          SET subject = $1, body = $2, request_type = $3, version = version + 1,
              active = true, updated_by = $4, updated_at = now()
        WHERE id = $5`,
      [t.subject, t.body, t.requestType ?? null, owner, existing.rows[0].id],
    )
    updated++
  } else {
    await client.query(
      `INSERT INTO templates (zone_id, request_type, name, subject, body, category, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [zone, t.requestType ?? null, t.name, t.subject, t.body, t.category ?? 'outcome', owner],
    )
    created++
  }
}

console.log(`templates seeded: ${created} created, ${updated} updated, ${TEMPLATES.length} total`)
await client.end()
