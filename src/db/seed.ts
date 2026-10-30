import { migrate } from './migrate.js';
import { pool } from './pool.js';

// Invented demonstration records. No real person's data. Phone numbers are in
// the 555-01xx range reserved for fiction. Fixed IDs make the seed safe to re-run.
await migrate();

await pool.query(`
  INSERT INTO patients (
    patient_id, first_name, last_name, date_of_birth, sex, phone_number, email,
    address_line_1, city, state, zip_code
  ) VALUES
    ('00000000-0000-4000-8000-000000000001', 'Sample', 'Patient-One', '1985-03-15', 'Female', '2025550101',
     'sample.one@example.com', '100 Example Street', 'Springfield', 'IL', '62701'),
    ('00000000-0000-4000-8000-000000000002', 'Demo', 'Patient-Two', '1972-11-02', 'Male', '2025550102',
     NULL, '200 Placeholder Avenue', 'Madison', 'WI', '53703')
  ON CONFLICT (patient_id) DO NOTHING`);

await pool.query(`
  INSERT INTO calls (vapi_call_id, patient_id, status, caller_number, transcript, ended_reason, started_at, ended_at)
  VALUES (
    'seed-call-0001', '00000000-0000-4000-8000-000000000001', 'completed', '+12025550101',
    E'AI: Thanks for calling. Can I start with your first and last name?\\nUser: Sample Patient-One.\\nAI: (Synthetic seed transcript, shortened.)\\nAI: You''re all set, Sample.',
    'assistant-ended-call', now() - interval '1 day', now() - interval '1 day' + interval '3 minutes'
  )
  ON CONFLICT (vapi_call_id) DO NOTHING`);

console.log('Seed data is in place.');
await pool.end();
