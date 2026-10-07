// SpeakerConnect — servidor (Cloudflare Worker).
// As páginas vêm da pasta public (binding ASSETS); só os endereços /api/* passam por aqui.
//
// Endereços:
//   GET    /api/mp/config     chave pública para o formulário do cartão (do palestrante, quando é contratação)
//   POST   /api/mp/pagar      paga dentro do app (Pix ou cartão): selo (conta da plataforma) ou contratação
//                             (Split: cai direto na conta Mercado Pago do palestrante, a comissão vai para a plataforma)
//   POST   /api/mp/conectar   palestrante logado: devolve o link para conectar a conta do Mercado Pago (OAuth)
//   GET    /api/mp-oauth/callback  o Mercado Pago devolve o palestrante aqui; guardamos o token cifrado
//   POST   /api/reembolso     equipe logada: devolve um pagamento (selo ou contratação)
//   GET    /api/pagamento     status de um pagamento (o app consulta enquanto mostra o Pix)
//   POST   /api/mp-webhook    aviso do Mercado Pago (assinatura conferida; o pagamento é consultado na API)
//   POST   /api/aviso         aviso vindo do Supabase -> e-mail (cabeçalho x-sc-secret)
//   DELETE /api/conta         a própria pessoa apaga a conta (LGPD)
//
// Variáveis (Settings > Variables and Secrets no Cloudflare):
//   SUPABASE_URL, SUPABASE_ANON_KEY            (texto)
//   SUPABASE_SERVICE_ROLE_KEY                  (Secret)  nunca vai para o navegador
//   MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET         (Secret)  Mercado Pago da plataforma (selo e avisos)
//   MP_PUBLIC_KEY                              (texto)   Public Key de produção da aplicação (formulário do cartão)
//   MP_CLIENT_ID, MP_CLIENT_SECRET             (Secret)  da mesma aplicação, para conectar as contas dos palestrantes (Split)
//   MP_TOKEN_KEY                               (Secret)  senha longa (24+ caracteres) que cifra os tokens dos palestrantes
//   RESEND_API_KEY (Secret), MAIL_FROM, NOTIFY_EMAIL    e-mails
//   NOTIFY_SECRET                              (Secret)  mesma senha gravada no Supabase (private.settings)
//   SITE_URL                                   endereço principal, ex.: https://speakerconnect.com.br
//   COMMISSION_PCT                             comissão da plataforma, ex.: 20
//   VERIFIED_PRICE_CENTS                       preço do selo em centavos, ex.: 19900 = R$ 199,00
//   VERIFIED_DAYS                              validade do selo em dias (365 = anual; 0 = para sempre)
//   ALLOWED_ORIGINS                            endereços aceitos, separados por vírgula

const MP_API = "https://api.mercadopago.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRAND = "SpeakerConnect";

// ---------- utilidades ----------
export function json(status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}
export const brl = (cents) => "R$ " + (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const line = (x, n) => String(x == null ? "" : x).replace(/[\r\n]+/g, " ").slice(0, n);
const first = (n) => line(n, 60).split(" ")[0] || "";

export async function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(given))),
    crypto.subtle.digest("SHA-256", enc.encode(String(expected))),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function siteUrl(env, request) {
  return (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !env.ALLOWED_ORIGINS) return true;
  const ok = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return ok.includes(origin);
}

function configured(env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY);
}

// Chamada ao Supabase com a chave do servidor (ignora as regras do banco: use com cuidado).
export async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`supabase ${method} ${path.split("?")[0]} -> ${r.status} ${String(text).slice(0, 200)}`);
  return data;
}
const one = async (env, path) => { const rows = await sb(env, path); return Array.isArray(rows) ? rows[0] || null : null; };

// Quem está logado? Confere o token do app no próprio Supabase.
async function currentUser(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || token.split(".").length !== 3) return null;
  try {
    const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !UUID.test(u.id || "")) return null;
    const profile = await one(env, `/rest/v1/profiles?id=eq.${u.id}&select=id,role,name,email,phone`);
    return profile ? { id: u.id, email: u.email, profile } : null;
  } catch (e) {
    console.error("login: falha ao conferir:", e && e.message);
    return null;
  }
}

// ---------- e-mails (Resend) ----------
export async function sendMail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM || `${BRAND} <onboarding@resend.dev>`, to: [to], subject, text }),
    });
    if (!r.ok) console.error("e-mail recusado pelo Resend:", r.status);
    return r.ok;
  } catch (e) {
    console.error("falha ao enviar e-mail:", e && e.message);
    return false;
  }
}
function later(ctx, p) { if (ctx && ctx.waitUntil) ctx.waitUntil(p); return p; }
const footer = (env, request) => `\n\nAbrir o ${BRAND}: ${siteUrl(env, request)}/app/\n\nVocê recebe este e-mail porque tem cadastro no ${BRAND}.`;

// ---------- Mercado Pago ----------
export async function mpSignatureValid({ secret, signature, requestId, dataId, now = Date.now() }) {
  if (!secret || !signature || !requestId || !dataId) return false;
  const parts = Object.fromEntries(String(signature).split(",").map((p) => p.trim().split("=", 2)));
  if (!parts.ts || !parts.v1) return false;
  const ts = Number(parts.ts);
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > 10 * 60 * 1000) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`));
  const expected = [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return sameSecret(String(parts.v1), expected);
}

async function fetchPayment(env, id, token) {
  const r = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(String(id))}`, { headers: { Authorization: "Bearer " + (token || env.MP_ACCESS_TOKEN) } });
  if (!r.ok) throw new Error("status " + r.status);
  return r.json();
}

// ---------- Split: contas do Mercado Pago dos palestrantes ----------
const MP_AUTH = "https://auth.mercadopago.com.br/authorization";
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => { let x = ""; for (const c of new Uint8Array(buf)) x += String.fromCharCode(c); return btoa(x); };
const unb64 = (x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
const b64u = (buf) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (x) => unb64(x.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((x.length + 3) % 4));
export function splitReady(env) {
  return !!(env.MP_CLIENT_ID && env.MP_CLIENT_SECRET && env.MP_TOKEN_KEY && String(env.MP_TOKEN_KEY).length >= 24);
}
async function aesKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", te.encode(env.MP_TOKEN_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), te.encode(text));
  return "v1." + b64(iv) + "." + b64(ct);
}
async function unseal(env, x) {
  const [v, iv, ct] = String(x).split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("token cifrado inválido");
  return td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct)));
}
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(data)));
}
// "state" do OAuth: assinado e com validade, para ninguém ligar a própria conta ao perfil de outra pessoa.
export async function makeState(env, userId, now = Date.now()) {
  const body = b64u(te.encode(JSON.stringify({ u: userId, e: now + 15 * 60 * 1000 })));
  return body + "." + b64u(await hmac(env.MP_TOKEN_KEY, "state." + body));
}
async function readState(env, state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  if (!(await sameSecret(sig, b64u(await hmac(env.MP_TOKEN_KEY, "state." + body))))) return null;
  try { const o = JSON.parse(td.decode(unb64u(body))); return o.e > Date.now() && UUID.test(o.u) ? o.u : null; } catch { return null; }
}
async function oauthToken(env, params) {
  const r = await fetch(MP_API + "/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.MP_CLIENT_ID, client_secret: env.MP_CLIENT_SECRET, ...params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("oauth " + r.status + " " + String(d.message || d.error || "").slice(0, 120));
  return d;
}
// Token do palestrante, renovado quando faltam menos de 15 dias para vencer.
export async function sellerToken(env, speakerId) {
  if (!splitReady(env) || !UUID.test(String(speakerId || ""))) return null;
  const acc = await one(env, `/rest/v1/speaker_mp_accounts?speaker_id=eq.${speakerId}&select=*`);
  if (!acc) return null;
  let token = await unseal(env, acc.access_token);
  const exp = acc.expires_at ? Date.parse(acc.expires_at) : 0;
  if (acc.refresh_token && exp && exp - Date.now() < 15 * 864e5) {
    try {
      const d = await oauthToken(env, { grant_type: "refresh_token", refresh_token: await unseal(env, acc.refresh_token) });
      token = d.access_token;
      await sb(env, `/rest/v1/speaker_mp_accounts?speaker_id=eq.${speakerId}`, { method: "PATCH", body: {
        access_token: await seal(env, d.access_token), refresh_token: d.refresh_token ? await seal(env, d.refresh_token) : acc.refresh_token,
        expires_at: new Date(Date.now() + (d.expires_in || 15552000) * 1000).toISOString(), updated_at: new Date().toISOString() } });
    } catch (e) { console.error("falha ao renovar o token do palestrante:", e.message); }
  }
  return token;
}
async function tokenForPayment(env, pay) {
  return pay && pay.split ? sellerToken(env, pay.speaker_id) : env.MP_ACCESS_TOKEN;
}

// POST /api/mp/conectar
async function conectarPost({ request, env }) {
  if (!configured(env) || !splitReady(env)) return json(503, { error: "O recebimento pelo Mercado Pago ainda não está configurado." });
  if (!originAllowed(request, env)) return json(403, { error: "Origem não permitida." });
  const me = await currentUser(request, env);
  if (!me) return json(401, { error: "Entre na sua conta para continuar." });
  if (me.profile.role !== "speaker") return json(403, { error: "Só palestrantes conectam uma conta para receber." });
  const url = new URL(MP_AUTH);
  url.searchParams.set("client_id", env.MP_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("platform_id", "mp");
  url.searchParams.set("state", await makeState(env, me.id));
  url.searchParams.set("redirect_uri", siteUrl(env, request) + "/api/mp-oauth/callback");
  return json(200, { url: url.toString() });
}

// GET /api/mp-oauth/callback
async function oauthCallback({ request, env }) {
  const site = siteUrl(env, request);
  const back = (ok) => new Response(null, { status: 302, headers: { Location: site + "/app/#/conta?mp=" + (ok ? "ok" : "erro"), "Cache-Control": "no-store" } });
  if (!configured(env) || !splitReady(env)) return back(false);
  const q = new URL(request.url).searchParams;
  const userId = await readState(env, q.get("state"));
  if (!userId || !q.get("code")) return back(false);
  try {
    const d = await oauthToken(env, { grant_type: "authorization_code", code: q.get("code"), redirect_uri: site + "/api/mp-oauth/callback" });
    await sb(env, "/rest/v1/speaker_mp_accounts?on_conflict=speaker_id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {
      speaker_id: userId, mp_user_id: String(d.user_id), access_token: await seal(env, d.access_token), public_key: d.public_key || null,
      refresh_token: d.refresh_token ? await seal(env, d.refresh_token) : null,
      expires_at: new Date(Date.now() + (d.expires_in || 15552000) * 1000).toISOString(),
      connected_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    return back(true);
  } catch (e) { console.error("conexão com o Mercado Pago falhou:", e.message); return back(false); }
}

async function readBody(request, max = 4000) {
  const raw = await request.text();
  if (raw.length > max) return null;
  try { const b = JSON.parse(raw || "{}"); return b && typeof b === "object" ? b : null; } catch { return null; }
}

// ---------- Pagamento dentro do app (Checkout Transparente) ----------
export function split(amountCents, pct) {
  const p = Math.min(Math.max(Number(pct) || 0, 0), 100);
  const commission = Math.round((amountCents * p) / 100);
  return { commission, payout: amountCents - commission };
}
const MOTIVOS = {
  cc_rejected_insufficient_amount: "Limite insuficiente no cartão.",
  cc_rejected_bad_filled_card_number: "Confira o número do cartão.",
  cc_rejected_bad_filled_date: "Confira a validade do cartão.",
  cc_rejected_bad_filled_security_code: "Confira o código de segurança.",
  cc_rejected_bad_filled_other: "Confira os dados do cartão.",
  cc_rejected_call_for_authorize: "O banco pediu autorização. Fale com o banco ou use outro cartão.",
  cc_rejected_card_disabled: "Cartão desativado. Use outro cartão.",
  cc_rejected_high_risk: "Pagamento recusado por segurança. Tente outro cartão ou pague por Pix.",
  cc_rejected_duplicated_payment: "Este pagamento já foi feito. Confira seu pedido antes de tentar de novo.",
};
const motivo = (d) => MOTIVOS[d] || "O pagamento não foi aprovado. Tente outro cartão ou pague por Pix.";

// Descobre o que está sendo pago, quanto custa (sempre pelo banco) e em qual conta cobrar.
async function resolveCharge(env, me, b) {
  if (b.kind === "verified") {
    if (me.profile.role !== "speaker") return { error: [403, "O selo é só para palestrantes."] };
    const cents = parseInt(env.VERIFIED_PRICE_CENTS || "0", 10);
    if (!(cents > 0)) return { error: [503, "O valor do selo ainda não foi definido."] };
    const sp = await one(env, `/rest/v1/speakers?id=eq.${me.id}&select=status,verified_until`);
    if (!sp || sp.status !== "approved") return { error: [400, "Seu perfil precisa estar aprovado pela equipe antes do selo."] };
    const days = parseInt(env.VERIFIED_DAYS || "365", 10);
    if (sp.verified_until && (days === 0 || new Date(sp.verified_until) - Date.now() > 30 * 864e5)) return { error: [400, "Seu selo já está ativo."] };
    return { kind: "verified", cents, fee: 0, payout: 0, token: env.MP_ACCESS_TOKEN, publicKey: env.MP_PUBLIC_KEY, split: false,
      title: `Selo de palestrante verificado - ${BRAND}`, match: `kind=eq.verified&user_id=eq.${me.id}`, row: { speaker_id: me.id } };
  }
  if (!UUID.test(String(b.quote_id || ""))) return { error: [400, "Pedido inválido."] };
  const q = await one(env, `/rest/v1/quotes?id=eq.${b.quote_id}&select=id,company_id,speaker_id,title,status,amount_cents,speaker_name`);
  if (!q || q.company_id !== me.id) return { error: [404, "Pedido não encontrado."] };
  if (q.status === "paid" || q.status === "done") return { error: [400, "Este pedido já foi pago."] };
  if (q.status !== "accepted" || !(q.amount_cents > 0)) return { error: [400, "Aceite a proposta antes de pagar."] };
  const token = await sellerToken(env, q.speaker_id);
  if (!token) return { error: [409, "O palestrante ainda não conectou a conta do Mercado Pago para receber. Avisamos a equipe; tente de novo mais tarde."], code: "speaker_not_connected" };
  const acc = await one(env, `/rest/v1/speaker_mp_accounts?speaker_id=eq.${q.speaker_id}&select=mp_user_id,public_key`);
  const { commission, payout } = split(q.amount_cents, env.COMMISSION_PCT);
  return { kind: "quote", cents: q.amount_cents, fee: commission, payout, token, publicKey: (acc && acc.public_key) || env.MP_PUBLIC_KEY, split: true,
    title: `Palestra: ${line(q.title, 60)} - ${line(q.speaker_name, 40)}`, match: `kind=eq.quote&quote_id=eq.${q.id}`,
    row: { quote_id: q.id, speaker_id: q.speaker_id, mp_seller_id: acc ? acc.mp_user_id : null } };
}

// GET /api/mp/config?quote_id=...  chave pública para o formulário do cartão (a do palestrante, quando é contratação)
async function mpConfigGet({ request, env }) {
  if (!configured(env)) return json(503, { error: "Servidor não configurado." });
  const me = await currentUser(request, env);
  if (!me) return json(401, { error: "Entre na sua conta para continuar." });
  const qid = new URL(request.url).searchParams.get("quote_id");
  const c = await resolveCharge(env, me, qid ? { kind: "quote", quote_id: qid } : { kind: "verified" });
  if (c.error) return json(c.error[0], { error: c.error[1], code: c.code });
  if (!c.publicKey) return json(503, { error: "Pagamento por cartão ainda não está disponível. Use o Pix." });
  return json(200, { public_key: c.publicKey, amount_cents: c.cents });
}

// POST /api/mp/pagar  { kind: "quote"|"verified", quote_id?, method: "pix"|"card", token?, installments?, payment_method_id?, issuer_id?, identification?, device_id? }
async function pagarPost({ request, env, ctx }) {
  if (!configured(env) || !env.MP_ACCESS_TOKEN) return json(503, { error: "O pagamento ainda não está configurado." });
  if (!originAllowed(request, env)) return json(403, { error: "Origem não permitida." });
  const b = await readBody(request, 6000);
  if (!b || (b.method !== "pix" && b.method !== "card") || (b.kind !== "quote" && b.kind !== "verified")) return json(400, { error: "Pedido inválido." });
  const me = await currentUser(request, env);
  if (!me) return json(401, { error: "Entre na sua conta para continuar." });
  if (b.kind === "quote" && !splitReady(env)) return json(503, { error: "O pagamento ainda não está configurado." });
  let card = null;
  if (b.method === "card") {
    const inst = Number(b.installments || 1);
    if (typeof b.token !== "string" || b.token.length < 8 || b.token.length > 200 || typeof b.payment_method_id !== "string" ||
        !/^[a-z0-9_]{2,30}$/i.test(b.payment_method_id) || !Number.isInteger(inst) || inst < 1 || inst > 12) return json(400, { error: "Dados do cartão inválidos." });
    card = { token: b.token, installments: inst, payment_method_id: b.payment_method_id, issuer_id: b.issuer_id ? String(b.issuer_id).slice(0, 20) : undefined,
      device: typeof b.device_id === "string" && /^[A-Za-z0-9_.:-]{8,200}$/.test(b.device_id) ? b.device_id : null,
      ident: b.identification && typeof b.identification === "object" ? { type: line(b.identification.type, 10), number: String(b.identification.number || "").replace(/\D/g, "").slice(0, 20) } : null };
  }
  const c = await resolveCharge(env, me, b);
  if (c.error) return json(c.error[0], { error: c.error[1], code: c.code });

  // Pix pendente e ainda válido: devolve o mesmo código em vez de criar outro.
  const prev = await sb(env, `/rest/v1/payments?${c.match}&status=eq.pending&order=created_at.desc&limit=1&select=*`);
  const old = Array.isArray(prev) ? prev[0] : null;
  if (old && b.method === "pix" && old.method === "pix" && old.pix_code && old.pix_expires_at && Date.parse(old.pix_expires_at) > Date.now() + 60000) {
    return json(200, { ok: true, id: old.id, status: "pending", pix: { code: old.pix_code, qr_base64: old.pix_qr, expires_at: old.pix_expires_at } });
  }

  const rows = await sb(env, "/rest/v1/payments", { method: "POST", prefer: "return=representation", body: {
    kind: c.kind, user_id: me.id, description: c.title, amount_cents: c.cents, commission_cents: c.fee, payout_cents: c.payout,
    payer_name: me.profile.name, payer_email: me.email, split: c.split, method: b.method, ...c.row } });
  const pay = rows[0];
  const nm = String(me.profile.name || "").trim().split(/\s+/).filter(Boolean);
  const ph = String(me.profile.phone || "").replace(/\D/g, "");
  const payerInfo = {};
  if (nm[0]) payerInfo.first_name = nm[0].slice(0, 50);
  if (nm.length > 1) payerInfo.last_name = nm.slice(1).join(" ").slice(0, 50);
  if (ph.length >= 10) payerInfo.phone = { area_code: ph.slice(0, 2), number: ph.slice(2, 12) };
  const body = {
    transaction_amount: c.cents / 100, description: c.title, external_reference: pay.id, statement_descriptor: "SPEAKERCONNECT",
    notification_url: siteUrl(env, request) + "/api/mp-webhook", payer: { email: me.email },
    additional_info: { payer: payerInfo, items: [{ id: pay.id, title: line(c.title, 100), category_id: "services", quantity: 1, unit_price: c.cents / 100 }] },
  };
  if (c.fee) body.application_fee = c.fee / 100;
  if (b.method === "pix") {
    body.payment_method_id = "pix";
    body.date_of_expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace("Z", "+00:00");
  } else {
    Object.assign(body, { token: card.token, installments: card.installments, payment_method_id: card.payment_method_id });
    if (card.issuer_id) body.issuer_id = card.issuer_id;
    if (card.ident && card.ident.number) body.payer.identification = card.ident;
  }
  const headers = { Authorization: "Bearer " + c.token, "Content-Type": "application/json", "X-Idempotency-Key": "sc-" + pay.id };
  if (card && card.device) headers["X-meli-session-id"] = card.device;
  let res, m;
  try {
    res = await fetch(MP_API + "/v1/payments", { method: "POST", headers, body: JSON.stringify(body) });
    m = await res.json().catch(() => ({}));
  } catch (e) {
    console.error("Mercado Pago fora do ar:", e && e.message);
    return json(502, { error: "Não consegui falar com o Mercado Pago. Tente de novo." });
  }
  if (!res.ok || !m || !m.id) {
    console.error("Mercado Pago recusou o pagamento:", res.status, JSON.stringify(m && (m.message || m.error)).slice(0, 200), JSON.stringify(m && m.cause).slice(0, 300));
    await sb(env, `/rest/v1/payments?id=eq.${pay.id}`, { method: "PATCH", body: { status: "failed" } });
    return json(502, { error: "O Mercado Pago não aceitou o pagamento. Confira os dados ou tente o Pix." });
  }
  const tdata = m.point_of_interaction && m.point_of_interaction.transaction_data;
  const patch = { mp_payment_id: String(m.id) };
  if (b.method === "pix" && tdata) Object.assign(patch, { pix_code: tdata.qr_code || null, pix_qr: tdata.qr_code_base64 || null, pix_expires_at: m.date_of_expiration ? new Date(m.date_of_expiration).toISOString() : null });
  await sb(env, `/rest/v1/payments?id=eq.${pay.id}`, { method: "PATCH", body: patch });
  const applied = await applyPayment(env, request, m, ctx);
  if (m.status === "rejected") return json(200, { ok: false, id: pay.id, status: "rejected", error: motivo(m.status_detail) });
  return json(200, { ok: true, id: pay.id, status: applied.status || m.status,
    ...(b.method === "pix" ? { pix: { code: patch.pix_code, qr_base64: patch.pix_qr, expires_at: patch.pix_expires_at } } : {}) });
}

// ---------- confirmação do pagamento (nunca confia no navegador) ----------
export async function applyPayment(env, request, mp, ctx) {
  const ref = String(mp.external_reference || "");
  if (!UUID.test(ref)) return { reason: "sem-referencia" };
  const pay = await one(env, `/rest/v1/payments?id=eq.${ref}&select=*`);
  if (!pay) return { reason: "pagamento-desconhecido" };

  const patch = { mp_payment_id: String(mp.id) };
  let firstTime = false;
  if (mp.status === "approved") {
    const paid = Math.round(Number(mp.transaction_amount) * 100);
    if (mp.currency_id !== "BRL" || paid !== pay.amount_cents) {
      console.error(`Valor não confere no pagamento ${pay.id}: pago ${paid} ${mp.currency_id}, esperado ${pay.amount_cents}`);
      return { reason: "valor-nao-confere" };
    }
    firstTime = pay.status !== "paid";
    patch.status = "paid";
    patch.paid_at = pay.paid_at || new Date().toISOString();
    if (pay.split && !pay.payout_done_at) patch.payout_done_at = patch.paid_at; // Split: o valor já caiu na conta do palestrante
  } else if (pay.status !== "paid") {
    patch.status = String(mp.status || "pending");
  } else if (mp.status === "refunded" || mp.status === "charged_back") {
    patch.status = mp.status;
    patch.refunded_at = new Date().toISOString();
  }
  await sb(env, `/rest/v1/payments?id=eq.${pay.id}`, { method: "PATCH", body: patch });
  const status = patch.status || pay.status;
  if (pay.kind === "quote" && pay.quote_id && (patch.status === "refunded" || patch.status === "charged_back") && pay.status !== patch.status) {
    await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: { status: "cancelled" } });
  }

  if (firstTime) {
    if (pay.kind === "verified" && pay.speaker_id) {
      const sp = await one(env, `/rest/v1/speakers?id=eq.${pay.speaker_id}&select=verified_until`);
      const days = parseInt(env.VERIFIED_DAYS || "365", 10);
      let until = "infinity";
      if (days > 0) {
        const base = sp && sp.verified_until && new Date(sp.verified_until) > new Date() ? new Date(sp.verified_until) : new Date();
        until = new Date(base.getTime() + days * 864e5).toISOString();
      }
      await sb(env, `/rest/v1/speakers?id=eq.${pay.speaker_id}`, { method: "PATCH", body: { verified_until: until } });
      later(ctx, sendMail(env, { to: env.NOTIFY_EMAIL, subject: `Selo pago: ${brl(pay.amount_cents)} - ${line(pay.payer_name, 60)}`,
        text: `${pay.description}\nValor: ${brl(pay.amount_cents)}\nPalestrante: ${pay.payer_name} (${pay.payer_email})\nPagamento no Mercado Pago: ${mp.id}` }));
      later(ctx, sendMail(env, { to: pay.payer_email, subject: `Seu selo de verificado está ativo - ${BRAND}`,
        text: `Olá, ${first(pay.payer_name)}!\n\nRecebemos o pagamento de ${brl(pay.amount_cents)}. O selo de palestrante verificado já aparece no seu perfil.` +
              `\n\nVocê tem 7 dias para desistir e pedir o reembolso integral, respondendo este e-mail.` + footer(env, request) }));
    }
    if (pay.kind === "quote" && pay.quote_id) {
      await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: { status: "paid", paid_at: patch.paid_at } });
      const q = await one(env, `/rest/v1/quotes?id=eq.${pay.quote_id}&select=title,event_date,company_name,speaker_name,speaker_id`);
      const sp = q && (await one(env, `/rest/v1/profiles?id=eq.${q.speaker_id}&select=name,email`));
      const titulo = q ? line(q.title, 120) : pay.description;
      later(ctx, sendMail(env, { to: env.NOTIFY_EMAIL, subject: `Contratação paga: ${brl(pay.amount_cents)} - ${titulo}`,
        text: `Evento: ${titulo}\nEmpresa: ${q && q.company_name} (${pay.payer_email})\nPalestrante: ${q && q.speaker_name}\n` +
              `Valor pago: ${brl(pay.amount_cents)}\nComissão da plataforma: ${brl(pay.commission_cents)}\nPalestrante recebe: ${brl(pay.payout_cents)}` +
              (pay.split ? " (direto na conta Mercado Pago dele)" : "") + `\nPagamento no Mercado Pago: ${mp.id}` +
              (pay.split ? "" : `\n\nQuando fizer o repasse, marque em ${siteUrl(env, request)}/equipe/ > Pagamentos.`) }));
      later(ctx, sendMail(env, { to: pay.payer_email, subject: `Pagamento confirmado: ${titulo}`,
        text: `Olá, ${first(pay.payer_name)}!\n\nRecebemos o pagamento de ${brl(pay.amount_cents)} pela palestra "${titulo}" com ${q && q.speaker_name}.` +
              `\nO contato direto do palestrante já está liberado no app, na página do pedido.` + footer(env, request) }));
      if (sp) later(ctx, sendMail(env, { to: sp.email, subject: `Palestra confirmada: ${titulo}`,
        text: `Olá, ${first(sp.name)}!\n\n${q.company_name} pagou a palestra "${titulo}"${q.event_date ? " (" + q.event_date.split("-").reverse().join("/") + ")" : ""}.` +
              (pay.split
                ? `\nVocê recebe ${brl(pay.payout_cents)} (valor da proposta menos a comissão da plataforma) direto na sua conta do Mercado Pago, no prazo de liberação da sua conta.`
                : `\nValor do seu repasse: ${brl(pay.payout_cents)} (valor da proposta menos a comissão da plataforma).`) +
              `\nO contato da empresa já está liberado no app, na página do pedido.` + footer(env, request) }));
    }
  }
  return { reason: "ok:" + status, status };
}

async function mpWebhook({ request, env, ctx }) {
  if (!configured(env) || !env.MP_ACCESS_TOKEN || !env.MP_WEBHOOK_SECRET) return json(503, { error: "Webhook não configurado." });
  const url = new URL(request.url);
  let body = null;
  try { body = JSON.parse((await request.text()).slice(0, 20000)); } catch { /* o id também vem na URL */ }
  const dataId = url.searchParams.get("data.id") || (body && body.data && body.data.id);
  const type = url.searchParams.get("type") || (body && body.type);
  const valid = await mpSignatureValid({
    secret: env.MP_WEBHOOK_SECRET, signature: request.headers.get("x-signature"),
    requestId: request.headers.get("x-request-id"), dataId,
  });
  if (!valid) { console.error("webhook: assinatura inválida", JSON.stringify({ dataId: dataId ? String(dataId) : null, type })); return json(401, { error: "assinatura inválida" }); }
  if (type !== "payment") return json(200, { ok: true, ignorado: true });
  try {
    // Contratação: o pagamento pertence à conta do palestrante, então consultamos com o token dele.
    if (!/^\d{3,20}$/.test(String(dataId || ""))) return json(200, { ok: true, ignorado: true });
    const known = await one(env, `/rest/v1/payments?mp_payment_id=eq.${dataId}&select=split,speaker_id`);
    let token = known ? await tokenForPayment(env, known) : env.MP_ACCESS_TOKEN;
    const sellerId = body && body.user_id != null ? String(body.user_id) : "";
    if (!known && /^\d{3,20}$/.test(sellerId)) {
      const acc = await one(env, `/rest/v1/speaker_mp_accounts?mp_user_id=eq.${sellerId}&select=speaker_id`);
      if (acc) token = (await sellerToken(env, acc.speaker_id)) || token;
    }
    if (!token) return json(200, { ok: true, ignorado: "sem-token" });
    const mp = await fetchPayment(env, dataId, token);
    const r = await applyPayment(env, request, mp, ctx);
    console.log("webhook", JSON.stringify({ dataId: String(dataId), mpStatus: mp.status, resultado: r.reason }));
  } catch (e) {
    console.error("webhook: falha:", e && e.message);
    return json(500, { error: "tente de novo" }); // 5xx: o Mercado Pago reenvia
  }
  return json(200, { ok: true });
}

// ---------- GET /api/pagamento?id=... ----------
// O app consulta enquanto mostra o Pix. Se o aviso do Mercado Pago atrasar, confirmamos direto na API.
async function pagamentoGet({ request, env, ctx }) {
  if (!configured(env)) return json(503, { error: "Servidor não configurado." });
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!UUID.test(id)) return json(400, { error: "Pagamento inválido." });
  const me = await currentUser(request, env);
  if (!me) return json(401, { error: "Entre na sua conta para continuar." });
  const pay = await one(env, `/rest/v1/payments?id=eq.${id}&select=id,kind,status,split,speaker_id,user_id,mp_payment_id`);
  if (!pay || (pay.user_id !== me.id && me.profile.role !== "admin")) return json(404, { error: "Pagamento não encontrado." });
  let status = pay.status;
  if (status === "pending" && pay.mp_payment_id) {
    try {
      const token = await tokenForPayment(env, pay);
      if (token) {
        const mp = await fetchPayment(env, pay.mp_payment_id, token);
        if (String(mp.external_reference) === id) { const r = await applyPayment(env, request, mp, ctx); if (r.status) status = r.status; }
      }
    } catch (e) { console.error("consulta do pagamento falhou:", e && e.message); }
  }
  return json(200, { status, kind: pay.kind });
}

// ---------- POST /api/aviso (vem do Supabase) ----------
export async function buildNotice(env, request, type, id) {
  const site = siteUrl(env, request);
  const foot = footer(env, request);
  const team = env.NOTIFY_EMAIL;
  const quoteFull = async (qid) => {
    const q = await one(env, `/rest/v1/quotes?id=eq.${qid}&select=*`);
    if (!q) return null;
    const [c, s] = await Promise.all([
      one(env, `/rest/v1/profiles?id=eq.${q.company_id}&select=name,email`),
      one(env, `/rest/v1/profiles?id=eq.${q.speaker_id}&select=name,email`),
    ]);
    return { q, c, s };
  };
  const when = (q) => (q.event_date ? q.event_date.split("-").reverse().join("/") : "data a combinar");
  const where = (q) => (q.format === "online" ? "online" : [q.city, q.uf].filter(Boolean).join("/") || "local a combinar");

  if (type === "perfil_para_analise" || type === "perfil_aprovado" || type === "perfil_recusado") {
    const sp = await one(env, `/rest/v1/speakers?id=eq.${id}&select=public_name,headline,review_note,city,uf`);
    const p = await one(env, `/rest/v1/profiles?id=eq.${id}&select=name,email`);
    if (!sp || !p) return [];
    if (type === "perfil_para_analise") return [{ to: team, subject: `Perfil para aprovar: ${line(sp.public_name, 60)}`,
      text: `${sp.public_name} enviou o perfil para análise.\n${line(sp.headline, 120)}\n${[sp.city, sp.uf].filter(Boolean).join("/")}\n\nAprove ou recuse em ${site}/equipe/ (aba Palestrantes).` }];
    if (type === "perfil_aprovado") return [{ to: p.email, subject: `Seu perfil foi aprovado no ${BRAND}`,
      text: `Olá, ${first(p.name)}!\n\nSeu perfil de palestrante foi aprovado e já aparece para as empresas.\n\nDica: perfis com foto, vídeo e o selo de verificado recebem mais pedidos.` + foot }];
    return [{ to: p.email, subject: `Seu perfil precisa de ajustes - ${BRAND}`,
      text: `Olá, ${first(p.name)}!\n\nRevisamos seu perfil e ele ainda não pôde ser publicado.` + (sp.review_note ? `\n\nO que ajustar: ${line(sp.review_note, 600)}` : "") +
            `\n\nFaça os ajustes no app e envie de novo para análise.` + foot }];
  }

  if (type === "mensagem_nova") {
    const m = await one(env, `/rest/v1/quote_messages?id=eq.${id}&select=quote_id,sender_id`);
    if (!m) return [];
    const d = await quoteFull(m.quote_id);
    if (!d) return [];
    const toSpeaker = m.sender_id === d.q.company_id;
    const dest = toSpeaker ? d.s : d.c;
    const from = toSpeaker ? d.q.company_name : d.q.speaker_name;
    return dest ? [{ to: dest.email, subject: `Nova mensagem sobre "${line(d.q.title, 80)}"`,
      text: `Olá, ${first(dest.name)}!\n\n${line(from, 80)} mandou uma mensagem sobre o pedido "${line(d.q.title, 120)}".\n\nResponda pelo app: ${site}/app/#/pedido?id=${d.q.id}` + foot }] : [];
  }

  const d = await quoteFull(id);
  if (!d) return [];
  const { q, c, s } = d;
  const link = `${site}/app/#/pedido?id=${q.id}`;
  if (type === "pedido_novo" && s) return [{ to: s.email, subject: `Novo pedido de orçamento: ${line(q.title, 80)}`,
    text: `Olá, ${first(s.name)}!\n\n${line(q.company_name, 80)} pediu um orçamento:\n\nEvento: ${line(q.title, 120)}\nData: ${when(q)}\nLocal: ${where(q)}` +
          (q.audience ? `\nPúblico estimado: ${q.audience} pessoas` : "") + `\n\nResponda com sua proposta: ${link}` + foot }];
  if (type === "proposta_recebida" && c) return [{ to: c.email, subject: `Proposta recebida: ${line(q.title, 80)}`,
    text: `Olá, ${first(c.name)}!\n\n${line(q.speaker_name, 80)} enviou uma proposta para "${line(q.title, 120)}".\nValor: ${brl(q.amount_cents || 0)}` +
          (q.speaker_note ? `\nObservações: ${line(q.speaker_note, 500)}` : "") + `\n\nVeja e aceite pelo app: ${link}` + foot }];
  if (type === "proposta_aceita") {
    const out = [];
    if (s) out.push({ to: s.email, subject: `Proposta aceita: ${line(q.title, 80)}`,
      text: `Olá, ${first(s.name)}!\n\n${line(q.company_name, 80)} aceitou sua proposta de ${brl(q.amount_cents || 0)} para "${line(q.title, 120)}".` +
            `\nAssim que o pagamento for confirmado, avisamos você e liberamos o contato da empresa.` + foot });
    out.push({ to: team, subject: `Proposta aceita: ${line(q.title, 60)} - ${brl(q.amount_cents || 0)}`,
      text: `Empresa: ${q.company_name}\nPalestrante: ${q.speaker_name}\nEvento: ${q.title} (${when(q)}, ${where(q)})\nValor: ${brl(q.amount_cents || 0)}\n\nA empresa já pode pagar pelo app.` });
    return out;
  }
  if (type === "pedido_recusado" && c) return [{ to: c.email, subject: `Pedido não aceito: ${line(q.title, 80)}`,
    text: `Olá, ${first(c.name)}!\n\n${line(q.speaker_name, 80)} não poderá atender o pedido "${line(q.title, 120)}".` +
          (q.speaker_note ? `\nMotivo: ${line(q.speaker_note, 500)}` : "") + `\n\nVeja outros palestrantes no site: ${site}/#palestrantes` + foot }];
  if (type === "pedido_cancelado" && s) return [{ to: s.email, subject: `Pedido cancelado: ${line(q.title, 80)}`,
    text: `Olá, ${first(s.name)}!\n\n${line(q.company_name, 80)} cancelou o pedido "${line(q.title, 120)}".` + foot }];
  return [];
}

async function avisoPost({ request, env, ctx }) {
  if (!env.NOTIFY_SECRET || env.NOTIFY_SECRET.length < 16) return json(503, { error: "Aviso não configurado." });
  if (!(await sameSecret(request.headers.get("x-sc-secret"), env.NOTIFY_SECRET))) return json(401, { error: "Não autorizado." });
  if (!configured(env)) return json(503, { error: "Servidor não configurado." });
  const b = await readBody(request, 2000);
  if (!b || typeof b.type !== "string" || !UUID.test(String(b.id || ""))) return json(400, { error: "Pedido inválido." });
  let msgs;
  try { msgs = await buildNotice(env, request, b.type, b.id); }
  catch (e) { console.error("aviso: falha ao montar:", e && e.message); return json(500, { error: "falha" }); }
  msgs = msgs.filter((m) => m && m.to);
  later(ctx, Promise.all(msgs.map((m) => sendMail(env, m))));
  return json(200, { ok: true, enviados: msgs.length });
}

// ---------- POST /api/reembolso (equipe) ----------
async function reembolsoPost({ request, env }) {
  if (!configured(env) || !env.MP_ACCESS_TOKEN) return json(503, { error: "Pagamento não configurado." });
  if (!originAllowed(request, env)) return json(403, { error: "Origem não permitida." });
  const me = await currentUser(request, env);
  if (!me || me.profile.role !== "admin") return json(403, { error: "Só a equipe pode devolver pagamentos." });
  const b = await readBody(request);
  if (!b || !UUID.test(String(b.payment_id || ""))) return json(400, { error: "Pagamento inválido." });
  const pay = await one(env, `/rest/v1/payments?id=eq.${b.payment_id}&select=*`);
  if (!pay || !pay.mp_payment_id) return json(404, { error: "Pagamento não encontrado." });
  if (pay.status !== "paid") return json(400, { error: "Só pagamentos confirmados podem ser devolvidos." });
  const token = await tokenForPayment(env, pay);
  if (!token) return json(409, { error: "A conta do palestrante não está mais conectada. Faça a devolução pelo painel do Mercado Pago." });
  const r = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(pay.mp_payment_id)}/refunds`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Idempotency-Key": "sc-refund-" + pay.id }, body: "{}",
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    console.error("reembolso recusado:", r.status, JSON.stringify(d).slice(0, 200));
    return json(502, { error: "O Mercado Pago recusou a devolução" + (d && d.message ? ": " + line(d.message, 120) : ".") });
  }
  await sb(env, `/rest/v1/payments?id=eq.${pay.id}`, { method: "PATCH", body: { status: "refunded", refunded_at: new Date().toISOString() } });
  if (pay.kind === "quote" && pay.quote_id) await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: { status: "cancelled" } });
  if (pay.kind === "verified" && pay.speaker_id) await sb(env, `/rest/v1/speakers?id=eq.${pay.speaker_id}`, { method: "PATCH", body: { verified_until: null } });
  return json(200, { ok: true });
}

// ---------- DELETE /api/conta ----------
async function contaDelete({ request, env }) {
  if (!configured(env)) return json(503, { error: "Servidor não configurado." });
  if (!originAllowed(request, env)) return json(403, { error: "Origem não permitida." });
  const me = await currentUser(request, env);
  if (!me) return json(401, { error: "Entre na sua conta para continuar." });
  if (me.profile.role === "admin") return json(400, { error: "Contas da equipe são removidas pelo Supabase." });
  const open = await sb(env, `/rest/v1/quotes?or=(company_id.eq.${me.id},speaker_id.eq.${me.id})&status=eq.paid&select=id`);
  if (Array.isArray(open) && open.length) return json(400, { error: "Você tem uma palestra paga ainda não realizada. Fale com a equipe para encerrar a conta." });
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users/" + me.id, {
    method: "DELETE", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!r.ok) { console.error("conta: falha ao apagar:", r.status); return json(502, { error: "Não foi possível apagar agora. Tente de novo." }); }
  return json(200, { ok: true });
}

// ---------- roteador ----------
const routes = {
  "/api/mp/config": { GET: mpConfigGet },
  "/api/mp/pagar": { POST: pagarPost },
  "/api/pagamento": { GET: pagamentoGet },
  "/api/mp-webhook": { POST: mpWebhook },
  "/api/aviso": { POST: avisoPost },
  "/api/conta": { DELETE: contaDelete },
  "/api/mp/conectar": { POST: conectarPost },
  "/api/mp-oauth/callback": { GET: oauthCallback },
  "/api/reembolso": { POST: reembolsoPost },
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      const r = routes[pathname];
      if (!r) return json(404, { error: "Não encontrado." });
      const h = r[request.method];
      if (!h) return json(405, { error: "Método não permitido." }, { Allow: Object.keys(r).join(", ") });
      try { return await h({ request, env, ctx }); }
      catch (e) { console.error(pathname, "falhou:", e && e.message); return json(500, { error: "Erro inesperado. Tente de novo em instantes." }); }
    }
    return env.ASSETS.fetch(request);
  },
};
