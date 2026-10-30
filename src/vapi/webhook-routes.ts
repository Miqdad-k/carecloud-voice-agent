import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { saveCallReport } from '../calls/repository.js';
import { requireEnv } from '../config.js';
import { pool } from '../db/pool.js';
import {
  callerNumberOf,
  type VapiEndOfCallReport,
  type VapiMessage,
  type VapiToolCallsMessage,
  type VapiToolResult,
} from './payloads.js';
import { runTool } from './tools.js';

// The telephony boundary. Everything Vapi-specific about HTTP lives in this file:
// the secret, the message types and the reply format. The data layer knows nothing
// about Vapi. These responses are not in the { data, error } envelope because
// Vapi dictates their shape.

const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024; // End-of-call reports carry the full transcript.

export async function vapiWebhookRoutes(app: FastifyInstance) {
  // Read at startup, so a missing secret stops the app instead of leaving the
  // webhook open.
  const secret = Buffer.from(requireEnv('VAPI_WEBHOOK_SECRET'));

  function hasValidSecret(req: FastifyRequest): boolean {
    const sent = Buffer.from(String(req.headers['x-vapi-secret'] ?? ''));
    // timingSafeEqual avoids leaking the secret through response timing. It throws
    // on different lengths, so that is checked first.
    return sent.length === secret.length && timingSafeEqual(sent, secret);
  }

  app.post<{ Body: { message?: VapiMessage } }>(
    '/vapi/webhook',
    {
      bodyLimit: WEBHOOK_BODY_LIMIT,
      // onRequest runs before the body is parsed, so an unauthenticated caller
      // cannot make the server do any work.
      onRequest: async (req, reply) => {
        if (!hasValidSecret(req)) {
          req.log.warn('Rejected Vapi webhook with a bad secret');
          return reply.code(401).send({ data: null, error: { message: 'Invalid webhook secret.' } });
        }
      },
    },
    async (req, reply) => {
      const message = req.body?.message;
      if (!message?.type) {
        return reply.code(400).send({ data: null, error: { message: 'Missing message.type.' } });
      }

      if (message.type === 'tool-calls') {
        return handleToolCalls(message as VapiToolCallsMessage, req);
      }
      if (message.type === 'end-of-call-report') {
        await handleEndOfCallReport(message as VapiEndOfCallReport, req);
        return {};
      }

      // Everything else is informational. Vapi only needs a 200.
      return {};
    },
  );
}

async function handleToolCalls(message: VapiToolCallsMessage, req: FastifyRequest) {
  const context = {
    // Falls back to a per-request ID so a save is never keyed on nothing.
    callId: message.call?.id ?? `unknown-${req.id}`,
    callerNumber: callerNumberOf(message),
  };

  const results: VapiToolResult[] = await Promise.all(
    (message.toolCallList ?? []).map(async (toolCall) => {
      const outcome = await runTool(toolCall.function.name, toolCall.function.arguments, context, req.log);
      return { name: toolCall.function.name, toolCallId: toolCall.id, result: JSON.stringify(outcome) };
    }),
  );
  return { results };
}

async function handleEndOfCallReport(message: VapiEndOfCallReport, req: FastifyRequest) {
  const callId = message.call?.id;
  if (!callId) {
    req.log.error({ report: message }, 'End-of-call report without a call ID');
    return;
  }

  try {
    await saveCallReport(pool, {
      callId,
      callerNumber: callerNumberOf(message),
      transcript: message.artifact?.transcript ?? null,
      summary: message.analysis?.summary ?? null,
      endedReason: message.endedReason ?? null,
      startedAt: message.startedAt ?? null,
      endedAt: message.endedAt ?? null,
    });
    req.log.info({ callId, endedReason: message.endedReason }, 'Stored end-of-call report');
  } catch (err) {
    // Logged in full so the transcript can still be recovered from the logs.
    req.log.error({ callId, report: message, err }, 'Could not store end-of-call report');
    throw err;
  }
}
