import type { Db } from '../db/pool.js';

export type Appointment = {
  appointment_id: string;
  patient_id: string;
  date: string;
  time: string;
};

const COLUMNS = `appointment_id, patient_id, to_char(appointment_date, 'YYYY-MM-DD') AS date,
  to_char(appointment_time, 'HH24:MI') AS time`;

export async function listBookedSlots(db: Db): Promise<Set<string>> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM appointments WHERE appointment_date >= CURRENT_DATE`);
  return new Set(rows.map((row: Appointment) => `${row.date}T${row.time}`));
}

export async function findAppointmentForCall(db: Db, callId: string): Promise<Appointment | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM appointments WHERE vapi_call_id = $1`, [callId]);
  return rows[0] ?? null;
}

// Returns null if someone else already has that slot.
export async function insertAppointment(db: Db, patientId: string, callId: string, slot: string): Promise<Appointment | null> {
  const [date, time] = slot.split('T');
  const { rows } = await db.query(
    `INSERT INTO appointments (patient_id, vapi_call_id, appointment_date, appointment_time)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (appointment_date, appointment_time) DO NOTHING
     RETURNING ${COLUMNS}`,
    [patientId, callId, date, time],
  );
  return rows[0] ?? null;
}

export async function listAppointmentsForPatient(db: Db, patientId: string): Promise<Appointment[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM appointments WHERE patient_id = $1 ORDER BY appointment_date, appointment_time`,
    [patientId],
  );
  return rows;
}

export async function listAllAppointments(db: Db): Promise<Appointment[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM appointments ORDER BY appointment_date, appointment_time`);
  return rows;
}
