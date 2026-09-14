// A D1-shaped database over node:sqlite, so worker/api.js runs in the suite the way it runs in the Worker: the
// same migration files, the same prepare().bind().first()/all()/run() calls, and batch() as one transaction.
// Nothing else of D1 is imitated because nothing else is used. node:sqlite ships with Node 22.13 and newer;
// on older Nodes the API test skips itself and says so.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'migrations');

export async function sqliteAvailable() {
  try { await import('node:sqlite'); return true; } catch { return false; }
}

/** A fresh in-memory database with every migration applied, wearing D1's interface. */
export async function openD1() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 enforces them; so does this
  const files = (await fs.readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) db.exec(await fs.readFile(path.join(MIGRATIONS, f), 'utf8'));
  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ success: true, results: db.prepare(sql).all(...params) }),
    run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
    exec: () => db.prepare(sql).run(...params),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ success: true, meta: { changes: s.exec().changes } }));
        db.exec('COMMIT');
        return out;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    sqlite: db, // for a test to look at the rows directly
  };
}
