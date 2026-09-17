import { DateTime } from 'luxon';
import { getDb } from './db/schema';
import { getBusinessTZ, todayCT } from './utils/time';
import { runAutomaticZReport } from './ipc/xzout';
import { isDayOpen, openDayAutomatic } from './daySession';


const POLL_MS = 60_000;
const KEY_LAST_RUN_DATE = 'batch_last_run_date';

let timer: ReturnType<typeof setInterval> | null = null;

function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function writeSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

async function tick(): Promise<void> {
  try {
    const batchTime = (readSetting('batch_time') || '').trim(); 
    if (!/^\d{2}:\d{2}$/.test(batchTime)) return; 

    const now = DateTime.now().setZone(getBusinessTZ());
    const [h, m] = batchTime.split(':').map(Number);
    
    
    
    
    
    if (now.hour !== h || now.minute !== m) return;

    const today = todayCT();
    if (readSetting(KEY_LAST_RUN_DATE) === today) return; 

    writeSetting(KEY_LAST_RUN_DATE, today); 
    const res = await runAutomaticZReport();
    if (!res.success) console.error('[batch] automatic Z report failed:', res.error);

    
    
    
    
    
    
    
    const db = getDb();
    if (!isDayOpen(db)) openDayAutomatic(db);
  } catch (e) {
    console.error('[batch] scheduler tick failed:', e);
  }
}

export function startBatchScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_MS);
  void tick(); 
}

export function stopBatchScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
