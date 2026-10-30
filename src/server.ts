import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startKeepAwake } from './keep-awake.js';

await migrate();

const app = buildApp();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
startKeepAwake(process.env.RENDER_EXTERNAL_URL, app.log);

// The host sends SIGTERM on a redeploy. Finishing in-flight requests first means a tool
// call during a deploy still gets its answer.
process.on('SIGTERM', async () => {
  await app.close();
  await pool.end();
  process.exit(0);
});
