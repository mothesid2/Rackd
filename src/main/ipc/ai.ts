import { ipcMain } from 'electron';
import { getAnthropic } from '../ai/client';
import { RACKD_SYSTEM_PROMPT_FULL } from '../ai/advancedSystemPrompt';
import { getCurrentSession } from './auth';


const MODEL = 'claude-opus-4-8';

export function registerAIHandlers(): void {
  
  ipcMain.handle('ai:isConfigured', () => ({ success: true, configured: !!getAnthropic() }));

  
  
  
  
  ipcMain.handle('ai:complete', async (_e, task: string, context: unknown) => {
    const client = getAnthropic();
    if (!client) {
      return { success: false, error: 'AI is not configured on this register (set ANTHROPIC_API_KEY).' };
    }

    
    
    const session = getCurrentSession();
    if (!session || session.role !== 'manager') {
      return { success: false, error: 'AI features require manager access' };
    }

    try {
      const userContent =
        `Task: ${String(task || 'general')}\n` +
        `Session role: ${session.role}\n\n` +
        `Store context (JSON):\n${JSON.stringify(context ?? {}, null, 2)}`;

      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        system: RACKD_SYSTEM_PROMPT_FULL,
        messages: [{ role: 'user', content: userContent }],
      });
      const msg = await stream.finalMessage();

      
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();

      
      let data: unknown = null;
      try { data = JSON.parse(text); } catch {  }

      return { success: true, text, data, model: msg.model, usage: msg.usage };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
