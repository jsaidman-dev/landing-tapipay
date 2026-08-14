// ─────────────────────────────────────────────────────────────
// api/submit-lead-zerobounce.js — Vercel Serverless Function
// Recibe un lead del form propio (sin embed de HubSpot), valida el email
// contra ZeroBounce y, solo si es aceptado, lo reenvía a HubSpot vía la
// Forms Submission API (server-to-server, no depende de qué editor de
// forms se usó para armar el form en HubSpot).
//
// POST body (JSON): { firstname, lastname, email, phone, companyName, companyDomain, monthlyPayments, hutk, pageUri, pageName }
//
// "Agendar-Demo" (producción) requiere, además de email: firstname, lastname,
// phone y 3 propiedades de Company (prefijo 0-2/): name, domain,
// cantidad_de_pagos_mensuales (enum: ver MONTHLY_PAYMENTS_OPTIONS en agendar-demo.html).
//
// Requiere la env var ZEROBOUNCE_API_KEY seteada en Vercel (Project Settings
// > Environment Variables) — usar la Master Key de ZeroBounce (privada, sin
// restricción de dominio, ya que esta llamada es server-to-server).
// ─────────────────────────────────────────────────────────────

const PORTAL_ID = '49648061';
const FORM_ID = '9567b32e-4ba1-4a1f-acf1-48952510f6fc'; // Agendar-Demo (producción)

// Mismo criterio que las checkboxes configuradas en ZeroBounce > Integrations > HubSpot Forms
const ACCEPTED_STATUSES = ['valid', 'catch-all', 'unknown'];
// Todos los status reales que puede devolver ZeroBounce (aceptados + rechazados). Si la
// respuesta no trae uno de estos strings, NO es una validación real (puede ser un bloqueo
// del WAF devolviendo JSON tipo {"status":403,...}) — nunca tratarlo como email inválido.
const KNOWN_ZB_STATUSES = ['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const zbKey = process.env.ZEROBOUNCE_API_KEY;
  if (!zbKey) return res.status(500).json({ error: 'ZEROBOUNCE_API_KEY not set' });

  const payload = req.body || {};
  const {
    firstname, lastname, email, phone,
    companyName, companyDomain, monthlyPayments,
    pageUri, pageName, hutk,
  } = payload;
  if (!email) return res.status(400).json({ error: 'missing_email' });

  let zb;
  try {
    const zbRes = await fetch(
      `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(zbKey)}&email=${encodeURIComponent(email)}`,
      {
        headers: {
          'Accept': 'application/json',
          // Algunos WAFs delante de APIs tratan distinto el tráfico de IPs de datacenter
          // (Vercel) sin un User-Agent reconocible; esto evita que devuelvan una página
          // de challenge en HTML en vez del JSON esperado.
          'User-Agent': 'Mozilla/5.0 (compatible; TapipayLandingBot/1.0; +https://tapipay.la)',
        },
      }
    );
    const rawBody = await zbRes.text();
    try {
      zb = JSON.parse(rawBody);
    } catch {
      return res.status(502).json({
        error: 'zerobounce_non_json_response',
        zbHttpStatus: zbRes.status,
        detail: rawBody.substring(0, 300),
      });
    }
  } catch (err) {
    return res.status(502).json({ error: 'zerobounce_unreachable', detail: String((err && err.message) || err) });
  }

  if (zb.error) {
    return res.status(502).json({ error: 'zerobounce_error', detail: zb.error });
  }

  // zbRes.status !== 200 o un status desconocido (ej. {"status":403,...} de un WAF) NO es
  // una validación real — hay que fallar visiblemente, nunca tratarlo como "email inválido"
  // (eso rechazaría leads válidos en silencio).
  if (!KNOWN_ZB_STATUSES.includes(zb.status)) {
    return res.status(502).json({
      error: 'zerobounce_unexpected_response',
      detail: JSON.stringify(zb).substring(0, 300),
    });
  }

  const accepted = ACCEPTED_STATUSES.includes(zb.status);
  if (!accepted) {
    return res.status(200).json({ ok: false, reason: 'invalid_email', zbStatus: zb.status, zbSubStatus: zb.sub_status });
  }

  const fields = [
    { name: 'email', value: email },
    firstname ? { name: 'firstname', value: firstname } : null,
    lastname ? { name: 'lastname', value: lastname } : null,
    phone ? { name: 'phone', value: phone } : null,
    companyName ? { name: '0-2/name', value: companyName } : null,
    companyDomain ? { name: '0-2/domain', value: companyDomain } : null,
    monthlyPayments ? { name: '0-2/cantidad_de_pagos_mensuales', value: monthlyPayments } : null,
  ].filter(Boolean);

  // ipAddress + hutk (cookie hubspotutk) permiten que HubSpot atribuya el submit a la
  // sesión ya trackeada (GTM/Meta/Google Ads) — sin esto el contacto se crea igual,
  // pero pierde la atribución para el sync de Ads.
  const forwardedFor = req.headers['x-forwarded-for'];
  const ipAddress = (Array.isArray(forwardedFor) ? forwardedFor[0] : (forwardedFor || '').split(',')[0]).trim();

  const context = { pageUri: pageUri || '', pageName: pageName || 'agendar-demo' };
  if (hutk) context.hutk = hutk;
  if (ipAddress) context.ipAddress = ipAddress;

  try {
    const hsRes = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, context }),
      }
    );

    if (!hsRes.ok) {
      const detail = await hsRes.text();
      return res.status(502).json({ ok: false, reason: 'hubspot_submit_failed', detail: detail.substring(0, 500) });
    }
  } catch (err) {
    return res.status(502).json({ error: 'hubspot_unreachable', detail: String((err && err.message) || err) });
  }

  return res.status(200).json({ ok: true, zbStatus: zb.status });
};
