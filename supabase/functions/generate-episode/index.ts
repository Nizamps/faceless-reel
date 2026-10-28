import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function outputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === 'string') return data.output_text;
  const steps = Array.isArray(data.steps) ? data.steps : [];
  return steps.filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => Array.isArray(step.content) ? step.content : [])
    .filter((item: any) => item?.type === 'text')
    .map((item: any) => item.text || '').join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  const auth = req.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!auth || !supabaseUrl || !supabaseKey) return response({ error: 'Supabase function configuration is incomplete.' }, 503);
  if (!geminiKey) return response({ error: 'Add a replacement Gemini API key to Supabase Function Secrets.' }, 503);

  const supabase = createClient(supabaseUrl, supabaseKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return response({ error: 'Please sign in again to create an episode.' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return response({ error: 'Invalid request body.' }, 400); }
  const topic = String(body.topic || '').trim().slice(0, 400);
  if (!topic) return response({ error: 'Add a topic first.' }, 400);
  const settings = body.settings || {};
  const duration = Math.max(50, Math.min(59, Number(settings.duration) || 50));
  const aspect = ['9:16', '16:9', '1:1', '4:5'].includes(settings.aspect) ? settings.aspect : '9:16';
  const prompt = `Write a concise faceless history short for the topic: ${topic}. Target ${duration} seconds, aspect ratio ${aspect}. Use ${String(settings.language || 'English')} and a ${String(settings.voice || 'warm documentary')} narration. The visual style is ${String(settings.art || 'cinematic archival illustration')}. Return only valid JSON with keys: title, hook, narration, scenes, description, tags, thumbnailPrompt. scenes must be 6 objects with time (start-end mm:ss), visual (concrete image direction composed for ${aspect}), and caption (short subtitle). Make the narration approximately 105–125 words, lively, chronological, factual, and free of invented quotations. Use Google Search to verify key historical claims and include sources as a JSON array of {title,url} in a sources key.`;

  try {
    const generated = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify({ model: 'gemini-3.8-flash', input: prompt, tools: [{ type: 'google_search' }], store: false }),
    });
    const result = await generated.json();
    if (!generated.ok) return response({ error: result.error?.message || 'Gemini could not generate this draft.' }, 502);
    let text = outputText(result).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const first = text.indexOf('{'); const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
    let episode: any;
    try { episode = JSON.parse(text); } catch { return response({ error: 'Gemini returned an unreadable draft. Please retry.' }, 502); }
    if (!episode.title || !episode.narration || !Array.isArray(episode.scenes)) return response({ error: 'Gemini returned an incomplete draft. Please retry.' }, 502);

    const { data: saved, error: saveError } = await supabase.from('episodes').insert({
      user_id: userData.user.id,
      run_type: 'manual',
      topic,
      title: episode.title,
      status: 'draft',
      progress: 100,
      progress_message: 'Script package ready',
      script: episode,
      sources: Array.isArray(episode.sources) ? episode.sources : [],
      duration_seconds: duration,
      aspect_ratio: aspect,
      resolution: '4k',
    }).select('*').single();
    if (saveError) return response({ error: `Draft was generated but could not be saved: ${saveError.message}` }, 500);
    return response({ episode: { ...episode, ...saved, episode: undefined, topic, createdAt: saved.created_at } });
  } catch {
    return response({ error: 'Could not reach Gemini. Check the Supabase function logs and try again.' }, 502);
  }
});
