import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';


const MAX_LINES = 500;

function fixedDiagnosticsDir(): string | null {
  if (process.platform !== 'win32') return null;
  const base = process.env.PROGRAMDATA || 'C:\\ProgramData';
  return path.join(base, 'Rackd');
}

function appendCapped(filePath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let existing = '';
    try { existing = fs.readFileSync(filePath, 'utf8'); } catch {  }
    const lines = existing ? existing.split('\n').filter(Boolean) : [];
    lines.push(line);
    const trimmed = lines.slice(-MAX_LINES);
    fs.writeFileSync(filePath, trimmed.join('\n') + '\n', 'utf8');
  } catch {  }
}


export function logBoot(db: Database.Database): void {
  try {
    const readSetting = (key: string): string | null => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };

    const licenseCacheRaw = readSetting('license_cache');
    let tenantId: string | null = null;
    let licenseActive: boolean | null = null;
    if (licenseCacheRaw) {
      try {
        const parsed = JSON.parse(licenseCacheRaw) as { tenant_id?: string; active?: boolean };
        tenantId = parsed.tenant_id ?? null;
        licenseActive = parsed.active ?? null;
      } catch {  }
    }
    const machineId = readSetting('machine_id');
    const version = app.getVersion();
    const lastSeenVersion = readSetting('boot_last_seen_version');
    const justUpdated = lastSeenVersion !== null && lastSeenVersion !== version;
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('boot_last_seen_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(version);

    const entry = JSON.stringify({
      at: new Date().toISOString(),
      version,
      justUpdated,
      previousVersion: lastSeenVersion,
      userDataPath: app.getPath('userData'),
      appName: app.getName(),
      hasLicenseCache: !!licenseCacheRaw,
      licenseActive,
      tenantId,
      machineId,
      osUser: os.userInfo().username,
      hostname: os.hostname(),
    });

    appendCapped(path.join(app.getPath('userData'), 'boot-log.txt'), entry);
    const fixedDir = fixedDiagnosticsDir();
    if (fixedDir) appendCapped(path.join(fixedDir, 'boot-log.txt'), entry);
  } catch {  }
}
