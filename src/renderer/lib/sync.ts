/**
 * Renderer-side sync wrappers. These talk to the main process ONLY through the
 * contextBridge `window.api` surface (see src/main/preload.ts) — never import
 * main-process code from here.
 *
 * NOTE: targets the (forthcoming) Vite/React renderer; the current renderer is
 * vanilla HTML, so this is scaffolding that compiles against window.api.
 */

export interface SyncStatus {
  online: boolean;
  is_online: boolean;
  last_sync_attempted_at: string | null;
  last_sync_succeeded_at: string | null;
  last_sync_error: string | null;
  pending_sync_count: number;
  dead_letter_count: number;
}

export interface DeadLetter {
  id: number;
  table_name: string;
  record_id: string;
  operation: 'insert' | 'update' | 'delete';
  payload: string;
  attempts: number;
  last_attempted_at: string | null;
  error_message: string | null;
  created_at: string;
}

// Minimal view of the preload bridge this module relies on.
interface SyncApi {
  syncTrigger(): Promise<{ success: boolean; status?: SyncStatus; error?: string }>;
  syncStatus(): Promise<{ success: boolean; status?: SyncStatus; error?: string }>;
  syncDeadLetters(): Promise<{ success: boolean; rows?: DeadLetter[]; error?: string }>;
  syncRetryDeadLetter(id: number): Promise<{ success: boolean; retried?: number; error?: string }>;
  syncClearDeadLetter(id: number): Promise<{ success: boolean; cleared?: number; error?: string }>;
}
const api = (window as unknown as { api: SyncApi }).api;

export const sync = {
  /** Manually run a sync cycle now. */
  trigger: () => api.syncTrigger(),
  /** Current sync health stats. */
  status: () => api.syncStatus(),
  /** All dead-letter records for admin review. */
  deadLetters: () => api.syncDeadLetters(),
  /** Retry a specific dead-letter by id. */
  retryDeadLetter: (id: number) => api.syncRetryDeadLetter(id),
  /** Permanently abandon a dead-letter by id. */
  clearDeadLetter: (id: number) => api.syncClearDeadLetter(id),
};
