

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


interface SyncApi {
  syncTrigger(): Promise<{ success: boolean; status?: SyncStatus; error?: string }>;
  syncStatus(): Promise<{ success: boolean; status?: SyncStatus; error?: string }>;
  syncDeadLetters(): Promise<{ success: boolean; rows?: DeadLetter[]; error?: string }>;
  syncRetryDeadLetter(id: number): Promise<{ success: boolean; retried?: number; error?: string }>;
  syncClearDeadLetter(id: number): Promise<{ success: boolean; cleared?: number; error?: string }>;
}
const api = (window as unknown as { api: SyncApi }).api;

export const sync = {
  
  trigger: () => api.syncTrigger(),
  
  status: () => api.syncStatus(),
  
  deadLetters: () => api.syncDeadLetters(),
  
  retryDeadLetter: (id: number) => api.syncRetryDeadLetter(id),
  
  clearDeadLetter: (id: number) => api.syncClearDeadLetter(id),
};
