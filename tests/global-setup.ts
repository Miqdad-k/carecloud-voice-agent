import EmbeddedPostgres from 'embedded-postgres';
import { rm } from 'node:fs/promises';
import { connect } from 'node:net';

const PORT = 54331; // Must match DATABASE_URL in vitest.config.ts.

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Tests run against a real Postgres, so the constraints, enum, triggers and row
// locks are all exercised for real. Started fresh and thrown away on every run.
// Set TEST_DATABASE_URL to use an existing server instead.
export default async function setup() {
  if (process.env.TEST_DATABASE_URL) return;

  // Otherwise Postgres fails to start with an error that names nothing useful.
  // Printed rather than thrown, because vitest fails while reporting a thrown error here.
  if (await isPortInUse(PORT)) {
    console.error(`Port ${PORT} is in use, probably by a test Postgres left over from an interrupted run. Stop it and retry.`);
    process.exit(1);
  }

  const databaseDir = '.local-postgres/test';
  await rm(databaseDir, { recursive: true, force: true });

  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    // Without this, Postgres 18 starts I/O workers, and on Windows one can outlive the
    // server and keep the port open after a run.
    postgresFlags: ['-c', 'io_method=sync'],
    onLog: () => {},
  });
  // embedded-postgres installs an exit hook that calls process.exit(0), which would hide
  // vitest's failure code and make a failing run look like a pass. Keep the real code.
  const exit = process.exit;
  process.exit = ((code) => exit(process.exitCode || code)) as typeof process.exit;

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('carecloud_test');

  return async () => {
    await postgres.stop();
  };
}
