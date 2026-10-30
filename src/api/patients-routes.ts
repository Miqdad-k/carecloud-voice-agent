import type { FastifyInstance, FastifyReply } from 'fastify';
import { listAppointmentsForPatient } from '../appointments/repository.js';
import { listCallsForPatient } from '../calls/repository.js';
import { pool } from '../db/pool.js';
import { findPatient, listPatients, softDeletePatient } from '../patients/repository.js';
import { createPatient, updatePatient, type WriteResult } from '../patients/service.js';
import { isUuid, validateFilters, type FieldError } from '../patients/validation.js';

// Every response, success or failure, is { data, error }.
function fail(reply: FastifyReply, status: number, message: string, fields?: FieldError[]) {
  return reply.code(status).send({ data: null, error: { message, ...(fields && { fields }) } });
}

function isObject(body: unknown): boolean {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function sendWriteResult(reply: FastifyReply, result: WriteResult, successStatus: number) {
  if (result.kind === 'ok') return reply.code(successStatus).send({ data: result.patient, error: null });
  if (result.kind === 'invalid') return fail(reply, 422, 'Validation failed.', result.errors);
  return fail(reply, 404, 'Patient not found.');
}

// 400 means the request itself is malformed: bad JSON, a bad UUID, a bad filter.
// 422 means it was understood but a field breaks a rule.
export async function patientRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, unknown> }>('/patients', async (req, reply) => {
    const result = validateFilters(req.query);
    if (!result.ok) return fail(reply, 400, 'Invalid query parameter.', result.errors);
    return { data: await listPatients(pool, result.filters), error: null };
  });

  app.get<{ Params: { id: string } }>('/patients/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 400, 'Patient ID must be a UUID.');
    const patient = await findPatient(pool, req.params.id);
    if (!patient) return fail(reply, 404, 'Patient not found.');
    return { data: patient, error: null };
  });

  app.get<{ Params: { id: string } }>('/patients/:id/calls', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 400, 'Patient ID must be a UUID.');
    const patient = await findPatient(pool, req.params.id);
    if (!patient) return fail(reply, 404, 'Patient not found.');
    return { data: await listCallsForPatient(pool, req.params.id), error: null };
  });

  app.get<{ Params: { id: string } }>('/patients/:id/appointments', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 400, 'Patient ID must be a UUID.');
    const patient = await findPatient(pool, req.params.id);
    if (!patient) return fail(reply, 404, 'Patient not found.');
    return { data: await listAppointmentsForPatient(pool, req.params.id), error: null };
  });

  app.post('/patients', async (req, reply) => {
    if (!isObject(req.body)) return fail(reply, 400, 'Request body must be a JSON object.');
    return sendWriteResult(reply, await createPatient(req.body), 201);
  });

  app.put<{ Params: { id: string } }>('/patients/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 400, 'Patient ID must be a UUID.');
    if (!isObject(req.body)) return fail(reply, 400, 'Request body must be a JSON object.');
    if (Object.keys(req.body as object).length === 0) return fail(reply, 400, 'Request body has no fields to update.');
    return sendWriteResult(reply, await updatePatient(req.params.id, req.body), 200);
  });

  app.delete<{ Params: { id: string } }>('/patients/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 400, 'Patient ID must be a UUID.');
    const deleted = await softDeletePatient(pool, req.params.id);
    if (!deleted) return fail(reply, 404, 'Patient not found.');
    return { data: { patient_id: req.params.id, deleted: true }, error: null };
  });
}
