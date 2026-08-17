// ─────────────────────────────────────────────────────────────
// api/submit-lead-zerobounce.js — Vercel Serverless Function
// Se llama al hacer submit final del paso 2 (datos de empresa) en
// agendar-demo.html. El email ya se validó al hacer click en "Siguiente"
// (ver api/save-partial-contact.js), pero se vuelve a validar aquí también
// por si el usuario volvió con "Atrás" y cambió el email — nunca confiar en
// que el estado del cliente no cambió entre pasos.
//
// Reenvía el lead completo a HubSpot vía la Forms Submission API
// (server-to-server, no depende de qué editor de forms se usó para armar
// el form en HubSpot).
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

const { validateEmail } = require('../lib/zerobounce');

const PORTAL_ID = '49648061';
const FORM_ID = '9567b32e-4ba1-4a1f-acf1-48952510f6fc'; // Agendar-Demo (producción)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const payload = req.body || {};
  const {
    firstname, lastname, email, phone,
    companyName, companyDomain, monthlyPayments,
    pageUri, pageName, hutk,
  } = payload;
  if (!email) return res.status(400).json({ error: 'missing_email' });

  const zb = await validateEmail(email);
  if (!zb.ok) {
    return res.status(zb.httpStatus || 502).json({ error: zb.error, detail: zb.detail, zbHttpStatus: zb.zbHttpStatus });
  }
  if (!zb.accepted) {
    return res.status(200).json({ ok: false, reason: 'invalid_email', zbStatus: zb.zbStatus, zbSubStatus: zb.zbSubStatus });
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

  return res.status(200).json({ ok: true, zbStatus: zb.zbStatus });
};
