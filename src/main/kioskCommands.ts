import { app } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { getSupabase } from './supabase/client';
import { isDayOpen } from './daySession';
import { getCurrentSession } from './ipc/auth';




const RESET_KEYS = [
  'license_cache', 'license_key', 'auth_token', 'auth_token_exp', 'license_last_check',
  'kiosk_locked_location_id', 'kiosk_setup_complete',
  'day_session_open', 'day_session_opened_at', 'day_session_opened_by_id', 'day_session_opened_by_name',
];

interface CommandRow {
  id: string;
  command: string;
  status: string;
}

export type ResetAction = 'defer' | 'blocked' | 'draining' | 'reset';
export interface ResetDecision { action: ResetAction; note: string | null; status?: string }


export function decideReset(state: {
  dayOpen: boolean;
  hasSession: boolean;
  deadLetters: number;
  pending: number;
}): ResetDecision {
  if (state.dayOpen || state.hasSession) return { action: 'defer', note: 'deferred: waiting for day close-out' };
  if (state.deadLetters > 0) {
    return { action: 'blocked', status: 'blocked', note: `blocked: ${state.deadLetters} unsynced record(s) need attention before reset` };
  }
  if (state.pending > 0) return { action: 'draining', note: `draining outbox (${state.pending} pending)` };
  return { action: 'reset', note: null };
}

function pendingSyncCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0 AND dead_letter = 0').get() as { n: number }).n;
}
function actionableDeadLetters(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0').get() as { n: number }).n;
}

function applyReset(db: Database.Database): void {
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const tx = db.transaction(() => { for (const k of RESET_KEYS) del.run(k); });
  tx();
  console.log('[kiosk-reset] local lock + activation cleared; relaunching into setup.');
  
  try { app.relaunch(); } catch {  }
  app.exit(0);
}


export async function checkAndApplyResets(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database = getDb()
): Promise<void> {
  
  const { data, error } = await supabase
    .from('register_commands')
    .select('id, command, status')
    .eq('command', 'reset')
    .in('status', ['pending', 'acked'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.warn('[kiosk-reset] check failed:', error.message); return; }
  const cmd = (data?.[0] as CommandRow | undefined);
  if (!cmd) return;

  const now = new Date().toISOString();
  
  if (cmd.status === 'pending') {
    await supabase.from('register_commands').update({ status: 'acked', acked_at: now }).eq('id', cmd.id);
  }

  const decision = decideReset({
    dayOpen: isDayOpen(db),
    hasSession: !!getCurrentSession(),
    deadLetters: actionableDeadLetters(db),
    pending: pendingSyncCount(db),
  });

  if (decision.action !== 'reset') {
    
    const patch: Record<string, unknown> = { note: decision.note };
    if (decision.status) patch.status = decision.status;
    await supabase.from('register_commands').update(patch).eq('id', cmd.id);
    return;
  }

  
  await supabase.from('register_commands').update({ status: 'done', note: null, completed_at: new Date().toISOString() }).eq('id', cmd.id);
  applyReset(db);
}
