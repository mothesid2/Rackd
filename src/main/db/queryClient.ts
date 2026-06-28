import type Database from 'better-sqlite3';
import { getDb } from './schema';

/**
 * Thin, typed wrapper around better-sqlite3. ALL local database access should
 * go through this — never call `getDb().prepare(...)` ad hoc from feature code.
 * Reads are synchronous (that's how better-sqlite3 works) which keeps call
 * sites simple.
 *
 * Generic params let callers supply a row type:
 *   queryClient.all<SyncQueueRow>('SELECT * FROM sync_queue WHERE synced = ?', 0)
 */
export const queryClient = {
  /** Rows for a SELECT. */
  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return getDb().prepare(sql).all(...(params as never[])) as T[];
  },

  /** First row for a SELECT, or undefined. */
  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
  },

  /** INSERT/UPDATE/DELETE. Returns { changes, lastInsertRowid }. */
  run(sql: string, ...params: unknown[]): Database.RunResult {
    return getDb().prepare(sql).run(...(params as never[]));
  },

  /** Run a function inside a single transaction (all-or-nothing). */
  transaction<T>(fn: () => T): T {
    return getDb().transaction(fn)();
  },
};

export type QueryClient = typeof queryClient;
