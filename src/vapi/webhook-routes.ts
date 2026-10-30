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
      // Already authenticated, and a live call must never be throttled.
      config: { rateLimit: false },
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
  const callId = message.call?.id;
  const toolCalls = Array.isArray(message.toolCallList) ? message.toolCallList : [];

  const results: VapiToolResult[] = await Promise.all(
    // An entry with no ID cannot be answered, since Vapi matches replies by that ID.
    toolCalls.filter((toolCall) => toolCall?.id).map(async (toolCall) => {
      const name = String(toolCall.function?.name ?? 'unknown');
      // Every tool is keyed on the call. Without an ID, idempotency and the identity
      // binding have nothing to hold on to, so nothing runs.
      const outcome = callId
        ? await runTool(name, toolCall.function?.arguments, { callId, callerNumber: callerNumberOf(message) }, req.log)
        : { status: 'failed' };
      return { name, toolCallId: toolCall.id!, result: JSON.stringify(outcome) };
    }),
  );
  return { results };
}

async function handleEndOfCallReport(message: VapiEndOfCallReport, req: FastifyRequest) {
  const callId = message.call?.id;
  if (!callId) {
    req.log.error({ endedReason: message.endedReason }, 'End-of-call report without a call ID');
    return;
  }

  const model = Array.isArray(message.costs) ? message.costs.find((cost) => cost?.type === 'model') : undefined;
  const tokens = {
    promptTokens: model?.promptTokens ?? null,
    completionTokens: model?.completionTokens ?? null,
    cachedPromptTokens: model?.cachedPromptTokens ?? null,
    costUsd: message.cost ?? null,
  };

  try {
    await saveCallReport(pool, {
      callId,
      callerNumber: callerNumberOf(message),
      transcript: message.artifact?.transcript ?? null,
      summary: message.analysis?.summary ?? null,
      endedReason: message.endedReason ?? null,
      startedAt: message.startedAt ?? null,
      endedAt: message.endedAt ?? null,
      ...tokens,
    });
    req.log.info({ callId, endedReason: message.endedReason, ...tokens }, 'Stored end-of-call report');
  } catch (err) {
    // The transcript is logged so it can still be recovered. Vapi's full message is not,
    // because it also carries the assistant config, which holds the webhook secret.
    const { message: errorMessage, code } = err as { message?: string; code?: string };
    req.log.error(
      { callId, transcript: message.artifact?.transcript, error: { message: errorMessage, code } },
      'Could not store end-of-call report',
    );
    throw err;
  }
}
