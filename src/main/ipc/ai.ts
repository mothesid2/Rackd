import { ipcMain } from 'electron';
import { getAnthropic } from '../ai/client';
import { RACKD_SYSTEM_PROMPT_FULL } from '../ai/advancedSystemPrompt';
import { getCurrentSession } from './auth';

// Default to the most capable model per the Claude API guidance. These analysis
// tasks (dead-stock, per-employee anomalies, reorder narratives) benefit from it.
const MODEL = 'claude-opus-4-8';

export function registerAIHandlers(): void {
  // Is an Anthropic key configured on this register?
  ipcMain.handle('ai:isConfigured', () => ({ success: true, configured: !!getAnthropic() }));

  // Generic Rackd AI call. `task` names the feature (e.g. "dead_stock_report",
  // "employee_report"); `context` is the live store data the model reasons over.
  // The full Rackd system prompt (v1 core + v2 advanced) governs behavior and the
  // JSON output shape. Streamed so large inputs/outputs don't hit HTTP timeouts.
  ipcMain.handle('ai:complete', async (_e, task: string, context: unknown) => {
    const client = getAnthropic();
    if (!client) {
      return { success: false, error: 'AI is not configured on this register (set ANTHROPIC_API_KEY).' };
    }

    // The prompt enforces roles internally, but gate the paid call to managers so
    // a cashier session can't run (or bill) arbitrary AI analysis.
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

      // Only the visible answer text — thinking blocks are ignored.
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();

      // The prompt returns JSON by default; surface a parsed object when possible.
      let data: unknown = null;
      try { data = JSON.parse(text); } catch { /* not JSON — caller uses `text` */ }

      return { success: true, text, data, model: msg.model, usage: msg.usage };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
