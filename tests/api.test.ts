import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { validPatient } from './helpers.js';

const app = buildApp({ logger: false, rateLimitPerMinute: 1000 });

beforeAll(async () => {
  await migrate();
  await app.ready();
});

beforeEach(async () => {
  await pool.query('TRUNCATE appointments, calls, patients');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function createPatient(fields: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/patients', payload: { ...validPatient, ...fields } });
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

describe('POST /patients', () => {
  it('returns 201 with the created record in the envelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/patients', payload: validPatient });
    expect(res.statusCode).toBe(201);
    const { data, error } = res.json();
    expect(error).toBeNull();
    expect(data.patient_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.phone_number).toBe('2025550147');
    expect(data.date_of_birth).toBe('03/15/1985');
    expect(data.preferred_language).toBe('English');
    expect(data.created_at).toMatch(/Z$/);
    expect(data).not.toHaveProperty('deleted_at');
  });

  it('returns 422 naming the bad field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/patients',
      payload: { ...validPatient, date_of_birth: '12/31/2999' },
    });
    expect(res.statusCode).toBe(422);
    const { data, error } = res.json();
    expect(data).toBeNull();
    expect(error.fields).toEqual([{ field: 'date_of_birth', message: 'Date of birth cannot be in the future.' }]);
  });

  it('returns 400 for broken JSON, and for JSON that is not an object', async () => {
    const broken = await app.inject({
      method: 'POST',
      url: '/patients',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().data).toBeNull();

    const array = await app.inject({ method: 'POST', url: '/patients', payload: [1, 2] });
    expect(array.statusCode).toBe(400);
  });

  it('stores SQL-looking input as plain text', async () => {
    const data = await createPatient({ city: "x'); DROP TABLE patients; --" });
    const res = await app.inject({ method: 'GET', url: `/patients/${data.patient_id}` });
    expect(res.json().data.city).toBe("x'); DROP TABLE patients; --");
  });
});

describe('GET /patients', () => {
  it('lists patients and applies all three filters', async () => {
    await createPatient();
    await createPatient({ first_name: 'Sam', last_name: 'Other', date_of_birth: '01/02/1970', phone_number: '3125550199' });

    const all = await app.inject({ method: 'GET', url: '/patients' });
    expect(all.json().data).toHaveLength(2);

    const byName = await app.inject({ method: 'GET', url: '/patients?last_name=OTHER' });
    expect(byName.json().data.map((p: { first_name: string }) => p.first_name)).toEqual(['Sam']);

    const byDob = await app.inject({ method: 'GET', url: '/patients?date_of_birth=01/02/1970' });
    expect(byDob.json().data).toHaveLength(1);

    const byPhone = await app.inject({ method: 'GET', url: '/patients?phone_number=(312)%20555-0199' });
    expect(byPhone.json().data).toHaveLength(1);

    const none = await app.inject({ method: 'GET', url: '/patients?last_name=Nobody' });
    expect(none.statusCode).toBe(200);
    expect(none.json().data).toEqual([]);
  });

  it('returns 400 for an unparseable filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/patients?date_of_birth=soon' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /patients/:id', () => {
  it('returns 200, 404 for an unknown ID, and 400 for a bad ID', async () => {
    const patient = await createPatient();
    expect((await app.inject({ method: 'GET', url: `/patients/${patient.patient_id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/patients/00000000-0000-4000-8000-00000000abcd' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/patients/not-a-uuid' })).statusCode).toBe(400);
  });
});

describe('PUT /patients/:id', () => {
  it('updates only the fields sent and moves updated_at', async () => {
    const patient = await createPatient({ email: 'jane@example.com' });
    const res = await app.inject({ method: 'PUT', url: `/patients/${patient.patient_id}`, payload: { city: 'Austin', state: 'tx' } });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.city).toBe('Austin');
    expect(data.state).toBe('TX');
    expect(data.first_name).toBe('Jane');
    expect(data.email).toBe('jane@example.com');
    expect(new Date(data.updated_at).getTime()).toBeGreaterThan(new Date(patient.updated_at).getTime());
    expect(data.created_at).toBe(patient.created_at);
  });

  it('returns 422, 404 and 400 where appropriate', async () => {
    const patient = await createPatient();
    const url = `/patients/${patient.patient_id}`;
    expect((await app.inject({ method: 'PUT', url, payload: { zip_code: '1' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PUT', url, payload: { city: null } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PUT', url, payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'PUT', url: '/patients/00000000-0000-4000-8000-00000000abcd', payload: { city: 'Austin' } })).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /patients/:id', () => {
  it('soft-deletes: the row stays, but every read stops returning it', async () => {
    const patient = await createPatient();
    const url = `/patients/${patient.patient_id}`;

    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeNull();

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/patients' })).json().data).toEqual([]);
    expect((await app.inject({ method: 'PUT', url, payload: { city: 'Austin' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(404);

    const { rows } = await pool.query('SELECT deleted_at FROM patients WHERE patient_id = $1', [patient.patient_id]);
    expect(rows[0].deleted_at).toBeInstanceOf(Date);
  });
});

describe('database constraints', () => {
  it('rejects bad data even when the validator is bypassed', async () => {
    const insert = (sex: string, phone: string, state: string) =>
      pool.query(
        `INSERT INTO patients (first_name, last_name, date_of_birth, sex, phone_number, address_line_1, city, state, zip_code)
         VALUES ('A', 'B', '1990-01-01', $1, $2, '1 St', 'C', $3, '12345')`,
        [sex, phone, state],
      );
    await expect(insert('Robot', '2025550147', 'IL')).rejects.toThrow();
    await expect(insert('Male', '555', 'IL')).rejects.toThrow();
    await expect(insert('Male', '2025550147', 'il')).rejects.toThrow();
  });
});

describe('errors', () => {
  it('returns 404 in the envelope for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ data: null, error: { message: 'Route not found.' } });
  });

  it('returns 500 without leaking details when the database write fails', async () => {
    await pool.query('ALTER TABLE patients RENAME TO patients_hidden');
    try {
      const res = await app.inject({ method: 'POST', url: '/patients', payload: validPatient });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ data: null, error: { message: 'Internal server error.' } });
    } finally {
      await pool.query('ALTER TABLE patients_hidden RENAME TO patients');
    }
  });
});

describe('dashboard', () => {
  it('lists patients and escapes anything a caller could inject', async () => {
    const patient = await createPatient({ city: '<img src=x onerror=alert(1)>' });
    await pool.query(
      `INSERT INTO calls (vapi_call_id, patient_id, status, transcript) VALUES ('c1', $1, 'completed', '<script>alert(1)</script>')`,
      [patient.patient_id],
    );

    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Jane');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('<img src');
  });
});
