import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import type { DestinationStream } from 'pino';
import { patientRoutes } from './api/patients-routes.js';
import { dashboardRoutes } from './dashboard/routes.js';
import { pool } from './db/pool.js';
import { vapiWebhookRoutes } from './vapi/webhook-routes.js';

const API_BODY_LIMIT = 100 * 1024; // A patient record is far smaller. The webhook sets its own.
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

type AppOptions = {
  logger?: boolean;
  logStream?: DestinationStream;
  rateLimitPerMinute?: number;
};

export function buildApp(options: AppOptions = {}) {
  const logging = options.logger ?? true;

  const app = Fastify({
    bodyLimit: API_BODY_LIMIT,
    // Render's proxy sits in front, so the real client IP is in X-Forwarded-For.
    // The rate limit would otherwise treat every caller as one client.
    trustProxy: true,
    logger: logging && {
      ...(options.logStream && { stream: options.logStream }),
      // Query strings hold phone numbers and names, and headers hold the webhook secret,
      // so the log keeps only the method and path.
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }),
      },
      redact: ['headers.authorization', 'headers["x-vapi-secret"]'],
    },
  });

  // Unknown routes and unexpected errors keep the { data, error } envelope too.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ data: null, error: { message: 'Route not found.' } });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.statusCode === 429) {
      return reply.code(429).send({ data: null, error: { message: 'Too many requests. Try again in a minute.' } });
    }
    // Framework errors such as bad JSON or the wrong content type are the client's
    // fault. Anything else is ours, and its details stay in the log.
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(400).send({ data: null, error: { message: err.message } });
    }
    // Message and code only: a Postgres error's detail field can quote the whole row.
    req.log.error({ error: { message: err.message, code: err.code } }, 'Request failed');
    return reply.code(500).send({ data: null, error: { message: 'Internal server error.' } });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  // The API is open so reviewers can use it, which makes this the one protection against
  // someone hammering it. Keyed on IP, in memory: enough for a single instance.
  app.register(rateLimit, {
    global: true,
    max: options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
  });

  app.get('/health', { config: { rateLimit: false } }, async () => {
    await pool.query('SELECT 1');
    return { data: { status: 'ok' }, error: null };
  });

  app.register(patientRoutes);
  app.register(vapiWebhookRoutes);
  app.register(dashboardRoutes);

  return app;
}
