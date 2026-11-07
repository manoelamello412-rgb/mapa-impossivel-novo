'use strict';

/* Vercel Function — contagem baseada nas transacoes efetivamente criadas no Althea.
 * Nao emula PIX, nao chama gateway, nao cria nem altera transacoes.
 * Mantenha SUPABASE_SERVICE_ROLE_KEY APENAS em variaveis do servidor Vercel.
 */
const FUNNEL_ID = process.env.AVAILABILITY_FUNNEL_ID || 'funnel_mapa-do-imposs-vel_cd2e28cecffc40a398b37528d2726f3b';
const TOTAL = 100;
const ONE_MINUTE = 60_000;

function json(res, code, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(code).json(payload);
}

function config() {
  const rawUrl = process.env.SUPABASE_URL || process.env.ALTHEA_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const since = process.env.AVAILABILITY_START_AT;
  if (!rawUrl || !/^https:\/\/[^/]+\.supabase\.co\/?$/.test(rawUrl) || !key || !since || !Number.isFinite(Date.parse(since))) return null;
  return { url: rawUrl.replace(/\/$/, ''), key, since: new Date(since).toISOString() };
}

async function query(cfg, table, query, method = 'GET', body = null, extraHeaders = {}) {
  const url = new URL(cfg.url + '/rest/v1/' + table);
  for (const [key, val] of Object.entries(query || {})) url.searchParams.set(key, String(val));
  const response = await fetch(url, {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  return response;
}

function maskName(input) {
  if (typeof input !== 'string') return 'Uma pessoa';
  const words = input.normalize('NFKC').replace(/[^\p{L}\p{M}\s'-]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Uma pessoa';
  const first = words[0].slice(0, 16);
  const last = words.length > 1 ? ' ' + words.at(-1).slice(0, 1).toUpperCase() + '***' : '';
  return first + last;
}

function sameOrigin(req) {
  try {
    const origin = new URL(String(req.headers.origin || ''));
    const host = String(req.headers.host || '').toLowerCase();
    return (origin.protocol === 'https:' || (origin.protocol === 'http:' && host.startsWith('localhost')))
      && origin.host.toLowerCase() === host;
  } catch { return false; }
}

function cleanActivity(row, action) {
  const alias = action === 'paid' ? maskName(row.display_alias || '') : String(row.display_alias || 'Uma pessoa');
  const message = action === 'paid'
    ? alias + ' teve o PIX confirmado e vai conhecer a Página 2.'
    : action === 'pix' ? 'Um visitante gerou o PIX para a Página 2.'
    : alias + ' está decidindo avançar para a Página 2.';
  return { id: String(row.id), at: row.updated_at || row.created_at, visitor_id: action === 'paid' ? null : String(row.visitor_id || ''), message };
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  const cfg = config();
  if (!cfg) return json(res, 503, { ok: false, error: 'availability_not_configured' });
  try {
    const q = new URL(req.url, 'https://placeholder.invalid').searchParams;
    if (req.method === 'GET') {
      if (q.get('funnel_id') !== FUNNEL_ID) return json(res, 400, { ok: false, error: 'invalid_funnel' });

      // Registros idempotentes de PIX reais, validados no servidor pelo Althea.
      // Nao inclui tentativa de checkout, boleto ou QR bloqueado/ausente.
      const countResponse = await query(cfg, 'funnel_pix_issued', {
        select: 'transaction_id',
        funnel_id: 'eq.' + FUNNEL_ID,
        created_at: 'gte.' + cfg.since,
      }, 'HEAD', null, { Prefer: 'count=exact' });
      if (!countResponse.ok) return json(res, 503, { ok: false, error: 'checkout_count_unavailable' });
      const range = countResponse.headers.get('content-range') || '';
      const matches = range.match(/\/(\d+)$/);
      if (!matches) return json(res, 503, { ok: false, error: 'checkout_count_missing' });
      const count = Number(matches[1]);
      if (!Number.isSafeInteger(count) || count < 0) return json(res, 503, { ok: false, error: 'checkout_count_invalid' });
      const remaining = TOTAL - (count % TOTAL); // 100, 99 ... 1; ao atingir 0, reinicia em 100.

      const from = new Date(Date.now() - 2 * ONE_MINUTE).toISOString();
      const [activityRes, paidRes, issuedRes, approvedCountRes, presenceRes] = await Promise.all([
        query(cfg, 'funnel_live_activity', {
          select: 'id,created_at,visitor_id,display_alias,action',
          funnel_id: 'eq.' + FUNNEL_ID,
          created_at: 'gte.' + from,
          order: 'created_at.desc',
          limit: '5',
        }),
        query(cfg, 'gateway_transactions', {
          select: 'id,updated_at,customer',
          funnel_id: 'eq.' + FUNNEL_ID,
          status: 'eq.approved',
          'metadata->>payment_method': 'eq.pix',
          updated_at: 'gte.' + from,
          order: 'updated_at.desc',
          limit: '5',
        }),
        query(cfg, 'funnel_pix_issued', {
          select: 'transaction_id,created_at',
          funnel_id: 'eq.' + FUNNEL_ID,
          created_at: 'gte.' + from,
          order: 'created_at.desc',
          limit: '5',
        }),
        query(cfg, 'gateway_transactions', {
          select: 'id', funnel_id: 'eq.' + FUNNEL_ID, status: 'eq.approved',
          'metadata->>payment_method': 'eq.pix', created_at: 'gte.' + cfg.since,
        }, 'HEAD', null, { Prefer: 'count=exact' }),
        query(cfg, 'funnel_live_activity', {
          select: 'id', funnel_id: 'eq.' + FUNNEL_ID,
          last_seen_at: 'gte.' + new Date(Date.now() - ONE_MINUTE).toISOString(),
        }, 'HEAD', null, { Prefer: 'count=exact' }),
      ]);
      const activity = activityRes.ok ? await activityRes.json() : [];
      const paid = paidRes.ok ? await paidRes.json() : [];
      const issued = issuedRes.ok ? await issuedRes.json() : [];
      const headerCount = response => { const m=(response.ok?response.headers.get('content-range')||'':'').match(/\/(\d+)$/);return m?Number(m[1]):null; };
      const approvedCount=headerCount(approvedCountRes), presence=headerCount(presenceRes);
      const events = [
        ...(Array.isArray(activity) ? activity.filter(e => e.action === 'deciding').map(e => cleanActivity(e, 'deciding')) : []),
        ...(Array.isArray(paid) ? paid.map(e => cleanActivity({ ...e, display_alias: e.customer?.name || '' }, 'paid')) : []),
        ...(Array.isArray(issued) ? issued.map(e => cleanActivity({id:e.transaction_id,created_at:e.created_at}, 'pix')) : []),
      ].filter(e => typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);

      return json(res, 200, { ok: true, total: TOTAL, restantes: remaining, pix_gerados_no_periodo: count, pagamentos_confirmados_no_periodo: approvedCount, visitantes_na_etapa: presence, ciclo: Math.floor(count / TOTAL) + 1, events });
    }

    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'invalid_origin' });
    const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.funnel_id !== FUNNEL_ID) {
      return json(res, 400, { ok: false, error: 'invalid_body' });
    }

    if (parsed.action === 'pix_issued') {
      const transactionId = String(parsed.transaction_id || '');
      const checkoutId = String(parsed.checkout_session_id || '');
      const idempotencyKey = String(parsed.idempotency_key || '');
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuid.test(transactionId) || !uuid.test(checkoutId) || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
        return json(res, 400, { ok: false, error: 'invalid_payment_reference' });
      }
      // A vinculacao precisa pertencer exatamente ao funil e a sessao citados.
      const lookup = await query(cfg, 'gateway_transactions', {
        select: 'id,metadata,status,external_id',
        id: 'eq.' + transactionId,
        funnel_id: 'eq.' + FUNNEL_ID,
        limit: '1',
      });
      if (!lookup.ok) return json(res, 503, { ok: false, error: 'transaction_lookup_unavailable' });
      const rows = await lookup.json();
      const tx = Array.isArray(rows) ? rows[0] : null;
      if (!tx || tx.metadata?.checkout_session_id !== checkoutId || tx.metadata?.payment_method !== 'pix' || !tx.external_id) {
        return json(res, 403, { ok: false, error: 'transaction_not_verified' });
      }
      // Confere o codigo PIX no endpoint publicamente previsto pelo Althea.
      // Este endpoint e de consulta, nunca cria uma segunda cobranca.
      let verified = tx.status === 'approved';
      if (!verified) {
        const response = await fetch('https://altheapay.com.br/api/payments/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ transaction_id: transactionId, checkout_session_id: checkoutId, idempotency_key: idempotencyKey }),
          cache: 'no-store', signal: AbortSignal.timeout(9500),
        });
        if (!response.ok) return json(res, 503, { ok: false, error: 'pix_verification_unavailable' });
        const actionResult = await response.json();
        verified = !!actionResult?.action?.copy_paste && typeof actionResult.action.copy_paste === 'string';
      }
      if (!verified) return json(res, 422, { ok: false, error: 'pix_code_not_verified' });
      const record = await query(cfg, 'funnel_pix_issued', { on_conflict: 'transaction_id' }, 'POST', [{
        transaction_id: transactionId,
        funnel_id: FUNNEL_ID,
      }], { Prefer: 'resolution=ignore-duplicates,return=minimal' });
      if (!record.ok) return json(res, 503, { ok: false, error: 'pix_registration_unavailable' });
      return json(res, 202, { ok: true, verified: true });
    }

    // Entrada na penultima tela: um evento verdadeiro, uma vez por pessoa/dia.
    if (parsed.action !== 'deciding') return json(res, 400, { ok: false, error: 'invalid_action' });
    const visitorId = String(parsed.visitor_id || '');
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(visitorId)) return json(res, 400, { ok: false, error: 'invalid_activity' });
    const resp = await query(cfg, 'funnel_live_activity', { on_conflict: 'funnel_id,visitor_id,action,day_key' }, 'POST', [{
      funnel_id: FUNNEL_ID,
      visitor_id: visitorId,
      display_alias: maskName(parsed.name),
      action: 'deciding',
      last_seen_at: new Date().toISOString(),
    }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (!resp.ok) return json(res, 503, { ok: false, error: 'activity_unavailable' });
    return json(res, 202, { ok: true });
  } catch (error) {
    console.error('[FUNNEL-AVAILABILITY]', error?.name || 'error');
    return json(res, 503, { ok: false, error: 'availability_unavailable' });
  }
};
