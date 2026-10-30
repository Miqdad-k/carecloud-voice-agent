import pg from 'pg';
import { requireEnv } from '../config.js';

// Timeouts are short on purpose. Vapi waits on our webhook while the caller
// hears nothing, so a stuck database must fail fast and let the agent say so.
export const pool = new pg.Pool({
  connectionString: requireEnv('DATABASE_URL'),
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  // Keep connections open, so a tool call during a quiet spell doesn't pay for a new
  // connection while the caller waits.
  keepAlive: true,
  idleTimeoutMillis: 0,
});

// Without this listener, a dropped idle connection would crash the process.
pool.on('error', (err) => {
  console.error('Idle Postgres connection error', err);
});

// Anything that can run a query: the pool, or a client inside a transaction.
export type Db = Pick<pg.Pool, 'query'>;

export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
