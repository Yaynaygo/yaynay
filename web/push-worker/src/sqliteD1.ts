// Dev/test stand-in for a Cloudflare D1 binding, backed by node:sqlite (Node 22.5+).
// Not deployed: the Worker and Pages Functions use the real D1 binding.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { D1Db, D1Stmt } from '../../server/pushStore.ts'

export function sqliteD1(path = ':memory:'): D1Db {
  const db = new DatabaseSync(path)
  const stmt = (sql: string, params: SQLInputValue[] = []): D1Stmt => ({
    bind: (...values: unknown[]) => stmt(sql, values as SQLInputValue[]),
    all: async <T,>() => ({ results: db.prepare(sql).all(...params) as T[] }),
    first: async <T,>() => (db.prepare(sql).get(...params) ?? null) as T | null,
    run: async () => db.prepare(sql).run(...params),
  })
  return {
    prepare: (sql) => stmt(sql),
    // Like D1, a batch is one transaction.
    batch: async (stmts) => {
      db.exec('BEGIN')
      try {
        const out: unknown[] = []
        for (const s of stmts) out.push(await s.all())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}
