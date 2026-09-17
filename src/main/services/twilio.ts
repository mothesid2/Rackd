import twilio from 'twilio';
import { getDb } from '../db/schema';

export function getTwilioClient(): twilio.Twilio | null {
  try {
    const db = getDb();
    const sidRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_account_sid'").get() as { value: string } | undefined;
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_auth_token'").get() as { value: string } | undefined;

    const sid = sidRow?.value;
    const token = tokenRow?.value;

    if (!sid || !token) return null;
    return twilio(sid, token);
  } catch {
    return null;
  }
}


