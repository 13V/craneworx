// Craneworx enquiry endpoint. Both website forms post JSON here, and each
// enquiry is emailed to the yard through Resend.
//
// Vercel → craneworx → Settings → Environment Variables (never in this repo):
//   RESEND_API_KEY   Resend API key (sending access is enough)
//   LEAD_EMAIL_FROM  verified sender, e.g. "Craneworx website <enquiries@your-domain>"
//   LEAD_EMAIL_TO    where enquiries go, comma-separated
//   LEAD_EMAIL_CC    optional copy, comma-separated
// The visitor only sees "sent" when Resend accepted the email.

"use strict";

const HOSTS = ["craneworx.vercel.app", "craneworx.net.au", "www.craneworx.net.au", "localhost", "127.0.0.1"];
const LIMITS = { name: 120, phone: 40, email: 254, service: 60, lift: 120, weight: 40, where: 200, access: 60, message: 3000, page: 500 };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = typeof req.body === "string" ? req.body : "";
  if (!raw) for await (const chunk of req) { raw += chunk; if (raw.length > 50000) throw new Error("too large"); }
  return raw ? JSON.parse(raw) : {};
}

function fromOurSite(req) {
  try {
    const host = new URL(req.headers.origin || "").hostname;
    return HOSTS.includes(host) || /^craneworx-[a-z0-9-]+\.vercel\.app$/.test(host);
  } catch { return false; }
}

const list = v => (v || "").split(",").map(s => s.trim()).filter(Boolean);
const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "method" }); }
  if (!fromOurSite(req)) return send(res, 403, { ok: false, error: "origin" });
  let input;
  try { input = await readBody(req); } catch { return send(res, 400, { ok: false, error: "body" }); }
  if (input.company) return send(res, 200, { ok: true }); // honeypot: bots fill the hidden field

  const lead = {};
  for (const [k, max] of Object.entries(LIMITS)) lead[k] = typeof input[k] === "string" ? input[k].trim().slice(0, max) : "";
  if (!lead.name) return send(res, 422, { ok: false, error: "name" });
  if (!/^[+\d\s().-]{6,}$/.test(lead.phone) || lead.phone.replace(/\D/g, "").length < 8) return send(res, 422, { ok: false, error: "phone" });
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) lead.email = "";

  const key = process.env.RESEND_API_KEY, from = process.env.LEAD_EMAIL_FROM, to = list(process.env.LEAD_EMAIL_TO);
  if (!key || !from || !to.length) return send(res, 503, { ok: false, error: "not_configured" });

  const rows = [["Name", lead.name], ["Phone", lead.phone], ["Email", lead.email], ["Service", lead.service], ["Lift", lead.lift],
    ["Rough weight", lead.weight], ["Going to", lead.where], ["Access", lead.access], ["Notes", lead.message], ["Sent from", lead.page]].filter(r => r[1]);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nReply to this email or call them back on " + lead.phone + ".";
  const html = `<div style="font:15px/1.5 Arial,sans-serif;color:#111"><p style="margin:0 0 12px"><b>New website enquiry</b></p><table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;white-space:pre-line">${esc(v)}</td></tr>`).join("")}</table><p style="margin:16px 0 0"><a href="tel:${esc(lead.phone.replace(/[^\d+]/g, ""))}">Call ${esc(lead.name)} back</a></p></div>`;
  const subject = `Website enquiry: ${lead.lift || lead.service || "crane hire"}, ${lead.name}`;

  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, cc: list(process.env.LEAD_EMAIL_CC), reply_to: lead.email || undefined, subject, text, html })
    });
    clearTimeout(timer);
    if (!r.ok) { console.error("resend", r.status, (await r.text()).slice(0, 300)); return send(res, 502, { ok: false, error: "send" }); }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error("resend", e.message);
    return send(res, 502, { ok: false, error: "send" });
  }
};
