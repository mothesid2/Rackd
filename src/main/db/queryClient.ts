import type Database from 'better-sqlite3';
import { getDb } from './schema';


export const queryClient = {
  
  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return getDb().prepare(sql).all(...(params as never[])) as T[];
  },

  
  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
  },

  
  run(sql: string, ...params: unknown[]): Database.RunResult {
    return getDb().prepare(sql).run(...(params as never[]));
  },

  
  transaction<T>(fn: () => T): T {
    return getDb().transaction(fn)();
  },
};

export type QueryClient = typeof queryClient;
