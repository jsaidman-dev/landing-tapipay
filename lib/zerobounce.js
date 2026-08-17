// ─────────────────────────────────────────────────────────────
// lib/zerobounce.js — helper compartido por api/save-partial-contact.js
// y api/submit-lead-zerobounce.js. NO es una ruta (no vive en /api), asi
// que Vercel no la expone como endpoint.
// ─────────────────────────────────────────────────────────────

// Mismo criterio que las checkboxes configuradas en ZeroBounce > Integrations > HubSpot Forms
const ACCEPTED_STATUSES = ['valid', 'catch-all', 'unknown'];

// Todos los status reales que puede devolver ZeroBounce (aceptados + rechazados). Si la
// respuesta no trae uno de estos strings, NO es una validación real (puede ser un bloqueo
// del WAF devolviendo JSON tipo {"status":403,...}) — nunca tratarlo como email inválido.
const KNOWN_ZB_STATUSES = ['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail'];

// Devuelve { ok, accepted, zbStatus, zbSubStatus } si pudo validar, o { ok: false, error, ... }
// si falló la llamada en sí (red, WAF, key inválida, respuesta inesperada).
async function validateEmail(email) {
  const zbKey = process.env.ZEROBOUNCE_API_KEY;
  if (!zbKey) return { ok: false, httpStatus: 500, error: 'ZEROBOUNCE_API_KEY not set' };

  let zb;
  try {
    const zbRes = await fetch(
      `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(zbKey)}&email=${encodeURIComponent(email)}`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; TapipayLandingBot/1.0; +https://tapipay.la)',
        },
      }
    );
    const rawBody = await zbRes.text();
    try {
      zb = JSON.parse(rawBody);
    } catch {
      return { ok: false, httpStatus: 502, error: 'zerobounce_non_json_response', zbHttpStatus: zbRes.status, detail: rawBody.substring(0, 300) };
    }
  } catch (err) {
    return { ok: false, httpStatus: 502, error: 'zerobounce_unreachable', detail: String((err && err.message) || err) };
  }

  if (zb.error) {
    return { ok: false, httpStatus: 502, error: 'zerobounce_error', detail: zb.error };
  }

  if (!KNOWN_ZB_STATUSES.includes(zb.status)) {
    return { ok: false, httpStatus: 502, error: 'zerobounce_unexpected_response', detail: JSON.stringify(zb).substring(0, 300) };
  }

  return {
    ok: true,
    accepted: ACCEPTED_STATUSES.includes(zb.status),
    zbStatus: zb.status,
    zbSubStatus: zb.sub_status,
  };
}

module.exports = { validateEmail };
