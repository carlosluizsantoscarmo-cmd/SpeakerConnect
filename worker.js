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
// Avisos para a equipe saem de "avisos@": se saíssem do mesmo endereço que a equipe usa no Gmail (contato@),
// o Gmail trataria como mensagem própria e o "Responder" iria para a própria equipe em vez de ir para a empresa.
export function fromFor(env, to) {
  const base = env.MAIL_FROM || `${BRAND} <onboarding@resend.dev>`;
  if (!env.NOTIFY_EMAIL || to !== env.NOTIFY_EMAIL) return base;
  if (env.TEAM_FROM) return env.TEAM_FROM;
  const dom = (base.match(/@([^>\s]+)>?\s*$/) || [])[1];
  return dom && dom !== "resend.dev" ? `${BRAND} Avisos <avisos@${dom}>` : base;
}
export async function sendMail(env, { to, subject, text, replyTo }) {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ from: fromFor(env, to), to: [to], subject, text }, replyTo ? { reply_to: replyTo } : {})),
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
// ---------- sinal e saldo ----------
// Evento a mais de BALANCE_DAYS_BEFORE dias: a empresa paga DEPOSIT_PCT% de sinal para confirmar a data
// e o saldo até BALANCE_DAYS_BEFORE dias antes. Evento perto (ou sem data): pagamento integral, como antes.
export const todaySP = (now = Date.now()) => new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
export const addDays = (ymd, n) => new Date(Date.parse(ymd + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
export const fmtDate = (ymd) => (ymd ? String(ymd).slice(0, 10).split("-").reverse().join("/") : "");
const numEnv = (v, d, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < max ? n : d; };
export const depositPct = (env) => numEnv(env.DEPOSIT_PCT, 30, 100);
export const balanceDays = (env) => Math.round(numEnv(env.BALANCE_DAYS_BEFORE, 7, 60));
export const cancelFeePct = (env) => numEnv(env.CANCEL_FEE_PCT, 10, 100);

// O que a empresa paga agora por este pedido: { stage: "full"|"deposit"|"balance", cents, due? } ou null.
export function chargePlan(env, q, now = Date.now()) {
  if (!q || !(q.amount_cents > 0)) return null;
  if (q.status === "accepted") {
    const days = balanceDays(env);
    const ev = q.event_date ? String(q.event_date).slice(0, 10) : null;
    if (ev && daysBetween(todaySP(now), ev) > days) {
      const cents = Math.round((q.amount_cents * depositPct(env)) / 100);
      if (cents >= 100 && q.amount_cents - cents >= 100) return { stage: "deposit", cents, due: addDays(ev, -days) };
    }
    return { stage: "full", cents: q.amount_cents };
  }
  if (q.status === "paid" && q.deposit_cents > 0 && !q.balance_paid_at) {
    return { stage: "balance", cents: q.amount_cents - q.deposit_cents, due: q.balance_due_on || null };
  }
  return null;
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
  const q = await one(env, `/rest/v1/quotes?id=eq.${b.quote_id}&select=id,company_id,speaker_id,title,status,amount_cents,speaker_name,event_date,deposit_cents,balance_due_on,balance_paid_at`);
  if (!q || q.company_id !== me.id) return { error: [404, "Pedido não encontrado."] };
  const plan = chargePlan(env, q);
  if (!plan) {
    if (q.status === "paid" || q.status === "done") return { error: [400, "Este pedido já foi pago."] };
    return { error: [400, "Aceite a proposta antes de pagar."] };
  }
  const token = await sellerToken(env, q.speaker_id);
  if (!token) return { error: [409, "O palestrante ainda não conectou a conta do Mercado Pago para receber. Avisamos a equipe; tente de novo mais tarde."], code: "speaker_not_connected" };
  const acc = await one(env, `/rest/v1/speaker_mp_accounts?speaker_id=eq.${q.speaker_id}&select=mp_user_id,public_key`);
  const { commission, payout } = split(plan.cents, env.COMMISSION_PCT);
  const prefix = plan.stage === "deposit" ? "Sinal da palestra" : plan.stage === "balance" ? "Saldo da palestra" : "Palestra";
  return { kind: "quote", cents: plan.cents, fee: commission, payout, token, publicKey: (acc && acc.public_key) || env.MP_PUBLIC_KEY, split: true, stage: plan.stage,
    title: `${prefix}: ${line(q.title, 50)} - ${line(q.speaker_name, 40)}`, match: `kind=eq.quote&quote_id=eq.${q.id}&stage=eq.${plan.stage}`,
    row: { quote_id: q.id, speaker_id: q.speaker_id, mp_seller_id: acc ? acc.mp_user_id : null, stage: plan.stage } };
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
  return json(200, { public_key: c.publicKey, amount_cents: c.cents, stage: c.stage || null });
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

  // Devolvido em parte (cancelamento com taxa): o Mercado Pago continua "approved"; não confirmar de novo.
  if (pay.refunded_at && mp.status === "approved") return { reason: "ja-devolvido", status: pay.status };
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
  if (pay.kind === "quote" && pay.quote_id && pay.stage !== "balance" && (patch.status === "refunded" || patch.status === "charged_back") && pay.status !== patch.status) {
    await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: { status: "cancelled" } });
  }
  if (pay.kind === "quote" && pay.quote_id && pay.stage === "balance" && (patch.status === "refunded" || patch.status === "charged_back") && pay.status !== patch.status) {
    await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: { balance_paid_at: null } });
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
    if (pay.kind === "quote" && pay.quote_id) await quotePaid(env, request, ctx, pay, mp, patch.paid_at);
  }
  return { reason: "ok:" + status, status };
}

// Pagamento de contratação confirmado: atualiza o pedido e avisa empresa, palestrante e equipe.
async function quotePaid(env, request, ctx, pay, mp, paidAt) {
  const stage = pay.stage || "full";
  const q0 = await one(env, `/rest/v1/quotes?id=eq.${pay.quote_id}&select=event_date,amount_cents`);
  const ev = q0 && q0.event_date ? String(q0.event_date).slice(0, 10) : null;
  const qpatch = stage === "deposit"
    ? { status: "paid", paid_at: paidAt, deposit_cents: pay.amount_cents, deposit_paid_at: paidAt, balance_due_on: ev ? addDays(ev, -balanceDays(env)) : null }
    : stage === "balance" ? { balance_paid_at: paidAt } : { status: "paid", paid_at: paidAt };
  await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: qpatch });
  const q = await one(env, `/rest/v1/quotes?id=eq.${pay.quote_id}&select=title,event_date,company_name,speaker_name,speaker_id,amount_cents,deposit_cents,balance_due_on`);
  const sp = q && (await one(env, `/rest/v1/profiles?id=eq.${q.speaker_id}&select=name,email`));
  const titulo = q ? line(q.title, 120) : pay.description;
  const quando = q && q.event_date ? " (" + fmtDate(q.event_date) + ")" : "";
  const saldo = q && q.deposit_cents ? q.amount_cents - q.deposit_cents : 0;
  const link = `${siteUrl(env, request)}/app/#/pedido?id=${pay.quote_id}`;
  const foot = footer(env, request);
  const nome = { deposit: "Sinal", balance: "Saldo", full: "Contratação" }[stage];
  later(ctx, sendMail(env, { to: env.NOTIFY_EMAIL, subject: `${nome} pago: ${brl(pay.amount_cents)} - ${titulo}`,
    text: `Evento: ${titulo}${quando}\nEmpresa: ${q && q.company_name} (${pay.payer_email})\nPalestrante: ${q && q.speaker_name}\n` +
          `${nome} pago: ${brl(pay.amount_cents)}\nComissão da plataforma: ${brl(pay.commission_cents)}\nPalestrante recebe: ${brl(pay.payout_cents)}` +
          (pay.split ? " (direto na conta Mercado Pago dele)" : "") + `\nPagamento no Mercado Pago: ${mp.id}` +
          (stage === "deposit" ? `\n\nSaldo de ${brl(saldo)} vence em ${fmtDate(q && q.balance_due_on)}. Acompanhe em ${siteUrl(env, request)}/equipe/ > Financeiro.` : "") +
          (pay.split ? "" : `\n\nQuando fizer o repasse, marque em ${siteUrl(env, request)}/equipe/ > Financeiro.`) }));
  const toCompany = stage === "deposit"
    ? { subject: `Data confirmada: ${titulo}`,
        text: `Olá, ${first(pay.payer_name)}!\n\nRecebemos o sinal de ${brl(pay.amount_cents)} pela palestra "${titulo}"${quando} com ${q && q.speaker_name}. A data está garantida!` +
              `\n\nSaldo: ${brl(saldo)}, até ${fmtDate(q && q.balance_due_on)}. Avisamos você por e-mail antes do vencimento, e o pagamento é pelo app: ${link}` +
              `\n\nO contato direto do palestrante já está liberado no app, na página do pedido.` + foot }
    : stage === "balance"
    ? { subject: `Pagamento concluído: ${titulo}`,
        text: `Olá, ${first(pay.payer_name)}!\n\nRecebemos o saldo de ${brl(pay.amount_cents)} pela palestra "${titulo}"${quando}. O pagamento está quitado. Bom evento!` + foot }
    : { subject: `Pagamento confirmado: ${titulo}`,
        text: `Olá, ${first(pay.payer_name)}!\n\nRecebemos o pagamento de ${brl(pay.amount_cents)} pela palestra "${titulo}" com ${q && q.speaker_name}.` +
              `\nO contato direto do palestrante já está liberado no app, na página do pedido.` + foot };
  later(ctx, sendMail(env, { to: pay.payer_email, ...toCompany }));
  if (!sp) return;
  const recebe = pay.split
    ? `Você recebe ${brl(pay.payout_cents)} (já descontada a comissão da plataforma) direto na sua conta do Mercado Pago, no prazo de liberação da sua conta.`
    : `Valor do seu repasse: ${brl(pay.payout_cents)} (já descontada a comissão da plataforma).`;
  const toSpeaker = stage === "deposit"
    ? { subject: `Palestra confirmada: ${titulo}`,
        text: `Olá, ${first(sp.name)}!\n\n${q.company_name} pagou o sinal da palestra "${titulo}"${quando}. A data está confirmada!\n${recebe}` +
              `\n\nO saldo de ${brl(saldo)} vence em ${fmtDate(q.balance_due_on)}, e avisamos você quando for pago.` +
              `\nO contato da empresa já está liberado no app, na página do pedido.` + foot }
    : stage === "balance"
    ? { subject: `Saldo pago: ${titulo}`, text: `Olá, ${first(sp.name)}!\n\n${q.company_name} pagou o saldo da palestra "${titulo}"${quando}. O contrato está quitado.\n${recebe}` + foot }
    : { subject: `Palestra confirmada: ${titulo}`,
        text: `Olá, ${first(sp.name)}!\n\n${q.company_name} pagou a palestra "${titulo}"${quando}.\n${recebe}` +
              `\nO contato da empresa já está liberado no app, na página do pedido.` + foot };
  later(ctx, sendMail(env, { to: sp.email, ...toSpeaker }));
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
const ymdBR = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "");
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

  if (type === "certificado_emitido") {
    const c = await one(env, `/rest/v1/certificates?id=eq.${id}&select=code,name,email,event_id`);
    const ev = c && (await one(env, `/rest/v1/cert_events?id=eq.${c.event_id}&select=talk_title,speaker_name,company_name,event_date`));
    if (!c || !ev) return [];
    return [{ to: c.email, subject: `Seu certificado: ${line(ev.talk_title, 80)}`,
      text: `Olá, ${first(c.name)}!\n\nSeu certificado de participação na palestra "${line(ev.talk_title, 160)}", com ${line(ev.speaker_name, 80)}, ` +
            `realizada por ${line(ev.company_name, 120)} em ${ymdBR(ev.event_date)}, está pronto.\n\n` +
            `Baixar o certificado (PDF): ${site}/certificado/?c=${encodeURIComponent(c.code)}\n\nCódigo de verificação: ${c.code}\n\n` +
            `Se o nome estiver errado, abra o QR Code do evento de novo e informe o mesmo e-mail com o nome certo.\n\n` +
            `Você recebe este e-mail porque pediu um certificado no ${BRAND}.` }];
  }

  if (type === "logo_para_analise") {
    const c = await one(env, `/rest/v1/companies?id=eq.${id}&select=company_name,logo_url,logo_status`);
    if (!c || c.logo_status !== "pending") return [];
    return [{ to: team, subject: `Logo para aprovar: ${line(c.company_name, 60)}`,
      text: `${line(c.company_name, 80)} enviou a logo e autorizou a exibição em Empresas Parceiras.\n${c.logo_url || ""}\n\nAprove ou recuse em ${site}/equipe/ (aba Empresas).` }];
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
          (q.audience ? `\nPúblico estimado: ${q.audience} pessoas` : "") + `\n\nResponda com sua proposta: ${link}` + foot }].concat(team ? [{
    to: team, replyTo: c && c.email, subject: `Novo pedido para ${line(q.speaker_name, 60)}: ${line(q.title, 80)}`,
    text: `Empresa: ${line(q.company_name, 80)}${c ? ` (${line(c.name, 60)}, ${c.email})` : ""}\nPalestrante: ${line(q.speaker_name, 80)}${s.email ? ` (${s.email})` : ""}\n` +
          `Evento: ${line(q.title, 120)}\nData: ${when(q)}\nLocal: ${where(q)}` + (q.audience ? `\nPúblico estimado: ${q.audience} pessoas` : "") +
          (q.message ? `\n\nDetalhes:\n${String(q.message).slice(0, 1500)}` : "") +
          `\n\nO palestrante já foi avisado. Responda este e-mail para falar direto com a empresa. Veja em ${site}/equipe/.` }] : []);
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
  if (pay.status !== "paid" || pay.refunded_at) return json(400, { error: "Só pagamentos confirmados podem ser devolvidos." });
  // Taxa de cancelamento (empresa cancelou com antecedência): devolve o sinal menos CANCEL_FEE_PCT%, que fica com o palestrante.
  const withFee = !!b.fee && pay.kind === "quote" && pay.stage === "deposit";
  const refund = withFee ? pay.amount_cents - Math.round((pay.amount_cents * cancelFeePct(env)) / 100) : pay.amount_cents;
  const token = await tokenForPayment(env, pay);
  if (!token) return json(409, { error: "A conta do palestrante não está mais conectada. Faça a devolução pelo painel do Mercado Pago." });
  const r = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(pay.mp_payment_id)}/refunds`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Idempotency-Key": "sc-refund-" + pay.id + (withFee ? "-taxa" : "") },
    body: withFee ? JSON.stringify({ amount: refund / 100 }) : "{}",
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    console.error("reembolso recusado:", r.status, JSON.stringify(d).slice(0, 200));
    return json(502, { error: "O Mercado Pago recusou a devolução" + (d && d.message ? ": " + line(d.message, 120) : ".") });
  }
  await sb(env, `/rest/v1/payments?id=eq.${pay.id}`, { method: "PATCH", body: { status: "refunded", refunded_at: new Date().toISOString(), refunded_cents: refund } });
  if (pay.kind === "quote" && pay.quote_id) await sb(env, `/rest/v1/quotes?id=eq.${pay.quote_id}`, { method: "PATCH", body: pay.stage === "balance" ? { balance_paid_at: null } : { status: "cancelled" } });
  if (pay.kind === "verified" && pay.speaker_id) await sb(env, `/rest/v1/speakers?id=eq.${pay.speaker_id}`, { method: "PATCH", body: { verified_until: null } });
  return json(200, { ok: true, refunded_cents: refund });
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
  // LGPD: o documento de identidade sai junto com a conta.
  try {
    const doc = await one(env, `/rest/v1/speaker_documents?speaker_id=eq.${me.id}&select=front_path,back_path`);
    const paths = doc ? [doc.front_path, doc.back_path].filter(Boolean) : [];
    if (paths.length) {
      await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/documentos", {
        method: "DELETE", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: paths }),
      });
    }
  } catch (e) { console.error("conta: falha ao apagar o documento:", e && e.message); }
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users/" + me.id, {
    method: "DELETE", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!r.ok) { console.error("conta: falha ao apagar:", r.status); return json(502, { error: "Não foi possível apagar agora. Tente de novo." }); }
  return json(200, { ok: true });
}

// ---------- páginas públicas: prévia do perfil (WhatsApp/LinkedIn/Google) e sitemap ----------
const SPEAKER_SEO_COLS = "id,public_name,headline,bio,topics,city,uf,categories,formats,fee_from_cents,photo_url,updated_at,invoice";
// Endereço do perfil com o nome: /palestrante/mirella-leao-b3802277 (8 primeiros caracteres do id). Igual ao site.js.
export const slugify = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "palestrante";
export const spPath = (s) => "/palestrante/" + slugify(s.public_name) + "-" + String(s.id).slice(0, 8);
const PRETTY = /^\/palestrante\/([a-z0-9-]*?)-?([0-9a-f]{8})\/?$/;
const escHtml = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const siteBase = (env) => String(env.SITE_URL || "https://speakerconnect.com.br").replace(/\/$/, "");

// Lê só dados públicos, com a chave pública: as regras do banco valem (apenas perfis aprovados).
async function publicSpeakers(env, query, table = "speakers") {
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + `/rest/v1/${table}?` + query, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) throw new Error(table + " " + r.status);
  return r.json();
}

function clip(t, n) {
  t = String(t || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}

async function notFoundPage(res) {
  const html = (await res.text()).replace("</head>", '<meta name="robots" content="noindex">\n</head>');
  const headers = new Headers(res.headers);
  headers.delete("content-length"); headers.delete("etag");
  headers.set("Cache-Control", "public, max-age=60");
  return new Response(html, { status: 404, headers });
}

const brlPlain = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtLabelSrv = (f) => { f = Array.isArray(f) ? f : []; return f.length === 2 ? "Presencial e online" : f[0] === "online" ? "Online" : f[0] === "presencial" ? "Presencial" : "A combinar"; };
// O texto do perfil já vem no HTML (o Google lê sem precisar rodar o site). O site.js redesenha a página igual ao carregar.
export function speakerBody(html, s) {
  const place = s.city ? s.city + (s.uf ? "/" + s.uf : "") : "";
  const talks = String(s.topics || "").split(/\n+/).map((t) => t.replace(/^[\s•\-–*·\d.)]+/, "").trim()).filter(Boolean);
  const photo = /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/public\//.test(s.photo_url || "") ? s.photo_url : "";
  const ask = "/app/#/novo-pedido?p=" + encodeURIComponent(s.id);
  const body =
    '<div class="prof-top"><div class="wrap"><div class="ph">' + (photo ? `<img src="${escHtml(photo)}" alt="Foto de ${escHtml(s.public_name)}">` : "") + "</div>" +
    '<div><a class="back" href="/#palestrantes">← Todos os palestrantes</a><h1>' + escHtml(s.public_name) + "</h1>" +
    (s.headline ? '<p class="hl">' + escHtml(s.headline) + "</p>" : "") +
    '<div class="tags">' + (s.categories || []).map((c) => '<span class="tag">' + escHtml(c) + "</span>").join("") + "</div>" +
    '<div class="facts"><span>Atende<b>' + escHtml(fmtLabelSrv(s.formats)) + "</b></span>" + (place ? "<span>Base<b>" + escHtml(place) + "</b></span>" : "") +
    (s.invoice ? "<span>Nota fiscal<b>" + (s.invoice === "rpa" ? "Recibo de autônomo (RPA)" : "Emite NF") + "</b></span>" : "") + "</div>" +
    `<div class="cta"><a class="btn spot" href="${ask}">Pedir orçamento</a>` + (s.fee_from_cents ? '<span class="from">Palestras a partir de<b>' + brlPlain(s.fee_from_cents) + "</b></span>" : '<span class="from">Valor<b>sob consulta</b></span>') + "</div></div></div></div>" +
    '<div class="prof-body"><div class="wrap"><div>' +
    (s.bio ? '<div class="blk"><h2>Sobre</h2><div class="bio">' + escHtml(s.bio) + "</div></div>" : "") +
    (talks.length ? '<div class="blk"><h2>Palestras</h2><div class="talks">' + talks.map((t) => '<div class="talk">' + escHtml(t) + "</div>").join("") + "</div></div>" : "") +
    "</div></div></div>";
  return html.replace(/<main id="prof">[\s\S]*?<\/main>/, () => '<main id="prof">' + body + "</main>");
}

// Página inicial: a lista de palestrantes já vem no HTML, com links para cada perfil (o site.js redesenha depois).
export function homeGrid(html, rows) {
  const cards = rows.filter((s) => UUID.test(s.id || "") && s.public_name).map((s) => {
    const place = s.city ? s.city + (s.uf ? "/" + s.uf : "") : "";
    return `<a class="sp" href="${spPath(s)}"><div class="bd"><h3>${escHtml(s.public_name)}</h3>` +
      (s.headline ? `<p class="hl">${escHtml(clip(s.headline, 160))}</p>` : "") +
      ((s.categories || []).length ? '<div class="tags">' + s.categories.slice(0, 2).map((c) => '<span class="tag">' + escHtml(c) + "</span>").join("") + "</div>" : "") +
      `<div class="where">${escHtml((place ? place + " · " : "") + fmtLabelSrv(s.formats))}</div><div class="foot"><span class="go">Ver perfil</span></div></div></a>`;
  }).join("");
  if (!cards) return html;
  return html.replace(/<div class="grid" id="grid"([^>]*)><\/div>/, (m, a) => `<div class="grid" id="grid"${a}>${cards}</div>`);
}

// ---------- páginas por tema (/palestras, /palestras/<tema>) e calendário (/campanhas) ----------
// Tudo vem pronto no HTML, para o Google ler. O site.js só cuida do menu e do rodapé.
export const THEME_INTRO = {
  "Liderança": "Palestras para formar líderes que engajam, dão feedback e desenvolvem pessoas. Ideais para encontros de gestores, programas de liderança e convenções.",
  "Motivacional": "Palestras que renovam a energia das equipes, com histórias reais e mensagens que ficam. Boas para abertura de eventos, convenções e fim de ano.",
  "Vendas": "Palestras para times comerciais venderem mais e melhor: atendimento, negociação, performance e experiência do cliente.",
  "Gestão de Pessoas e RH": "Palestras sobre cultura, clima, comunicação, carreira e desenvolvimento humano, para semanas de RH e programas de treinamento.",
  "Saúde e Bem-Estar": "Palestras sobre qualidade de vida, alimentação, ergonomia e prevenção, muito procuradas em SIPATs e campanhas de saúde.",
  "Saúde Mental": "Palestras sobre saúde mental no trabalho, estresse, ansiedade e riscos psicossociais (NR-1), para SIPAT, Janeiro Branco e Setembro Amarelo.",
  "Segurança do Trabalho e SIPAT": "Palestras para SIPAT e para a cultura de segurança: prevenção de acidentes, percepção de risco, NR-1 e comportamento seguro.",
  "Direito": "Palestras sobre direitos, deveres e temas jurídicos do dia a dia das empresas e dos colaboradores.",
  "Tecnologia e Inovação": "Palestras sobre inteligência artificial, transformação digital, automação e inovação aplicada aos negócios.",
  "Empreendedorismo": "Palestras para quem quer empreender ou inovar dentro da empresa: planejamento, carreira empreendedora e novos negócios.",
  "Marketing": "Palestras sobre marca, presença digital, conteúdo e estratégias para atrair e fidelizar clientes.",
  "Finanças": "Palestras de educação financeira para colaboradores e de gestão financeira para empresas.",
  "Meio Ambiente e ESG": "Palestras sobre sustentabilidade, ESG e responsabilidade socioambiental, para semanas do meio ambiente e programas corporativos.",
  "Diversidade e Inclusão": "Palestras sobre diversidade, inclusão, respeito e combate ao assédio, para ambientes de trabalho mais saudáveis.",
  "Comunicação e Oratória": "Palestras sobre comunicação assertiva, comunicação não violenta, oratória e relacionamento entre equipes.",
  "Educação": "Palestras para escolas, educadores e programas educacionais dentro e fora das empresas.",
};
export const CAMPAIGNS = [
  ["Janeiro", "Janeiro Branco", "Mês da saúde mental e emocional.", ["Saúde Mental"]],
  ["Março", "Mês da Mulher", "Liderança feminina, carreira, respeito e equidade.", ["Diversidade e Inclusão", "Liderança"]],
  ["Abril", "Abril Verde", "Mês da saúde e da segurança no trabalho.", ["Segurança do Trabalho e SIPAT", "Saúde e Bem-Estar"]],
  ["Maio", "Maio Amarelo", "Segurança no trânsito, inclusive no trajeto para o trabalho.", ["Segurança do Trabalho e SIPAT"]],
  ["Junho", "Semana do Meio Ambiente", "Sustentabilidade, ESG e consumo consciente.", ["Meio Ambiente e ESG"]],
  ["Agosto", "Agosto Lilás", "Conscientização e combate à violência contra a mulher.", ["Diversidade e Inclusão"]],
  ["Setembro", "Setembro Amarelo", "Prevenção e valorização da vida.", ["Saúde Mental"]],
  ["Outubro", "Outubro Rosa", "Prevenção do câncer de mama e saúde da mulher.", ["Saúde e Bem-Estar"]],
  ["Novembro", "Novembro Azul", "Prevenção do câncer de próstata e saúde do homem.", ["Saúde e Bem-Estar"]],
  ["Dezembro", "Encerramento e planejamento", "Reconhecimento, motivação e metas para o novo ano.", ["Motivacional", "Liderança"]],
  ["O ano todo", "SIPAT", "Semana Interna de Prevenção de Acidentes, com temas de segurança, saúde e bem-estar.", ["Segurança do Trabalho e SIPAT", "Saúde Mental", "Saúde e Bem-Estar"]],
];
const themeTitle = (c) => /SIPAT|Liderança|Vendas|Marketing|Finanças|Educação|Direito|Empreendedorismo/.test(c) ? "Palestras de " + c : "Palestras sobre " + c;

function spCard(s) {
  const photo = /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/public\//.test(s.photo_url || "") ? s.photo_url : "";
  const place = s.city ? s.city + (s.uf ? "/" + s.uf : "") : "";
  const ini = String(s.public_name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<a class="sp" href="${spPath(s)}"><div class="ph">` + (photo ? `<img src="${escHtml(photo)}" alt="" loading="lazy">` : `<div class="mono" aria-hidden="true">${escHtml(ini)}</div>`) + "</div>" +
    `<div class="bd"><h3>${escHtml(s.public_name)}</h3>` + (s.headline ? `<p class="hl">${escHtml(clip(s.headline, 160))}</p>` : "") +
    ((s.categories || []).length ? '<div class="tags">' + s.categories.slice(0, 2).map((c) => '<span class="tag">' + escHtml(c) + "</span>").join("") + "</div>" : "") +
    `<div class="where">${escHtml((place ? place + " · " : "") + fmtLabelSrv(s.formats))}` + (s.invoice === "cnpj" || s.invoice === "mei" ? '<span class="nf">Emite NF</span>' : "") + "</div>" +
    `<div class="foot"><span class="fee">${s.fee_from_cents ? "a partir de<b>" + brlPlain(s.fee_from_cents) + "</b>" : "valor sob consulta"}</span><span class="go">Ver perfil</span></div></div></a>`;
}

export function themeHtml(kind, cats, rows, theme) {
  const count = {};
  rows.forEach((s) => (s.categories || []).forEach((c) => { count[c] = (count[c] || 0) + 1; }));
  const rec = (c) => `/?indicar=${encodeURIComponent(c)}#indicacao`;
  const hero = (eb, h1, lead) => `<section class="ab-hero"><div class="wrap"><p class="ab-eb">${eb}</p><h1>${h1}</h1><p class="ab-lead">${lead}</p></div></section>`;
  if (kind === "index") {
    return hero("Temas", "Palestras para cada <span>momento da empresa</span>", "Escolha o tema e veja os palestrantes. Pedir orçamento é grátis e sem compromisso.") +
      '<section class="tm-list"><div class="wrap"><ul class="tm-grid" role="list">' + cats.map((c) =>
        `<li><a href="/palestras/${slugify(c)}"><b>${escHtml(c)}</b><span>${count[c] ? count[c] + (count[c] === 1 ? " palestrante" : " palestrantes") : "Indicação da equipe"}</span></a></li>`).join("") +
      '</ul><p class="tm-more">Planejando o ano? Veja o <a href="/campanhas">calendário de campanhas</a> com sugestões de palestras para cada mês.</p></div></section>' + recCta();
  }
  if (kind === "campanhas") {
    return hero("Calendário", "Campanhas do ano e <span>palestras para cada mês</span>", "Janeiro Branco, Abril Verde, Maio Amarelo, Setembro Amarelo, Outubro Rosa, Novembro Azul e SIPAT: planeje as palestras da sua empresa com antecedência.") +
      '<section class="tm-cal"><div class="wrap"><ol class="cal" role="list">' + CAMPAIGNS.map(([m, n, d, ts]) => {
        const sp = rows.filter((s) => (s.categories || []).some((c) => ts.includes(c))).slice(0, 3);
        return `<li><p class="cal-m">${escHtml(m)}</p><h2>${escHtml(n)}</h2><p>${escHtml(d)}</p><div class="cal-t">` +
          ts.filter((t) => cats.includes(t)).map((t) => `<a href="/palestras/${slugify(t)}">${escHtml(t)}</a>`).join("") + "</div>" +
          (sp.length ? '<p class="cal-sp">Palestrantes: ' + sp.map((s) => `<a href="${spPath(s)}">${escHtml(s.public_name)}</a>`).join(", ") + "</p>" : "") + "</li>";
      }).join("") + "</ol></div></section>" + recCta();
  }
  const list = rows.filter((s) => (s.categories || []).includes(theme));
  const camp = CAMPAIGNS.filter((c) => c[3].includes(theme));
  return hero("Tema", escHtml(themeTitle(theme)), escHtml(THEME_INTRO[theme] || "Encontre palestrantes sobre " + theme + " para o seu evento. Pedir orçamento é grátis e sem compromisso.")) +
    '<section class="tm-sp"><div class="wrap"><div class="sec-head"><div><h2>' + (list.length ? list.length + (list.length === 1 ? " palestrante" : " palestrantes") + " neste tema" : "Ainda sem perfis publicados neste tema") + "</h2>" +
    '<p class="muted">Perfis revisados pela nossa equipe. Presencial e online.</p></div></div>' +
    (list.length ? '<div class="grid">' + list.map(spCard).join("") + "</div>"
      : `<div class="empty"><h3>A gente indica um palestrante para você</h3><p class="muted">Conte como é o seu evento e a nossa equipe sugere nomes em até 1 dia útil.</p><a class="btn spot" href="${rec(theme)}">Pedir indicação</a></div>`) +
    (camp.length ? '<p class="tm-more">Campanhas ligadas a este tema: ' + camp.map((c) => `<b>${escHtml(c[1])}</b> (${escHtml(c[0].toLowerCase())})`).join(", ") + '. Veja o <a href="/campanhas">calendário completo</a>.</p>' : "") +
    '<p class="tm-more">Outros temas: ' + cats.filter((c) => c !== theme).slice(0, 8).map((c) => `<a href="/palestras/${slugify(c)}">${escHtml(c)}</a>`).join(" · ") + ' · <a href="/palestras">todos</a></p>' +
    "</div></section>" + recCta(theme);
  function recCta(t) {
    return `<section class="ab-cta"><div class="wrap"><h2>Não sabe qual palestrante escolher?</h2><p style="color:#CFCDEB;margin:0 0 18px">A nossa equipe indica 2 ou 3 nomes em até 1 dia útil, sem custo.</p>` +
      `<div class="ab-btns"><a class="btn spot" href="${t ? rec(t) : "/#indicacao"}">Pedir indicação</a><a class="btn ghost" href="/#palestrantes">Ver todos os palestrantes</a></div></div></section>`;
  }
}

async function themePages(request, env) {
  const url = new URL(request.url), base = siteBase(env);
  const res = await env.ASSETS.fetch(new Request(new URL("/tema", url), request));
  if (!res.ok || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res;
  const [cats, rows] = await Promise.all([
    publicSpeakers(env, "select=name&active=eq.true&order=sort", "categories").then((r) => r.map((c) => c.name).filter(Boolean)),
    publicSpeakers(env, "select=id,public_name,headline,city,uf,categories,formats,fee_from_cents,photo_url,invoice,verified_until&status=eq.approved&order=verified_until.desc.nullslast,updated_at.desc&limit=500"),
  ]);
  let kind = "index", theme = null, title = "Palestras por tema | SpeakerConnect", desc = "Palestras de liderança, saúde mental e NR-1, SIPAT, vendas, gestão de pessoas e mais. Veja os palestrantes e peça orçamento sem custo.";
  if (url.pathname === "/campanhas") {
    kind = "campanhas"; title = "Calendário de campanhas: palestras para cada mês | SpeakerConnect";
    desc = "Janeiro Branco, Abril Verde, Maio Amarelo, Setembro Amarelo, Outubro Rosa, Novembro Azul e SIPAT: palestras e palestrantes para cada campanha do ano.";
  } else if (url.pathname.startsWith("/palestras/")) {
    const slug = url.pathname.slice(11).replace(/\/$/, "");
    theme = cats.find((c) => slugify(c) === slug) || null;
    if (!theme) return notFoundPage(res);
    kind = "tema"; title = themeTitle(theme) + " | SpeakerConnect";
    desc = clip(THEME_INTRO[theme] || "Palestrantes sobre " + theme + ". Peça orçamento sem custo.", 158);
  }
  const canon = base + url.pathname.replace(/\/$/, "");
  const html = (await res.text())
    .replace("{{TITLE}}", escHtml(title)).replace("{{DESC}}", escHtml(desc)).replace("{{CANON}}", canon)
    .replace('<main class="about tema" id="tema"></main>', () => '<main class="about tema" id="tema">' + themeHtml(kind, cats, rows, theme) + "</main>");
  const headers = new Headers(res.headers);
  headers.delete("content-length"); headers.delete("etag");
  headers.set("Cache-Control", "public, max-age=600");
  return new Response(html, { status: 200, headers });
}

async function homePage(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.ok || !/text\/html/.test(res.headers.get("content-type") || "") || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res;
  let rows;
  try { rows = await publicSpeakers(env, "select=id,public_name,headline,city,uf,categories,formats&status=eq.approved&order=verified_until.desc.nullslast,updated_at.desc&limit=60"); }
  catch (e) { console.error("home: lista falhou:", e && e.message); return res; }
  const html = homeGrid(await res.text(), Array.isArray(rows) ? rows : []);
  const headers = new Headers(res.headers);
  headers.delete("content-length"); headers.delete("etag");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(html, { status: 200, headers });
}

export function speakerMeta(html, s, pageUrl, env) {
  const place = s.city ? s.city + (s.uf ? "/" + s.uf : "") : "";
  const title = s.public_name + " | Palestrante | SpeakerConnect";
  const desc = clip([s.headline, place].filter(Boolean).join(" · ") + ". Peça um orçamento sem custo no SpeakerConnect.", 200);
  const img = /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/public\//.test(s.photo_url || "") ? s.photo_url : siteBase(env) + "/og.png";
  const ld = { "@context": "https://schema.org", "@type": "Person", name: s.public_name, description: clip(s.headline || s.bio, 300), url: pageUrl, image: img, jobTitle: "Palestrante" };
  if (s.city) ld.address = { "@type": "PostalAddress", addressLocality: s.city, addressRegion: s.uf || undefined, addressCountry: "BR" };
  if (Array.isArray(s.categories) && s.categories.length) ld.knowsAbout = s.categories;
  const tags = [
    `<link rel="canonical" href="${escHtml(pageUrl)}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="SpeakerConnect">`,
    `<meta property="og:title" content="${escHtml(s.public_name + " | Palestrante")}">`,
    `<meta property="og:description" content="${escHtml(desc)}">`,
    `<meta property="og:url" content="${escHtml(pageUrl)}">`,
    `<meta property="og:image" content="${escHtml(img)}">`,
    `<meta property="og:locale" content="pt_BR">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
  ].join("\n");
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escHtml(desc)}">`)
    .replace("</head>", tags + "\n</head>");
}

async function profilePage(request, env) {
  const url = new URL(request.url);
  // Endereço antigo (.html): manda para o endereço limpo, mantendo o ?id=.
  if (url.pathname.endsWith(".html")) return new Response(null, { status: 301, headers: { Location: "/palestrante" + url.search } });
  const pretty = url.pathname.match(PRETTY);
  const res = await env.ASSETS.fetch(new Request(new URL("/palestrante", url), request));
  if (!res.ok || !/text\/html/.test(res.headers.get("content-type") || "") || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res;
  const id = url.searchParams.get("id") || "";
  if (!pretty && !UUID.test(id)) return notFoundPage(res);
  let s = null;
  const filter = pretty ? `id_short=eq.${pretty[2]}` : `id=eq.${id}`;
  try { s = (await publicSpeakers(env, `select=${SPEAKER_SEO_COLS}&${filter}&status=eq.approved&limit=1`))[0] || null; }
  catch (e) { console.error("perfil: prévia falhou:", e && e.message); return res; }
  // Perfil que não existe (ou saiu do ar): 404 de verdade, para o Google não guardar uma página vazia ("soft 404").
  if (!s || !s.public_name) return notFoundPage(res);
  // ?id=... ou nome desatualizado: manda (301) para o endereço com o nome, que é o oficial.
  const path = spPath(s);
  if (url.pathname !== path) return new Response(null, { status: 301, headers: { Location: path, "Cache-Control": "public, max-age=300" } });
  const html = speakerBody(speakerMeta(await res.text(), s, siteBase(env) + path, env), s);
  const headers = new Headers(res.headers);
  headers.delete("content-length"); headers.delete("etag");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(html, { status: 200, headers });
}

const STATIC_PAGES = ["/", "/sobre", "/entidades", "/palestras", "/campanhas", "/termos", "/privacidade", "/termo-palestrante"];
async function sitemap(request, env) {
  const base = siteBase(env);
  let rows = [];
  let cats = [];
  try {
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      rows = await publicSpeakers(env, "select=id,public_name,updated_at&status=eq.approved&order=updated_at.desc&limit=5000");
      cats = (await publicSpeakers(env, "select=name&active=eq.true&order=sort", "categories")).map((c) => c.name).filter(Boolean);
    }
  }
  catch (e) { console.error("sitemap: falhou:", e && e.message); return env.ASSETS.fetch(request); }
  const urls = STATIC_PAGES.map((p) => `  <url><loc>${base}${p}</loc></url>`)
    .concat(cats.map((c) => `  <url><loc>${base}/palestras/${slugify(c)}</loc></url>`))
    .concat(rows.filter((r) => UUID.test(r.id || "")).map((r) => `  <url><loc>${base}${spPath(r)}</loc>${r.updated_at ? `<lastmod>${String(r.updated_at).slice(0, 10)}</lastmod>` : ""}</url>`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

// ---------- lembrete de perfil incompleto (roda 1x por dia pelo agendador do Cloudflare) ----------
// 1º lembrete: 1 dia depois do cadastro. 2º: 3 dias depois do 1º. Depois disso, para.
const DAY = 864e5;
const REMINDER_COLS = "id,public_name,headline,bio,categories,topics,city,fee_from_cents,photo_url,created_at,profile_reminders,profile_reminded_at";

export function missingProfile(s, doc) {
  const m = [];
  if (!s.photo_url) m.push("foto");
  if (!s.headline) m.push("título (uma frase sobre o que você faz)");
  if (!s.bio || String(s.bio).trim().length < 80) m.push("apresentação (sua experiência e trajetória)");
  if (!Array.isArray(s.categories) || !s.categories.length) m.push("temas");
  if (!s.topics) m.push("suas palestras (títulos e um resumo de cada)");
  if (!s.city) m.push("cidade");
  if (!s.fee_from_cents) m.push("valor de referência");
  if (!doc || !doc.front_path) m.push("foto do documento (só a equipe vê)");
  if (!doc || !doc.terms_version) m.push("aceite do termo do palestrante");
  return m;
}

export function reminderDue(s, now) {
  const n = Number(s.profile_reminders) || 0;
  if (n === 0) return now - Date.parse(s.created_at) >= DAY;
  if (n === 1) return now - Date.parse(s.profile_reminded_at || 0) >= 3 * DAY;
  return false;
}

export function reminderMail(env, s, p, miss) {
  const second = (Number(s.profile_reminders) || 0) >= 1;
  const nome = first(p.name || s.public_name) || "tudo bem";
  const abre = second
    ? "Passando para lembrar: seu perfil no SpeakerConnect ainda está em rascunho, e as empresas só encontram perfis aprovados."
    : "Obrigado por se cadastrar no SpeakerConnect! Seu perfil ainda está em rascunho, e as empresas só encontram perfis aprovados.";
  const meio = miss.length
    ? "Falta completar:\n" + miss.map((x) => "• " + x).join("\n") + '\n\nDepois é só tocar em "Salvar e enviar para análise".'
    : 'Está tudo preenchido! Só falta tocar em "Salvar e enviar para análise".';
  return {
    to: p.email,
    subject: second ? "Seu perfil de palestrante ainda não está no ar" : "Falta pouco para seu perfil aparecer para as empresas",
    text: `Olá, ${nome}!\n\n${abre}\n\n${meio} Nossa equipe revisa em até 2 dias úteis.\n\nCompletar agora: ${siteBase(env)}/app/#/perfil\n\nPrecisa de ajuda? É só responder este e-mail.\n\nVocê recebe este e-mail porque criou uma conta de palestrante no ${BRAND}.`,
  };
}

export async function profileReminders(env, now = Date.now()) {
  if (!configured(env) || !env.RESEND_API_KEY) return 0;
  const rows = await sb(env, `/rest/v1/speakers?status=eq.draft&profile_reminders=lt.2&select=${REMINDER_COLS}&order=created_at.asc&limit=300`);
  const due = (Array.isArray(rows) ? rows : []).filter((s) => UUID.test(s.id || "") && reminderDue(s, now)).slice(0, 50);
  if (!due.length) return 0;
  const ids = due.map((s) => s.id).join(",");
  const [docs, profs] = await Promise.all([
    sb(env, `/rest/v1/speaker_documents?speaker_id=in.(${ids})&select=speaker_id,front_path,terms_version`),
    sb(env, `/rest/v1/profiles?id=in.(${ids})&select=id,name,email`),
  ]);
  let sent = 0;
  for (const s of due) {
    const p = (profs || []).find((x) => x.id === s.id);
    if (!p || !p.email) continue;
    const mail = reminderMail(env, s, p, missingProfile(s, (docs || []).find((d) => d.speaker_id === s.id)));
    // Marca antes de enviar: se a marcação falhar, não envia (nunca manda o mesmo lembrete duas vezes).
    try {
      const n = Number(s.profile_reminders) || 0;
      const upd = await sb(env, `/rest/v1/speakers?id=eq.${s.id}&status=eq.draft&profile_reminders=eq.${n}`, {
        method: "PATCH", body: { profile_reminders: n + 1, profile_reminded_at: new Date(now).toISOString() }, prefer: "return=representation",
      });
      if (!Array.isArray(upd) || !upd.length) continue;
    } catch (e) { console.error("lembrete: não consegui marcar", s.id, e && e.message); continue; }
    if (await sendMail(env, mail)) sent++;
  }
  return sent;
}

// ---------- lembrete do saldo (sinal pago, saldo em aberto) ----------
// Etapa 0: 7 dias antes do vencimento. Etapa 1: 1 dia antes. Etapa 2: vencido (avisa também palestrante e equipe). Depois, para.
export function balanceStep(q, today) {
  if (!q.balance_due_on) return null;
  const left = daysBetween(today, String(q.balance_due_on).slice(0, 10));
  const n = Number(q.balance_reminders) || 0;
  if (n === 0 && left <= 7 && left >= 0) return left <= 1 ? 1 : 0;
  if (n <= 1 && left <= 1 && left >= 0) return 1;
  if (n <= 2 && left < 0) return 2;
  return null;
}

export function balanceMails(env, q, c, s, step) {
  const site = siteBase(env), link = `${site}/app/#/pedido?id=${q.id}`;
  const saldo = brl(q.amount_cents - q.deposit_cents), venc = fmtDate(q.balance_due_on), ev = q.event_date ? fmtDate(q.event_date) : "a combinar";
  const titulo = line(q.title, 120);
  const foot = `\n\nAbrir o ${BRAND}: ${site}/app/\n\nVocê recebe este e-mail porque tem cadastro no ${BRAND}.`;
  const out = [];
  if (step < 2) {
    if (c) out.push({ to: c.email, subject: step === 0 ? `Saldo da palestra vence em ${venc}` : `O saldo da palestra vence ${daysBetween(todaySP(), String(q.balance_due_on).slice(0, 10)) === 0 ? "hoje" : "amanhã"}`,
      text: `Olá, ${first(c.name)}!\n\nLembrete: o saldo de ${saldo} da palestra "${titulo}" com ${line(q.speaker_name, 80)} (evento em ${ev}) vence em ${venc}.` +
            `\n\nPague por Pix ou cartão pelo app: ${link}` + foot });
    return out;
  }
  if (c) out.push({ to: c.email, subject: `Saldo em atraso: ${line(q.title, 80)}`,
    text: `Olá, ${first(c.name)}!\n\nO saldo de ${saldo} da palestra "${titulo}" (evento em ${ev}) venceu em ${venc} e ainda não foi pago.` +
          `\n\nPara manter a palestra confirmada, pague pelo app: ${link}\n\nSe houve algum problema, responda este e-mail.` + foot });
  if (s) out.push({ to: s.email, subject: `Saldo ainda não pago: ${line(q.title, 80)}`,
    text: `Olá, ${first(s.name)}!\n\n${line(q.company_name, 80)} ainda não pagou o saldo de ${saldo} da palestra "${titulo}" (evento em ${ev}), que venceu em ${venc}.` +
          `\nJá cobramos a empresa e a equipe está acompanhando. Avisamos você assim que for pago.` + foot });
  out.push({ to: env.NOTIFY_EMAIL, subject: `Saldo atrasado: ${line(q.title, 60)} - ${saldo}`,
    text: `Empresa: ${q.company_name} (${c ? c.email : "?"})\nPalestrante: ${q.speaker_name}\nEvento: ${ev}\nSaldo: ${saldo}, venceu em ${venc}.\n\nVeja em ${site}/equipe/ > Financeiro.` });
  return out;
}

export async function balanceReminders(env, now = Date.now()) {
  if (!configured(env) || !env.RESEND_API_KEY) return 0;
  const today = todaySP(now);
  const rows = await sb(env, `/rest/v1/quotes?status=eq.paid&deposit_cents=not.is.null&balance_paid_at=is.null&balance_reminders=lt.3&select=id,title,company_id,speaker_id,company_name,speaker_name,event_date,amount_cents,deposit_cents,balance_due_on,balance_reminders&limit=300`);
  let sent = 0;
  for (const q of Array.isArray(rows) ? rows : []) {
    const step = balanceStep(q, today);
    if (step === null) continue;
    try {
      const upd = await sb(env, `/rest/v1/quotes?id=eq.${q.id}&balance_reminders=eq.${Number(q.balance_reminders) || 0}&balance_paid_at=is.null`, {
        method: "PATCH", body: { balance_reminders: step + 1 }, prefer: "return=representation" });
      if (!Array.isArray(upd) || !upd.length) continue;
    } catch (e) { console.error("saldo: não consegui marcar", q.id, e && e.message); continue; }
    const [c, s] = await Promise.all([
      one(env, `/rest/v1/profiles?id=eq.${q.company_id}&select=name,email`),
      one(env, `/rest/v1/profiles?id=eq.${q.speaker_id}&select=name,email`),
    ]);
    for (const m of balanceMails(env, q, c, s, step)) if (m.to && (await sendMail(env, m))) sent++;
  }
  return sent;
}

// ---------- POST /api/indicacao: "Nós indicamos" (formulário público do site) ----------
const EMAIL_OK = /^[^\s@<>(),;:"]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i;
export function cleanLead(b, today = todaySP()) {
  const t = (k, n) => line(b && b[k], n).trim();
  const lead = {
    name: t("name", 120), company: t("company", 160), email: t("email", 200).toLowerCase(), phone: t("phone", 30) || null,
    theme: t("theme", 80), place: t("place", 120) || null, budget: t("budget", 40) || null,
    message: String((b && b.message) || "").replace(/\r/g, "").trim().slice(0, 2000) || null, source: t("source", 200) || null,
    format: ["presencial", "online", "indefinido"].includes(b && b.format) ? b.format : null,
    audience: Number.isInteger(Number(b && b.audience)) && Number(b.audience) > 0 && Number(b.audience) <= 100000 ? Number(b.audience) : null,
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(String((b && b.event_date) || "")) && !isNaN(Date.parse(b.event_date)) ? b.event_date : null,
    kind: b && b.kind === "entidade" ? "entidade" : "indicacao", role: t("role", 120) || null,
  };
  if (lead.kind === "entidade") { lead.theme = lead.theme || "Parceria com entidade"; lead.event_date = null; lead.format = null; lead.budget = null; }
  if (lead.event_date && lead.event_date < today) return { error: "A data do evento já passou." };
  if (lead.name.length < 2) return { error: "Informe seu nome." };
  if (lead.company.length < 2) return { error: lead.kind === "entidade" ? "Informe o nome da entidade." : "Informe a empresa." };
  if (!EMAIL_OK.test(lead.email)) return { error: "Informe um e-mail válido." };
  if (!lead.theme) return { error: "Escolha o tema." };
  return { lead };
}

async function sha256hex(x) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function indicacaoPost({ request, env, ctx }) {
  if (!configured(env)) return json(503, { error: "Servidor não configurado." });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(siteUrl(env, request)).origin && origin !== new URL(request.url).origin) return json(403, { error: "Origem não permitida." });
  const b = await readBody(request, 6000);
  if (!b) return json(400, { error: "Pedido inválido." });
  // Robôs: campo escondido preenchido ou formulário enviado rápido demais. Responde "ok" e não grava nada.
  if (b.website || (Number(b.elapsed) > 0 && Number(b.elapsed) < 2500)) return json(200, { ok: true });
  if (env.TURNSTILE_SECRET) {
    const f = new FormData();
    f.append("secret", env.TURNSTILE_SECRET); f.append("response", String(b.captcha || ""));
    const ip0 = request.headers.get("cf-connecting-ip"); if (ip0) f.append("remoteip", ip0);
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f }).then((r) => r.json()).catch(() => ({}));
    if (!v.success) return json(400, { error: "Confirme que você não é um robô e envie de novo." });
  }
  const c = cleanLead(b);
  if (c.error) return json(400, { error: c.error });
  const lead = c.lead;
  lead.ip_hash = await sha256hex("sc-lead:" + (request.headers.get("cf-connecting-ip") || "?") + ":" + (env.SUPABASE_URL || ""));
  const since = new Date(Date.now() - 3600e3).toISOString();
  const recent = await sb(env, `/rest/v1/leads?ip_hash=eq.${lead.ip_hash}&created_at=gt.${encodeURIComponent(since)}&select=id`);
  if (Array.isArray(recent) && recent.length >= 3) return json(429, { error: "Recebemos vários pedidos seus agora há pouco. Fale com a gente pelo WhatsApp." });
  const saved = await sb(env, "/rest/v1/leads", { method: "POST", body: lead, prefer: "return=representation" });
  const id = Array.isArray(saved) && saved[0] ? saved[0].id : null;
  const site = siteUrl(env, request);
  const quando = lead.event_date ? fmtDate(lead.event_date) : "a definir";
  const fmt = { presencial: "Presencial", online: "Online", indefinido: "A definir" }[lead.format] || "-";
  if (lead.kind === "entidade") {
    later(ctx, sendMail(env, { to: env.NOTIFY_EMAIL, replyTo: lead.email, subject: `Entidade quer parceria: ${line(lead.company, 80)}`,
      text: `Entidade: ${lead.company}\nNome: ${lead.name}${lead.role ? " (" + lead.role + ")" : ""}\nE-mail: ${lead.email}\nWhatsApp: ${lead.phone || "-"}\n` +
            `Cidade: ${lead.place || "-"}\nAssociados: ${lead.audience || "-"}\nInteresse: ${lead.theme}\n\nMensagem:\n${lead.message || "-"}\n\n` +
            `Responda este e-mail para falar direto com a pessoa. Veja todos em ${site}/equipe/ > Indicações.` }));
    later(ctx, sendMail(env, { to: lead.email, replyTo: env.NOTIFY_EMAIL, subject: `Recebemos seu contato - ${BRAND}`,
      text: `Olá, ${first(lead.name)}!\n\nObrigado pelo interesse em uma parceria entre ${lead.company} e o ${BRAND}.\n` +
            `Vamos entrar em contato em até 1 dia útil para conversar sobre como apoiar a entidade e os associados.\n\n` +
            `Enquanto isso, conheça os palestrantes em ${site}/#palestrantes\n\nEquipe ${BRAND}` }));
    return json(200, { ok: true, id });
  }
  later(ctx, sendMail(env, { to: env.NOTIFY_EMAIL, replyTo: lead.email, subject: `Pedido de indicação: ${line(lead.theme, 60)} - ${line(lead.company, 60)}`,
    text: `Nome: ${lead.name}\nEmpresa: ${lead.company}\nE-mail: ${lead.email}\nWhatsApp: ${lead.phone || "-"}\n\nTema: ${lead.theme}\nData: ${quando}\n` +
          `Formato: ${fmt}\nLocal: ${lead.place || "-"}\nPúblico: ${lead.audience ? lead.audience + " pessoas" : "-"}\nOrçamento: ${lead.budget || "-"}\n\n` +
          `Detalhes:\n${lead.message || "-"}\n\nResponda este e-mail para falar direto com a pessoa. Veja todos em ${site}/equipe/ > Indicações.` }));
  later(ctx, sendMail(env, { to: lead.email, replyTo: env.NOTIFY_EMAIL, subject: `Recebemos seu pedido de indicação - ${BRAND}`,
    text: `Olá, ${first(lead.name)}!\n\nRecebemos seu pedido de indicação de palestrante sobre "${lead.theme}"` + (lead.event_date ? ` para ${quando}` : "") + `.\n` +
          `Nossa equipe vai analisar e enviar sugestões de palestrantes em até 1 dia útil, por e-mail` + (lead.phone ? " ou WhatsApp" : "") + `.\n\n` +
          `Enquanto isso, você pode ver os perfis em ${site}/#palestrantes\n\nSe quiser complementar alguma informação, é só responder este e-mail.\n\nEquipe ${BRAND}` }));
  return json(200, { ok: true, id });
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
  "/api/indicacao": { POST: indicacaoPost },
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
    if (pathname === "/tema" || pathname === "/tema.html") return Response.redirect(new URL("/palestras", request.url).toString(), 301);
    if (pathname === "/palestras" || pathname.startsWith("/palestras/") || pathname === "/campanhas") {
      try { return await themePages(request, env); } catch (e) { console.error("temas falhou:", e && e.message); return env.ASSETS.fetch(request); }
    }
    if (pathname === "/palestrante" || pathname === "/palestrante.html" || PRETTY.test(pathname)) {
      try { return await profilePage(request, env); } catch (e) { console.error("perfil falhou:", e && e.message); return env.ASSETS.fetch(request); }
    }
    if (pathname === "/sitemap.xml") return sitemap(request, env);
    if (pathname === "/" && request.method === "GET") {
      try { return await homePage(request, env); } catch (e) { console.error("home falhou:", e && e.message); return env.ASSETS.fetch(request); }
    }
    return env.ASSETS.fetch(request);
  },
  // Agendador do Cloudflare (ver "triggers" no wrangler.jsonc): lembretes diários de perfil incompleto.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      profileReminders(env).then((n) => console.log("lembretes de perfil enviados:", n))
        .catch((e) => console.error("lembretes de perfil falharam:", e && e.message)),
      balanceReminders(env).then((n) => console.log("lembretes de saldo enviados:", n))
        .catch((e) => console.error("lembretes de saldo falharam:", e && e.message)),
    ]));
  },
};
