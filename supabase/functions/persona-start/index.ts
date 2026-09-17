

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, json } from '../_shared/notify.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const apiKey = Deno.env.get('PERSONA_API_KEY');
  const templateId = Deno.env.get('PERSONA_TEMPLATE_ID');
  if (!apiKey || !templateId) return json({ error: 'age verification not configured' }, 500);

  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'not authenticated' }, 401);

  
  const create = await fetch('https://api.withpersona.com/api/v1/inquiries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Persona-Version': '2023-01-05' },
    body: JSON.stringify({ data: { attributes: { 'inquiry-template-id': templateId, 'reference-id': user.id } } }),
  });
  if (!create.ok) return json({ error: `persona: ${await create.text()}` }, 502);
  const inquiry = await create.json();
  const inquiryId = inquiry?.data?.id;

  
  const link = await fetch(`https://api.withpersona.com/api/v1/inquiries/${inquiryId}/generate-one-time-link`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Persona-Version': '2023-01-05' },
  });
  const linkJson = link.ok ? await link.json() : null;
  const url = linkJson?.meta?.['one-time-link'] || linkJson?.data?.attributes?.['one-time-link'] || null;

  return json({ inquiry_id: inquiryId, url });
});
