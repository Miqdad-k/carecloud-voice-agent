import type { Db } from '../db/pool.js';
import type { PatientFilters, PatientInput } from './validation.js';

// SQL only. Input has already been through validation.ts by the time it gets here.
// Every read excludes soft-deleted rows.

export type Patient = {
  patient_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  sex: string;
  phone_number: string;
  email: string | null;
  address_line_1: string;
  address_line_2: string | null;
  city: string;
  state: string;
  zip_code: string;
  insurance_provider: string | null;
  insurance_member_id: string | null;
  preferred_language: string;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  created_at: Date;
  updated_at: Date;
};

// The date goes out in the same MM/DD/YYYY format the data model specifies.
const COLUMNS = `
  patient_id, first_name, last_name, to_char(date_of_birth, 'MM/DD/YYYY') AS date_of_birth,
  sex, phone_number, email, address_line_1, address_line_2, city, state, zip_code,
  insurance_provider, insurance_member_id, preferred_language,
  emergency_contact_name, emergency_contact_phone, created_at, updated_at`;

export async function listPatients(db: Db, filters: PatientFilters = {}): Promise<Patient[]> {
  const where = ['deleted_at IS NULL'];
  const params: string[] = [];

  if (filters.last_name) {
    params.push(filters.last_name);
    where.push(`lower(last_name) = lower($${params.length})`);
  }
  if (filters.date_of_birth) {
    params.push(filters.date_of_birth);
    where.push(`date_of_birth = $${params.length}`);
  }
  if (filters.phone_number) {
    params.push(filters.phone_number);
    where.push(`phone_number = $${params.length}`);
  }

  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM patients WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params,
  );
  return rows;
}

export async function findPatient(db: Db, id: string): Promise<Patient | null> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM patients WHERE patient_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertPatient(db: Db, input: PatientInput): Promise<Patient> {
  // Column names are the keys of the validation rules, never raw user input.
  const columns = Object.keys(input);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const { rows } = await db.query(
    `INSERT INTO patients (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${COLUMNS}`,
    Object.values(input),
  );
  return rows[0];
}

export async function updatePatientFields(db: Db, id: string, input: PatientInput): Promise<Patient | null> {
  const columns = Object.keys(input);
  const assignments = columns.map((column, i) => `${column} = $${i + 2}`);
  const { rows } = await db.query(
    `UPDATE patients SET ${assignments.join(', ')}
     WHERE patient_id = $1 AND deleted_at IS NULL
     RETURNING ${COLUMNS}`,
    [id, ...Object.values(input)],
  );
  return rows[0] ?? null;
}

export async function softDeletePatient(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE patients SET deleted_at = now() WHERE patient_id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rowCount === 1;
}
