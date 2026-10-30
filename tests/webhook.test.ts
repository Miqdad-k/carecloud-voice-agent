import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { endOfCallPayload, SECRET_HEADER, toolCallsPayload, validPatient } from './helpers.js';

const app = buildApp({ logger: false });

beforeAll(async () => {
  await migrate();
  await app.ready();
});

beforeEach(async () => {
  await pool.query('TRUNCATE calls, patients');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function callTool(name: string, args: Record<string, unknown> | string, callId = randomUUID()) {
  const { toolCallId, body } = toolCallsPayload(name, args, callId);
  const res = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload: body });
  // Vapi ignores any reply that is not a 200, even for a failed tool.
  expect(res.statusCode).toBe(200);
  const { results } = res.json();
  expect(results).toHaveLength(1);
  expect(results[0].toolCallId).toBe(toolCallId);
  expect(results[0].name).toBe(name);
  expect(typeof results[0].result).toBe('string');
  expect(results[0].result).not.toContain('\n');
  return JSON.parse(results[0].result);
}

const countPatients = async () => (await pool.query('SELECT count(*)::int AS n FROM patients')).rows[0].n;
const confirmed = { ...validPatient, caller_confirmed: true };

describe('webhook authentication', () => {
  const { body } = toolCallsPayload('check_fields', { city: 'Austin' });

  it('rejects a missing or wrong secret with 401', async () => {
    const missing = await app.inject({ method: 'POST', url: '/vapi/webhook', payload: body });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: { 'x-vapi-secret': 'nope' }, payload: body });
    expect(wrong.statusCode).toBe(401);
  });

  it('rejects a body with no message', async () => {
    const res = await app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('acknowledges informational messages with 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vapi/webhook',
      headers: SECRET_HEADER,
      payload: { message: { type: 'status-update', status: 'in-progress', call: { id: 'x' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
});

describe('save_patient', () => {
  it('saves a confirmed registration and links the call', async () => {
    const callId = randomUUID();
    const outcome = await callTool('save_patient', confirmed, callId);
    expect(outcome.status).toBe('saved');
    expect(outcome.first_name).toBe('Jane');

    const api = await app.inject({ method: 'GET', url: `/patients/${outcome.patient_id}` });
    expect(api.json().data.last_name).toBe("O'Neil-Doe");

    const { rows } = await pool.query('SELECT patient_id, caller_number FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0]).toEqual({ patient_id: outcome.patient_id, caller_number: '+12025550147' });
  });

  it('accepts arguments sent as a JSON string as well as an object', async () => {
    const outcome = await callTool('save_patient', JSON.stringify(confirmed));
    expect(outcome.status).toBe('saved');
  });

  it.each([[{ ...validPatient }], [{ ...validPatient, caller_confirmed: false }], [{ ...validPatient, caller_confirmed: 'true' }]])(
    'refuses without a real confirmation',
    async (args) => {
      const outcome = await callTool('save_patient', args);
      expect(outcome.status).toBe('not_confirmed');
      expect(await countPatients()).toBe(0);
    },
  );

  it('is idempotent on the call ID: a retry creates no second patient', async () => {
    const callId = randomUUID();
    const first = await callTool('save_patient', confirmed, callId);
    const retry = await callTool('save_patient', confirmed, callId);
    expect(retry.status).toBe('already_saved');
    expect(retry.patient_id).toBe(first.patient_id);
    expect(await countPatients()).toBe(1);
  });

  it('stays idempotent when two retries arrive at the same moment', async () => {
    const callId = randomUUID();
    const outcomes = await Promise.all([
      callTool('save_patient', confirmed, callId),
      callTool('save_patient', confirmed, callId),
      callTool('save_patient', confirmed, callId),
    ]);
    expect(new Set(outcomes.map((o) => o.patient_id)).size).toBe(1);
    expect(await countPatients()).toBe(1);
  });

  it('allows a second patient with the same phone from a different call', async () => {
    await callTool('save_patient', confirmed);
    const child = await callTool('save_patient', { ...confirmed, first_name: 'Junior', date_of_birth: '01/01/2015' });
    expect(child.status).toBe('saved');
    expect(await countPatients()).toBe(2);
  });

  it('returns the specific invalid fields and saves nothing', async () => {
    const outcome = await callTool('save_patient', { ...confirmed, date_of_birth: '12/31/2999', zip_code: '1' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors.map((e: { field: string }) => e.field).sort()).toEqual(['date_of_birth', 'zip_code']);
    expect(await countPatients()).toBe(0);
  });

  it('reports a failed database write as a status, with a 200, then works on retry', async () => {
    const callId = randomUUID();
    await pool.query('ALTER TABLE patients RENAME TO patients_hidden');
    let outcome;
    try {
      outcome = await callTool('save_patient', confirmed, callId);
    } finally {
      await pool.query('ALTER TABLE patients_hidden RENAME TO patients');
    }
    expect(outcome.status).toBe('failed');
    expect(await countPatients()).toBe(0);

    const retry = await callTool('save_patient', confirmed, callId);
    expect(retry.status).toBe('saved');
    expect(await countPatients()).toBe(1);
  });
});

describe('lookup_patient_by_phone', () => {
  it('finds no match for a new number', async () => {
    expect((await callTool('lookup_patient_by_phone', { phone_number: '202-555-0199' })).status).toBe('no_match');
  });

  it('returns names and IDs only, for every patient on that number', async () => {
    await callTool('save_patient', confirmed);
    await callTool('save_patient', { ...confirmed, first_name: 'Junior' });
    const outcome = await callTool('lookup_patient_by_phone', { phone_number: '+1 (202) 555-0147' });
    expect(outcome.status).toBe('match_found');
    expect(outcome.matches).toHaveLength(2);
    expect(Object.keys(outcome.matches[0]).sort()).toEqual(['first_name', 'last_name', 'patient_id']);
  });

  it('rejects a short number with a specific error', async () => {
    const outcome = await callTool('lookup_patient_by_phone', { phone_number: '555' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors[0].field).toBe('phone_number');
    expect((await callTool('lookup_patient_by_phone', {})).status).toBe('invalid');
  });

  it('does not find a soft-deleted patient', async () => {
    const { patient_id } = await callTool('save_patient', confirmed);
    await app.inject({ method: 'DELETE', url: `/patients/${patient_id}` });
    expect((await callTool('lookup_patient_by_phone', { phone_number: validPatient.phone_number })).status).toBe('no_match');
  });
});

describe('check_fields', () => {
  it('passes good values and names bad ones', async () => {
    expect((await callTool('check_fields', { date_of_birth: '03/15/1985' })).status).toBe('valid');
    const outcome = await callTool('check_fields', { date_of_birth: '12/31/2999' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors).toEqual([{ field: 'date_of_birth', message: 'Date of birth cannot be in the future.' }]);
  });
});

describe('update_patient', () => {
  it('changes only the fields given and links the call', async () => {
    const { patient_id } = await callTool('save_patient', confirmed);
    const callId = randomUUID();
    const outcome = await callTool('update_patient', { patient_id, caller_confirmed: true, city: 'Austin', state: 'TX' }, callId);
    expect(outcome.status).toBe('updated');

    const { data } = (await app.inject({ method: 'GET', url: `/patients/${patient_id}` })).json();
    expect(data.city).toBe('Austin');
    expect(data.first_name).toBe('Jane');

    const { rows } = await pool.query('SELECT patient_id FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0].patient_id).toBe(patient_id);
  });

  it('refuses without confirmation, and handles bad IDs and bad values', async () => {
    const { patient_id } = await callTool('save_patient', confirmed);
    expect((await callTool('update_patient', { patient_id, city: 'Austin' })).status).toBe('not_confirmed');
    expect((await callTool('update_patient', { patient_id: 'nope', caller_confirmed: true, city: 'Austin' })).status).toBe('not_found');
    expect(
      (await callTool('update_patient', { patient_id: '00000000-0000-4000-8000-00000000abcd', caller_confirmed: true, city: 'Austin' })).status,
    ).toBe('not_found');
    expect((await callTool('update_patient', { patient_id, caller_confirmed: true, zip_code: '1' })).status).toBe('invalid');
    expect((await callTool('update_patient', { patient_id, caller_confirmed: true })).status).toBe('invalid');
  });
});

describe('unknown tools', () => {
  it('returns a failure the agent can act on', async () => {
    expect((await callTool('book_appointment', {})).status).toBe('failed');
  });

  it('survives malformed argument JSON', async () => {
    expect((await callTool('save_patient', '{ broken')).status).toBe('failed');
  });
});

describe('end-of-call-report', () => {
  const send = (payload: object) =>
    app.inject({ method: 'POST', url: '/vapi/webhook', headers: SECRET_HEADER, payload });

  it('stores the transcript as completed against the saved patient', async () => {
    const callId = randomUUID();
    const { patient_id } = await callTool('save_patient', confirmed, callId);

    const res = await send(endOfCallPayload(callId, 'assistant-ended-call', 'AI: Hello.\nUser: Hi.'));
    expect(res.statusCode).toBe(200);

    const { json } = await app.inject({ method: 'GET', url: `/patients/${patient_id}/calls` });
    const [call] = json().data;
    expect(call.status).toBe('completed');
    expect(call.transcript).toContain('User: Hi.');
    expect(call.summary).toBe('The caller worked through registration.');
    expect(call.ended_reason).toBe('assistant-ended-call');
    expect(call.started_at).toBe('2026-10-30T10:00:00.000Z');
  });

  it('keeps a dropped call as incomplete, with no patient record', async () => {
    const callId = randomUUID();
    await send(endOfCallPayload(callId, 'customer-ended-call', 'AI: Hello.\nUser: My name is'));

    const { rows } = await pool.query('SELECT status, patient_id, transcript FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows[0].status).toBe('incomplete');
    expect(rows[0].patient_id).toBeNull();
    expect(rows[0].transcript).toContain('My name is');
    expect(await countPatients()).toBe(0);

    const dashboard = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboard.body).toContain('My name is');
  });

  it('is safe to receive twice', async () => {
    const callId = randomUUID();
    await callTool('save_patient', confirmed, callId);
    const report = endOfCallPayload(callId, 'assistant-ended-call', 'AI: Hello.');
    await send(report);
    expect((await send(report)).statusCode).toBe(200);

    const { rows } = await pool.query('SELECT status FROM calls WHERE vapi_call_id = $1', [callId]);
    expect(rows).toEqual([{ status: 'completed' }]);
  });
});
