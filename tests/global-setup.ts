import EmbeddedPostgres from 'embedded-postgres';
import { rm } from 'node:fs/promises';

// Tests run against a real Postgres, so the constraints, enum, triggers and row
// locks are all exercised for real. Started fresh and thrown away on every run.
// Set TEST_DATABASE_URL to use an existing server instead.
export default async function setup() {
  if (process.env.TEST_DATABASE_URL) return;

  const databaseDir = '.local-postgres/test';
  await rm(databaseDir, { recursive: true, force: true });

  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port: 54331,
    persistent: false,
    onLog: () => {},
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('carecloud_test');

  return async () => {
    await postgres.stop();
  };
}
