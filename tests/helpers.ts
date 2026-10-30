import { randomUUID } from 'node:crypto';

export const SECRET_HEADER = { 'x-vapi-secret': 'test-secret' };

export const validPatient = {
  first_name: 'Jane',
  last_name: "O'Neil-Doe",
  date_of_birth: '03/15/1985',
  sex: 'Female',
  phone_number: '(202) 555-0147',
  address_line_1: '12 Test Street',
  city: 'Springfield',
  state: 'IL',
  zip_code: '62701',
};

// Shaped like Vapi's tool-calls message, per its docs and OpenAPI document,
// including fields this app ignores so the handler is tested against the real noise.
export function toolCallsPayload(
  name: string,
  args: Record<string, unknown> | string,
  callId = randomUUID(),
  customerNumber = '+12025550147',
) {
  const toolCallId = `call_${randomUUID()}`;
  const toolCall = { id: toolCallId, type: 'function', function: { name, arguments: args } };
  return {
    toolCallId,
    body: {
      message: {
        timestamp: 1793350000000,
        type: 'tool-calls',
        toolCallList: [toolCall],
        toolWithToolCallList: [{ type: 'function', function: { name, parameters: { type: 'object' } }, toolCall }],
        artifact: { messages: [{ role: 'user', message: 'Yes, that is all correct.', time: 1, endTime: 2, secondsFromStart: 1 }] },
        call: {
          id: callId,
          orgId: randomUUID(),
          type: 'inboundPhoneCall',
          status: 'in-progress',
          customer: { number: customerNumber },
          createdAt: '2026-10-30T10:00:00.000Z',
          updatedAt: '2026-10-30T10:02:00.000Z',
        },
        customer: { number: customerNumber },
        phoneNumber: { id: randomUUID(), number: '+12025550100' },
        assistant: { name: 'CareCloud Patient Intake' },
      },
    },
  };
}

export function endOfCallPayload(callId: string, endedReason: string, transcript: string) {
  return {
    message: {
      type: 'end-of-call-report',
      timestamp: 1793350200000,
      endedReason,
      call: { id: callId, orgId: randomUUID(), type: 'inboundPhoneCall', customer: { number: '+12025550147' } },
      customer: { number: '+12025550147' },
      artifact: {
        transcript,
        messages: [{ role: 'bot', message: 'Thanks for calling.', time: 1, endTime: 2, secondsFromStart: 0 }],
      },
      analysis: { summary: 'The caller worked through registration.' },
      startedAt: '2026-10-30T10:00:00.000Z',
      endedAt: '2026-10-30T10:03:00.000Z',
      cost: 0.21,
    },
  };
}
