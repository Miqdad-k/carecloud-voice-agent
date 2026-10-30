import Fastify, { type FastifyError } from 'fastify';
import { patientRoutes } from './api/patients-routes.js';
import { dashboardRoutes } from './dashboard/routes.js';
import { pool } from './db/pool.js';
import { vapiWebhookRoutes } from './vapi/webhook-routes.js';

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  // Unknown routes and unexpected errors keep the { data, error } envelope too.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ data: null, error: { message: 'Route not found.' } });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Framework errors such as bad JSON or the wrong content type are the client's
    // fault. Anything else is ours, and its details stay in the log.
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(400).send({ data: null, error: { message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ data: null, error: { message: 'Internal server error.' } });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { data: { status: 'ok' }, error: null };
  });

  app.register(patientRoutes);
  app.register(vapiWebhookRoutes);
  app.register(dashboardRoutes);

  return app;
}
