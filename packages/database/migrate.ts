import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPool, type Pool } from './index.js';
export async function migrate(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(728416230)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await c.query(
        'SELECT checksum FROM schema_migrations WHERE name=$1',
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, checksum],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(728416230)');
    c.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const pool = createPool(
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL!,
  );
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
