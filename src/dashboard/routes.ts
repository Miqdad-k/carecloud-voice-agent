import type { FastifyInstance } from 'fastify';
import { listAllCalls, type Call } from '../calls/repository.js';
import { pool } from '../db/pool.js';
import { listPatients, type Patient } from '../patients/repository.js';

// A read-only page rendered on the server, with no frontend build or client script.
// Names and transcripts come from callers, so every value goes through escapeHtml.

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value: Date | null): string {
  return value ? `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Time unknown';
}

function formatPhone(value: string | null): string {
  return value && value.length === 10 ? `(${value.slice(0, 3)}) ${value.slice(3, 6)}-${value.slice(6)}` : (value ?? '');
}

function field(label: string, value: string | null): string {
  return value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>` : '';
}

function renderCall(call: Call): string {
  const transcript = call.transcript
    ? `<pre>${escapeHtml(call.transcript)}</pre>`
    : '<p class="muted">No transcript stored yet.</p>';
  return `
    <details>
      <summary>Call on ${escapeHtml(formatTime(call.started_at ?? call.created_at))}
        <span class="tag">${escapeHtml(call.status)}</span></summary>
      ${call.summary ? `<p>${escapeHtml(call.summary)}</p>` : ''}
      ${transcript}
    </details>`;
}

function renderPatient(patient: Patient, calls: Call[]): string {
  const address = [patient.address_line_1, patient.address_line_2, patient.city, `${patient.state} ${patient.zip_code}`]
    .filter(Boolean)
    .join(', ');
  return `
    <article>
      <h2>${escapeHtml(patient.first_name)} ${escapeHtml(patient.last_name)}</h2>
      <dl>
        ${field('Date of birth', patient.date_of_birth)}
        ${field('Sex', patient.sex)}
        ${field('Phone', formatPhone(patient.phone_number))}
        ${field('Email', patient.email)}
        ${field('Address', address)}
        ${field('Insurance', patient.insurance_provider)}
        ${field('Member ID', patient.insurance_member_id)}
        ${field('Language', patient.preferred_language)}
        ${field('Emergency contact', patient.emergency_contact_name)}
        ${field('Emergency phone', formatPhone(patient.emergency_contact_phone))}
        ${field('Registered', formatTime(patient.created_at))}
      </dl>
      ${calls.length ? calls.map(renderCall).join('') : '<p class="muted">No calls on record. Added through the API or seed.</p>'}
    </article>`;
}

const STYLES = `
  :root { color-scheme: light dark; --bg: #f6f7f8; --card: #fff; --text: #1c2024; --muted: #60666d; --line: #dfe3e6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15171a; --card: #1e2125; --text: #e8eaed; --muted: #a0a6ad; --line: #33373c; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  h2 { margin: 0 0 12px; font-size: 19px; }
  h3 { margin: 40px 0 12px; font-size: 18px; }
  article { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-top: 16px; }
  dl { display: grid; grid-template-columns: 170px 1fr; gap: 4px 12px; margin: 0 0 12px; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  details { border-top: 1px solid var(--line); padding: 10px 0 0; margin-top: 10px; }
  summary { cursor: pointer; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.5 ui-monospace, Consolas, monospace; }
  .muted { color: var(--muted); margin: 0; }
  .tag { font-size: 13px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; margin-left: 6px; }
  @media (max-width: 560px) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 8px; } }
`;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => reply.redirect('/dashboard'));

  app.get('/dashboard', async (_req, reply) => {
    const [patients, calls] = await Promise.all([listPatients(pool), listAllCalls(pool)]);
    const unfinished = calls.filter((call) => !call.patient_id);

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Patient Registrations</title>
  <style>${STYLES}</style>
</head>
<body>
<main>
  <h1>Patient registrations</h1>
  <p class="muted">${patients.length} registered. Data on this page is synthetic.</p>
  ${patients.map((p) => renderPatient(p, calls.filter((c) => c.patient_id === p.patient_id))).join('')}
  ${patients.length ? '' : '<p>No patients registered yet.</p>'}
  ${unfinished.length ? `
  <h3>Calls with no registration</h3>
  <p class="muted">The caller hung up or the call dropped before confirming. No patient record is created for these.</p>
  <article>${unfinished.map(renderCall).join('')}</article>` : ''}
</main>
</body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
