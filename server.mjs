import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { configured: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' });
  }
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    if (!process.env.GEMINI_API_KEY) return send(res, 503, { error: 'Add a replacement Gemini API key to the local .env file, then restart the app.' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 20000) return send(res, 413, { error: 'Request is too large.' });
    }
    let data;
    try { data = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const topic = String(data.topic || '').trim().slice(0, 500);
    if (!topic) return send(res, 400, { error: 'Add an episode topic first.' });
    const settings = data.settings || {};
    const duration = Math.max(50, Math.min(59, Number(settings.duration) || 50));
    const aspect = ['9:16', '16:9', '1:1', '4:5'].includes(settings.aspect) ? settings.aspect : '9:16';
    const prompt = `Create a production-ready faceless video episode package for a personal history channel. Return only valid JSON (no markdown) with keys: title (string), hook (string), narration (string), scenes (array of objects with time (short range like 0:00–0:07), visual (specific visual direction), caption (short on-screen caption)), description (string), tags (array of short strings), thumbnailPrompt (string). Topic: ${topic}. Target duration: ${duration} seconds. Aspect ratio: ${aspect}. Make each scene composition work for this aspect ratio, keeping important subjects and caption-safe areas inside frame. Language: ${String(settings.language || 'English').slice(0, 40)}. Narration feel: ${String(settings.voice || 'Warm documentary').slice(0, 60)}. Art direction: ${String(settings.art || 'Cinematic archival illustration').slice(0, 80)}. Write a compelling opening, a clear chronological story, careful factual wording, and a satisfying ending. Aim for narration that can be spoken within the target duration. Do not invent quotations. Include 6 to 8 scenes.`;
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', input: prompt, store: false })
      });
      const result = await response.json();
      if (!response.ok) return send(res, 502, { error: result.error?.message || 'Gemini could not generate this episode.' });
      let text = result.output_text || result.output?.map(item => item.text || item.content?.map(part => part.text || '').join('') || '').join('') || '';
      text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) text = text.slice(start, end + 1);
      let episode;
      try { episode = JSON.parse(text); } catch { return send(res, 502, { error: 'Gemini returned an unreadable draft. Please try again.' }); }
      return send(res, 200, { episode });
    } catch {
      return send(res, 502, { error: 'Could not reach Gemini. Check your connection and try again.' });
    }
  }

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(root, requested);
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    await access(file);
    const body = await readFile(file);
    send(res, 200, body, mime[path.extname(file)] || 'application/octet-stream');
  } catch { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
});

server.listen(port, '127.0.0.1', () => console.log(`Faceless Studio is ready at http://127.0.0.1:${port}`));
