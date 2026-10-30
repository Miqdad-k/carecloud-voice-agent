import { pool } from '../db/pool.js';
import { listPatients } from '../patients/repository.js';
import { registerPatientFromCall, updatePatientFromCall, type WriteResult } from '../patients/service.js';
import { isUuid, validateFilters, validatePatient } from '../patients/validation.js';

// What each tool does when the agent calls it. Every outcome is a small object with
// a status. The system prompt tells the agent what to say for each status, so
// wording stays in the prompt and rules stay here.

export type ToolContext = { callId: string; callerNumber: string | null };
type ToolOutcome = { status: string; [key: string]: unknown };
type Args = Record<string, unknown>;
type Logger = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

// Names only, on purpose. Anyone can say a phone number, so the agent is never given
// an existing patient's date of birth or address to read out.
async function lookupPatientByPhone(args: Args): Promise<ToolOutcome> {
  const result = validateFilters({ phone_number: String(args.phone_number ?? '') });
  if (!result.ok) return { status: 'invalid', errors: result.errors };
  if (!result.filters.phone_number) {
    return { status: 'invalid', errors: [{ field: 'phone_number', message: 'Phone number is required.' }] };
  }

  const patients = await listPatients(pool, { phone_number: result.filters.phone_number });
  if (patients.length === 0) return { status: 'no_match' };
  return {
    status: 'match_found',
    matches: patients.map((p) => ({ patient_id: p.patient_id, first_name: p.first_name, last_name: p.last_name })),
  };
}

// Lets the agent check an answer the moment the caller gives it, using the same
// rules as the save, instead of finding out after the read-back.
function checkFields(args: Args): ToolOutcome {
  const result = validatePatient(args, 'partial');
  return result.ok ? { status: 'valid' } : { status: 'invalid', errors: result.errors };
}

function describeWrite(result: WriteResult, successStatus: string): ToolOutcome {
  if (result.kind === 'invalid') return { status: 'invalid', errors: result.errors };
  if (result.kind === 'not_found') return { status: 'not_found' };
  return {
    status: result.alreadySaved ? 'already_saved' : successStatus,
    patient_id: result.patient.patient_id,
    first_name: result.patient.first_name,
  };
}

const NOT_CONFIRMED: ToolOutcome = {
  status: 'not_confirmed',
  message: 'Nothing was saved. Read the details back and get a clear yes from the caller first.',
};

// caller_confirmed is not a patient field, so it is removed before validation. Only
// the boolean true counts: not "true", not a missing value.
async function savePatient(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const { caller_confirmed, ...fields } = args;
  if (caller_confirmed !== true) return NOT_CONFIRMED;
  return describeWrite(await registerPatientFromCall(ctx.callId, ctx.callerNumber, fields), 'saved');
}

async function updatePatientTool(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const { caller_confirmed, patient_id, ...fields } = args;
  if (caller_confirmed !== true) return NOT_CONFIRMED;
  if (typeof patient_id !== 'string' || !isUuid(patient_id)) return { status: 'not_found' };
  return describeWrite(await updatePatientFromCall(ctx.callId, ctx.callerNumber, patient_id, fields), 'updated');
}

const TOOLS: Record<string, (args: Args, ctx: ToolContext) => ToolOutcome | Promise<ToolOutcome>> = {
  lookup_patient_by_phone: lookupPatientByPhone,
  check_fields: checkFields,
  save_patient: savePatient,
  update_patient: updatePatientTool,
};

function parseArguments(raw: Args | string): Args {
  return typeof raw === 'string' ? (JSON.parse(raw || '{}') as Args) : raw;
}

// Never throws. A failure here must become something the agent can say out loud,
// because an unhandled error would leave the caller listening to silence. The full
// payload is logged both ways, as the spec asks, and so a failed save is recoverable.
export async function runTool(name: string, rawArgs: Args | string, ctx: ToolContext, log: Logger): Promise<ToolOutcome> {
  let args: Args = {};
  try {
    const tool = TOOLS[name];
    if (!tool) {
      log.error({ callId: ctx.callId, tool: name }, 'Unknown tool called');
      return { status: 'failed', message: 'That action is not available.' };
    }
    args = parseArguments(rawArgs);
    const outcome = await tool(args, ctx);
    log.info({ callId: ctx.callId, tool: name, payload: args, outcome }, 'Voice tool call');
    return outcome;
  } catch (err) {
    log.error({ callId: ctx.callId, tool: name, payload: args, rawArgs, err }, 'Voice tool call failed');
    return { status: 'failed', message: 'The records system had a problem and nothing was saved.' };
  }
}
