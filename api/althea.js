'use strict';

const UPSTREAM_ORIGIN = 'https://altheapay.com.br';
const ALLOWED_PATHS = new Set([
  '/api/checkout/public',
  '/api/payments/create',
  '/api/payments/action',
]);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED' });
  }

  let url;
  try { url = new URL(req.url, 'https://placeholder.invalid'); }
  catch { return res.status(400).json({ ok: false, code: 'INVALID_URL' }); }

  const path = url.searchParams.get('path') || '';
  if (!ALLOWED_PATHS.has(path) || (req.method === 'POST' && path !== '/api/checkout/public' && path !== '/api/payments/create' && path !== '/api/payments/action') || (req.method === 'GET' && path !== '/api/checkout/public')) {
    return res.status(404).json({ ok: false, code: 'UNSUPPORTED_API_PATH' });
  }

  const target = new URL(path, UPSTREAM_ORIGIN);
  for (const [key, value] of url.searchParams) {
    if (key !== 'path') target.searchParams.append(key, value);
  }

  let payload;
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      else if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
      payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > 65536) return res.status(413).json({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
    } catch { return res.status(400).json({ ok: false, code: 'INVALID_JSON' }); }
  }

  try {
    const response = await fetch(target, {
      method: req.method,
      headers: {
        'Accept': 'application/json',
        ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(req.method === 'POST' ? { body: payload } : {}),
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 1048576) return res.status(502).json({ ok: false, code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type')?.includes('application/json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    return res.send(text);
  } catch {
    return res.status(502).json({ ok: false, code: 'ALTHEA_UPSTREAM_UNAVAILABLE' });
  }
};
