// Cloudflare Pages Function — POST /api/id-scan
// Reads an Israeli ID card photo with Claude vision and returns the personal details.
// The image is processed in memory only: it is never stored or logged.
//
// Setup (once): Cloudflare dashboard → Pages project → Settings → Variables and Secrets →
//   add secret  ANTHROPIC_API_KEY  (production).
// Callers must be logged in to the CRM (a valid Supabase session token is required),
// so the API key can't be used by strangers.

const SB_URL = 'https://pfimmngjgkgzjjhemjdy.supabase.co';
const SB_KEY = 'sb_publishable_iOafusxiYK5ZBPqEb3IwOQ_jijlKgvO';
const MODEL = 'claude-sonnet-5-5';
const MAX_IMAGES = 3;
const MAX_BODY = 12 * 1024 * 1024;

const PROMPT = `זו תמונה (או כמה תמונות: חזית ואחור) של תעודת זהות ישראלית.
חלץ את הפרטים והחזר JSON בלבד, בלי הסבר ובלי גדרות קוד, בדיוק במבנה:
{"firstName":"","familyName":"","idNumber":"","dob":"","issueDate":""}
כללים:
- firstName = שם פרטי, familyName = שם משפחה, בעברית כפי שכתוב בתעודה.
- idNumber = 9 ספרות בלבד (השלם אפסים מובילים אם חסר).
- dob = תאריך לידה, issueDate = תאריך הנפקה, שניהם בפורמט YYYY-MM-DD.
- שדה שלא מופיע בבירור בתמונה: מחרוזת ריקה. אל תנחש.`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key', message: 'חסר מפתח ANTHROPIC_API_KEY ב-Cloudflare (Settings → Variables and Secrets).' }, 500);

  // Same-origin only
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'forbidden' }, 403);

  // Must be a logged-in CRM user
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized', message: 'צריך להיות מחובר ל-CRM.' }, 401);
  try {
    const u = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: auth } });
    if (!u.ok) return json({ error: 'unauthorized', message: 'ההתחברות פגה — התחבר מחדש.' }, 401);
  } catch (e) { return json({ error: 'auth_check_failed' }, 502); }

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ error: 'too_large', message: 'התמונה גדולה מדי.' }, 413);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES);
  if (!images.length) return json({ error: 'no_images' }, 400);

  const content = [];
  for (const img of images) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(img || ''));
    if (!m) return json({ error: 'bad_image' }, 400);
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: PROMPT });

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content }] })
    });
  } catch (e) { return json({ error: 'upstream_unreachable' }, 502); }
  if (!resp.ok) return json({ error: 'upstream_error', status: resp.status }, 502);

  const data = await resp.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const mm = /\{[\s\S]*\}/.exec(text);
  let parsed = {};
  try { parsed = mm ? JSON.parse(mm[0]) : {}; } catch (e) { return json({ error: 'unreadable', message: 'לא הצלחתי לקרוא את התמונה.' }, 422); }

  const clean = (v) => String(v == null ? '' : v).trim();
  const date = (v) => { v = clean(v); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; };
  const id = clean(parsed.idNumber).replace(/\D/g, '');
  return json({
    firstName: clean(parsed.firstName),
    familyName: clean(parsed.familyName),
    idNumber: id ? id.padStart(9, '0').slice(-9) : '',
    dob: date(parsed.dob),
    issueDate: date(parsed.issueDate)
  });
}
