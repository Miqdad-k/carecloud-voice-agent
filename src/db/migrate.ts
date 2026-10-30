import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from './pool.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

// Runs each .sql file in name order, once. Applied files are recorded in
// schema_migrations, so running this on every server start is safe.
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const filename of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (rowCount) continue;

    const sql = await readFile(new URL(filename, MIGRATIONS_DIR), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    });
    console.log(`Applied migration ${filename}`);
  }
}

// Run directly with `npm run migrate`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate();
  await pool.end();
}
