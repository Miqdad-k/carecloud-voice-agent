import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/agent/assistant-config.js';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { SECRET_HEADER, toolCallsPayload, validPatient } from './helpers.js';

// What a successful prompt injection could actually achieve. Each test assumes the model
// has been fully talked into doing what the caller wants, and checks that the server still
// refuses. The prompt is not involved in any of these. See docs/ADVERSARIAL_TESTS.md for
// the cases that can only be run on a live call.

let logs = '';
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logs += chunk.toString();
    done();
  },
});

const app = buildApp({ logStream, rateLimitPerMinute: 1000 });

beforeAll(async () => {
  await migrate();
  await app.ready();
});

beforeEach(async () => {
  logs = '';
  await pool.query('TRUNCATE appointments, calls, patients');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function callTool(name: string, args: Record<string, unknown>, callId = randomUUID()) {
  const { body } = toolCallsPayload(name, args, callId);
  const res = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload: body });
  return { raw: res.body, ...JSON.parse(res.json().results[0].result) };
}

const confirmed = { ...validPatient, caller_confirmed: true };

async function registerVictim() {
  await callTool('save_patient', confirmed);
  const { rows } = await pool.query('SELECT patient_id FROM patients');
  return rows[0].patient_id as string;
}

async function victimCity() {
  return (await pool.query('SELECT city FROM patients')).rows[0].city;
}

describe('a call cannot reach a record it has not earned', () => {
  it('rejects update_patient with a patient ID supplied by the model', async () => {
    const id = await registerVictim();
    const outcome = await callTool('update_patient', { patient_id: id, caller_confirmed: true, city: 'Hacked' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors[0].field).toBe('patient_id');
    expect(await victimCity()).toBe('Springfield');
  });

  it('refuses an update from a call that never verified anyone', async () => {
    await registerVictim();
    expect((await callTool('update_patient', { caller_confirmed: true, city: 'Hacked' })).status).toBe('not_verified');
    expect(await victimCity()).toBe('Springfield');
  });

  it('refuses an update after a lookup alone, since knowing a phone number is not enough', async () => {
    await registerVictim();
    const callId = randomUUID();
    await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, callId);
    expect((await callTool('update_patient', { caller_confirmed: true, city: 'Hacked' }, callId)).status).toBe('not_verified');
    expect(await victimCity()).toBe('Springfield');
  });

  it('locks identity checks after two wrong dates of birth, even for the right one', async () => {
    await registerVictim();
    const callId = randomUUID();
    await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, callId);
    expect((await callTool('verify_identity', { date_of_birth: '01/01/1990' }, callId)).status).toBe('not_verified');
    expect((await callTool('verify_identity', { date_of_birth: '01/02/1990' }, callId)).status).toBe('not_verified');
    expect((await callTool('verify_identity', { date_of_birth: validPatient.date_of_birth }, callId)).status).toBe('locked');
  });

  it('does not carry verification over to another call', async () => {
    await registerVictim();
    const first = randomUUID();
    await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, first);
    await callTool('verify_identity', { date_of_birth: validPatient.date_of_birth }, first);
    expect((await callTool('update_patient', { caller_confirmed: true, city: 'Hacked' })).status).toBe('not_verified');
  });

  it('cannot use a save to overwrite: it creates a new row at most', async () => {
    const id = await registerVictim();
    await callTool('save_patient', { ...confirmed, patient_id: id, first_name: 'Hacked' });
    const { rows } = await pool.query('SELECT first_name FROM patients ORDER BY created_at');
    expect(rows).toEqual([{ first_name: 'Jane' }]);
  });

  it('caps lookups per call, so names cannot be harvested by trying numbers', async () => {
    const callId = randomUUID();
    for (const suffix of ['01', '02', '03']) {
      expect((await callTool('lookup_patient_by_phone', { phone_number: `20255501${suffix}` }, callId)).status).toBe('no_match');
    }
    expect((await callTool('lookup_patient_by_phone', { phone_number: '2025550104' }, callId)).status).toBe('lookup_limit');
  });
});

describe('capabilities that do not exist cannot be misused', () => {
  it.each(['list_patients', 'search_patients', 'delete_patient', 'get_patient', 'run_sql', 'get_system_prompt'])(
    'has no %s tool',
    async (name) => {
      expect((await callTool(name, {})).status).toBe('failed');
    },
  );

  it('offers the model no tool that takes a patient ID, or that lists or deletes', () => {
    const { model } = buildAssistant('https://example.test', 'x');
    const toolJson = JSON.stringify(model.tools);
    expect(toolJson).not.toContain('patient_id');
    expect(toolJson).not.toMatch(/delete|list_|search/i);
  });
});

describe('nothing worth stealing reaches the model', () => {
  it('keeps every sensitive value out of tool results', async () => {
    await registerVictim();
    const callId = randomUUID();
    const results = [
      await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number }, callId),
      await callTool('verify_identity', { date_of_birth: validPatient.date_of_birth }, callId),
      await callTool('update_patient', { caller_confirmed: true, city: 'Austin' }, callId),
    ];
    const { rows } = await pool.query('SELECT patient_id, address_line_1, zip_code FROM patients');
    for (const { raw } of results) {
      expect(raw).not.toContain(rows[0].patient_id);
      expect(raw).not.toContain(rows[0].address_line_1);
      expect(raw).not.toContain(rows[0].zip_code);
      expect(raw).not.toContain('1985');
    }
  });

  it('never leaks a database error to the model', async () => {
    await pool.query('ALTER TABLE patients RENAME TO patients_hidden');
    try {
      const { raw } = await callTool('save_patient', confirmed);
      expect(raw).not.toMatch(/relation|patients_hidden|postgres|select|insert/i);
    } finally {
      await pool.query('ALTER TABLE patients_hidden RENAME TO patients');
    }
  });

  it('keeps the webhook secret and URLs out of the prompt and tool definitions', () => {
    const { model } = buildAssistant('https://secret-host.example', 'the-webhook-secret');
    const context = JSON.stringify(model);
    expect(context).not.toContain('the-webhook-secret');
    expect(context).not.toContain('secret-host');
    expect(SYSTEM_PROMPT).not.toMatch(/https?:|railway|postgres|api key/i);
  });
});

describe('logs', () => {
  it('holds no secret, and masks identifiers in the logged payload', async () => {
    await callTool('save_patient', confirmed);
    expect(logs).not.toContain('test-secret');
    expect(logs).toContain('"tool":"save_patient"');
    expect(logs).toContain('"first_name":"Jane"');
    expect(logs).toContain('"durationMs"');
    expect(logs).not.toContain('555-0147');
    expect(logs).not.toContain('03/15/1985');
    expect(logs).not.toContain('12 Test Street');
  });

  it('keeps the full payload when a save fails, as the only copy, but not the database detail', async () => {
    await pool.query('ALTER TABLE patients RENAME TO patients_hidden');
    try {
      await callTool('save_patient', confirmed);
    } finally {
      await pool.query('ALTER TABLE patients_hidden RENAME TO patients');
    }
    expect(logs).toContain('Voice tool call failed');
    expect(logs).toContain('12 Test Street');
  });

  it('does not log query strings or data from lookups and checks', async () => {
    await app.inject({ method: 'GET', url: '/patients?phone_number=3125550111&last_name=Secretname' });
    await callTool('lookup_patient_by_phone', { phone_number: '3125550122' });
    await callTool('check_fields', { email: 'private@example.com' });
    expect(logs).not.toContain('3125550111');
    expect(logs).not.toContain('Secretname');
    expect(logs).not.toContain('3125550122');
    expect(logs).not.toContain('private@example.com');
  });
});

describe('API protections', () => {
  it('rate limits by client, in the envelope, and never throttles the webhook', async () => {
    const limited = buildApp({ logger: false, rateLimitPerMinute: 3 });
    await limited.ready();
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await limited.inject({ method: 'GET', url: '/patients' })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const blocked = await limited.inject({ method: 'GET', url: '/patients' });
    expect(blocked.json().data).toBeNull();
    expect(blocked.json().error.message).toContain('Too many requests');

    const { body } = toolCallsPayload('check_fields', { city: 'Austin' });
    const webhook = await limited.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload: body });
    expect(webhook.statusCode).toBe(200);
    await limited.close();
  });

  it('rejects an oversized API body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/patients',
      payload: { ...validPatient, city: 'x'.repeat(200 * 1024) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().data).toBeNull();
  });

  it('sets security headers, and the dashboard allows no scripts', async () => {
    const dashboard = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboard.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(dashboard.headers['x-content-type-options']).toBe('nosniff');
    expect(dashboard.body).not.toContain('<script');
    expect(dashboard.body).not.toContain('test-secret');
    expect(dashboard.body).not.toContain(process.env.DATABASE_URL!);
  });
});
