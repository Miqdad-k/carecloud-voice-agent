import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

// A real Postgres for local work, with no install or Docker. Leave it running in its
// own terminal. Data is kept in .local-postgres/dev between runs.
const databaseDir = '.local-postgres/dev';
const port = 54330;

const postgres = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  // Without this, Postgres 18 starts I/O workers, and on Windows one can outlive the
  // server and keep the port open.
  postgresFlags: ['-c', 'io_method=sync'],
});

const isNew = !existsSync(`${databaseDir}/PG_VERSION`);
if (isNew) await postgres.initialise();
await postgres.start();
if (isNew) await postgres.createDatabase('carecloud');

console.log(`Postgres is running. DATABASE_URL=postgres://postgres:postgres@localhost:${port}/carecloud`);

process.on('SIGINT', async () => {
  await postgres.stop();
  process.exit(0);
});
