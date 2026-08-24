// Create demonstration cases, each with a real PDF attached.
//
// Useful for checking the attachment pipeline end to end without submitting the
// public form by hand: the files land in the same zone/case-ref directory a
// real submission produces, so download, export and email all exercise the
// production path.
//
//   node scripts/seed-test-cases.mjs [count]
//
// Cases are prefixed DSR-<ZONE>-<year>-9xxxx so they are obvious and easy to
// remove: node scripts/seed-test-cases.mjs --clean
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
const uploadRoot = resolve(process.env.UPLOAD_ROOT ?? '/opt/dsr/uploads')

const client = new pg.Client(url)
await client.connect()

if (process.argv.includes('--clean')) {
  const refs = await client.query(`SELECT id FROM cases WHERE case_ref ~ '-9[0-9]{4}$'`)
  const ids = refs.rows.map((r) => r.id)
  if (ids.length === 0) {
    console.log('no seeded test cases found')
  } else {
    for (const table of ['case_attachments', 'sla_clocks', 'case_status_history', 'case_fields', 'email_log']) {
      await client.query(`DELETE FROM ${table} WHERE case_id = ANY($1::uuid[])`, [ids]).catch(() => {})
    }
    await client.query('DELETE FROM cases WHERE id = ANY($1::uuid[])', [ids])
    console.log(`removed ${ids.length} test case(s)`)
  }
  await client.end()
  process.exit(0)
}

/**
 * A small but genuinely valid PDF.
 *
 * Written by hand rather than pulled from a library: the point is to exercise
 * the magic-byte check and the download path, and a real viewer must be able to
 * open it or the test proves nothing.
 */
function makePdf(title, lines) {
  const content = [
    `BT /F1 16 Tf 60 760 Td (${title.replace(/[()\\]/g, '')}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 11 Tf 60 ${720 - i * 18} Td (${String(l).replace(/[()\\]/g, '')}) Tj ET`),
  ].join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

const SAMPLES = [
  { zone: 'EUR', form: 'eur-1', types: ['access'], country: 'Germany', name: 'Anna Weber', email: 'anna.weber@example.com' },
  { zone: 'EUR', form: 'eur-2', types: ['erasure'], country: 'France', name: 'Luc Moreau', email: 'luc.moreau@example.com' },
  { zone: 'SAZ', form: 'saz-brazil', types: ['access', 'rectify'], country: 'Brazil', name: 'Camila Souza', email: 'camila.souza@example.com' },
  { zone: 'MAZ', form: 'maz-mexico', types: ['opt-out'], country: 'Mexico', name: 'Diego Ramírez', email: 'diego.ramirez@example.com' },
  { zone: 'MAZ', form: 'maz-colombia', types: ['erasure'], country: 'Colombia', name: 'Sofía Torres', email: 'sofia.torres@example.com' },
]

const count = Math.min(SAMPLES.length, Number(process.argv[2]) || 3)
const year = new Date().getFullYear()

let made = 0
for (let i = 0; i < count; i++) {
  const s = SAMPLES[i]
  const ref = `DSR-${s.zone}-${year}-9${String(1000 + i).padStart(4, '0')}`

  const exists = await client.query('SELECT id FROM cases WHERE case_ref = $1', [ref])
  if (exists.rows[0]) {
    console.log(`${ref} already exists, skipping`)
    continue
  }

  // Vary the age so the SLA states are worth looking at.
  const ageDays = [2, 12, 26][i % 3]
  const policy = await client.query(
    `SELECT target_minutes FROM sla_policies WHERE zone_id = $1 ORDER BY (request_type='*') ASC LIMIT 1`,
    [s.zone],
  )
  const targetMinutes = Number(policy.rows[0]?.target_minutes ?? 30 * 1440)

  const caseRow = await client.query(
    `INSERT INTO cases (case_ref, zone_id, form_key, form_version, request_types,
                        requester_email_enc, requester_email_hmac, status, created_at, due_at)
     VALUES ($1,$2,$3,1,$4::jsonb,'\\x00',$5,'new',
             now() - ($6 || ' days')::interval,
             now() - ($6 || ' days')::interval + ($7 || ' minutes')::interval)
     RETURNING id`,
    [ref, s.zone, s.form, JSON.stringify(s.types), `seed-${ref}`, String(ageDays), String(targetMinutes)],
  )
  const caseId = caseRow.rows[0].id

  for (const [key, value] of [
    ['country', s.country],
    ['first_name', s.name.split(' ')[0]],
    ['last_name', s.name.split(' ').slice(1).join(' ')],
    ['ticket_type', Object.fromEntries(s.types.map((t) => [t, true]))],
  ]) {
    await client.query(
      'INSERT INTO case_fields (case_id, field_key, value_json, encrypted) VALUES ($1,$2,$3::jsonb,false)',
      [caseId, key, JSON.stringify(value)],
    )
  }

  await client.query(
    `INSERT INTO case_status_history (case_id, to_status, note) VALUES ($1,'new','Seeded test case')`,
    [caseId],
  )

  const policyId = await client.query(
    `SELECT id FROM sla_policies WHERE zone_id = $1 ORDER BY (request_type='*') ASC LIMIT 1`,
    [s.zone],
  )
  if (policyId.rows[0]) {
    await client.query(
      `INSERT INTO sla_clocks (case_id, policy_id, started_at, due_at, original_due_at, state)
       SELECT $1, $2, c.created_at, c.due_at, c.due_at, 'running' FROM cases c WHERE c.id = $1
       ON CONFLICT (case_id) DO NOTHING`,
      [caseId, policyId.rows[0].id],
    )
  }

  // Two files per case: an identity document and a signed authority, so both
  // the requester-supplied and recorded-response paths have something to show.
  for (const [label, source] of [
    ['Identity document', 'requester'],
    ['Signed authority', 'response'],
  ]) {
    const pdf = makePdf(`${label} — ${ref}`, [
      `Case reference: ${ref}`,
      `Zone: ${s.zone}`,
      `Requester: ${s.name}`,
      `Email: ${s.email}`,
      `Country: ${s.country}`,
      `Request type: ${s.types.join(', ')}`,
      '',
      'This is seeded demonstration data, not a real document.',
    ])

    const filename = `${label.toLowerCase().replace(/ /g, '-')}.pdf`
    const storageKey = `${s.zone}/${ref}/${randomUUID()}-${filename}`
    const target = join(uploadRoot, storageKey)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, pdf, { mode: 0o640 })
    // Run as root the file would be unreadable by the service user, and the
    // download would fail with EACCES long after the seeding looked successful.
    if (process.getuid?.() === 0) {
      try {
        const { execSync } = await import('node:child_process')
        execSync(`chown dsr:dsr '${target}'`)
      } catch {
        console.warn('could not chown', target, '— run: chown -R dsr:dsr', uploadRoot)
      }
    }

    await client.query(
      `INSERT INTO case_attachments
         (case_id, zone_id, case_ref, filename, mime_type, size_bytes, storage_key,
          sha256, scan_status, source, note)
       VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,'clean',$8,$9)`,
      [
        caseId, s.zone, ref, filename, pdf.length, storageKey,
        createHash('sha256').update(pdf).digest('hex'), source,
        source === 'response' ? 'Returned by the requester' : null,
      ],
    )
  }

  console.log(`${ref}  ${s.zone}  ${s.name.padEnd(16)} ${ageDays}d old  2 PDFs`)
  made++
}

console.log(`\n${made} test case(s) created. Remove them with: node scripts/seed-test-cases.mjs --clean`)
await client.end()
