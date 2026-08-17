// ─────────────────────────────────────────────────────────────
// api/save-partial-contact.js — Vercel Serverless Function
// Se llama al hacer click en "Siguiente" (paso 1 -> paso 2) de agendar-demo.html.
// Valida el email con ZeroBounce y, si es aceptado, crea/actualiza (upsert) el
// contacto en HubSpot con los datos que ya tenemos (nombre, apellido, email,
// teléfono) — así el lead queda guardado aunque abandone antes de terminar el
// paso 2 (datos de empresa).
//
// A diferencia de api/submit-lead-zerobounce.js (que usa la Forms Submission
// API pública, sin auth, pero exige TODOS los campos del form real), este
// endpoint escribe directo al objeto Contact vía la CRM API — por eso puede
// guardar un subconjunto de propiedades sin que HubSpot lo rechace por
// "required field missing".
//
// Requiere la env var HUBSPOT_PRIVATE_APP_TOKEN en Vercel: un Private App
// token de HubSpot con el scope crm.objects.contacts.write (Settings >
// Integrations > Private Apps en el portal de HubSpot).
//
// POST body (JSON): { firstname, lastname, email, phone }
// ─────────────────────────────────────────────────────────────

const { validateEmail } = require('../lib/zerobounce');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const hsToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!hsToken) return res.status(500).json({ error: 'HUBSPOT_PRIVATE_APP_TOKEN not set' });

  const payload = req.body || {};
  const { firstname, lastname, email, phone } = payload;
  if (!email) return res.status(400).json({ error: 'missing_email' });

  const zb = await validateEmail(email);
  if (!zb.ok) {
    return res.status(zb.httpStatus || 502).json({ error: zb.error, detail: zb.detail, zbHttpStatus: zb.zbHttpStatus });
  }
  if (!zb.accepted) {
    return res.status(200).json({ ok: false, reason: 'invalid_email', zbStatus: zb.zbStatus, zbSubStatus: zb.zbSubStatus });
  }

  const properties = { email };
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (phone) properties.phone = phone;

  try {
    const upsertRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hsToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: [{ idProperty: 'email', id: email, properties }],
      }),
    });

    if (!upsertRes.ok) {
      const detail = await upsertRes.text();
      return res.status(502).json({ ok: false, reason: 'hubspot_upsert_failed', detail: detail.substring(0, 500) });
    }
  } catch (err) {
    return res.status(502).json({ error: 'hubspot_unreachable', detail: String((err && err.message) || err) });
  }

  return res.status(200).json({ ok: true, zbStatus: zb.zbStatus });
};
