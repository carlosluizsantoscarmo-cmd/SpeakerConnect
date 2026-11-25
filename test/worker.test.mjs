// Testes do servidor com Supabase, Mercado Pago e Resend de mentira. Rodar: node --test test/worker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker, { mpSignatureValid, split, brl, seal, makeState, chargePlan, balanceStep, balanceMails, addDays, todaySP, cleanLead } from "../worker.js";

const SPEAKER = "00000000-0000-0000-0000-000000000001";
const COMPANY = "00000000-0000-0000-0000-000000000003";
const ADMIN = "00000000-0000-0000-0000-00000000000a";
const QUOTE = "10000000-0000-0000-0000-000000000001";

async function setup({ speakerStatus = "approved", quoteStatus = "accepted", mpAmount, connected = true, cardStatus = "approved", eventDate = "2026-11-20" } = {}) {
  const db = {
    profiles: [
      { id: SPEAKER, role: "speaker", name: "Ana Palestrante", email: "ana@x.com", phone: "27999990001" },
      { id: COMPANY, role: "company", name: "Carla RH", email: "rh@x.com", phone: "27999990003" },
      { id: ADMIN, role: "admin", name: "Equipe", email: "equipe@x.com" },
    ],
    speakers: [{ id: SPEAKER, public_name: "Ana Palestrante", status: speakerStatus, verified_until: null }],
    quotes: [{ id: QUOTE, company_id: COMPANY, speaker_id: SPEAKER, title: "SIPAT 2026", status: quoteStatus, amount_cents: 800000,
               company_name: "Empresa Boa", speaker_name: "Ana Palestrante", event_date: eventDate, format: "presencial", city: "Serra", uf: "ES" }],
    quote_messages: [],
    payments: [],
    speaker_mp_accounts: [],
    speaker_documents: [{ speaker_id: SPEAKER, doc_type: "CNH", front_path: SPEAKER + "/doc-frente.jpg", back_path: null }],
  };
  const tokens = { "a.b.ana": SPEAKER, "a.b.carla": COMPANY, "a.b.equipe": ADMIN };
  const mails = [], deleted = [], mpCalls = [], mpPayments = {};
  let seq = 0, mpSeq = 555000100;
  const env = {
    SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    MP_ACCESS_TOKEN: "mp", MP_PUBLIC_KEY: "PUB-PLATAFORMA", MP_WEBHOOK_SECRET: "whsecret", RESEND_API_KEY: "re", MAIL_FROM: "SC <a@b.c>", NOTIFY_EMAIL: "equipe@x.com",
    NOTIFY_SECRET: "segredo-de-teste-123456", SITE_URL: "https://site.test", COMMISSION_PCT: "15", VERIFIED_PRICE_CENTS: "9990", VERIFIED_DAYS: "365",
    ALLOWED_ORIGINS: "https://site.test",
    MP_CLIENT_ID: "123", MP_CLIENT_SECRET: "cs", MP_TOKEN_KEY: "chave-de-teste-com-mais-de-24-caracteres",
    ASSETS: { fetch: () => new Response("pagina") },
  };
  if (connected) db.speaker_mp_accounts.push({ speaker_id: SPEAKER, mp_user_id: "777", public_key: "PUB-ANA", access_token: await seal(env, "SELLER-TOKEN"), refresh_token: null, expires_at: null });
  const filterRows = (rows, params) => rows.filter((r) => {
    for (const [k, v] of params) {
      if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
      if (k === "or") {
        const ids = [...v.matchAll(/(\w+)\.eq\.([\w-]+)/g)];
        if (!ids.some(([, f, x]) => String(r[f]) === x)) return false;
        continue;
      }
      const [, val] = v.split(/^eq\./);
      if (String(r[k]) !== val) return false;
    }
    return true;
  });
  globalThis.fetch = async (url, opt = {}) => {
    const u = new URL(url);
    const method = opt.method || "GET";
    const body = opt.body ? JSON.parse(opt.body) : null;
    if (u.host === "sb.test" && u.pathname === "/auth/v1/user") {
      const id = tokens[(opt.headers.Authorization || "").slice(7)];
      return id ? Response.json({ id, email: db.profiles.find((p) => p.id === id).email }) : new Response("no", { status: 401 });
    }
    if (u.host === "sb.test" && u.pathname.startsWith("/auth/v1/admin/users/")) { deleted.push(u.pathname.split("/").pop()); return Response.json({}); }
    if (u.host === "sb.test" && u.pathname === "/storage/v1/object/documentos" && method === "DELETE") { deleted.push(...body.prefixes); return Response.json([]); }
    if (u.host === "sb.test" && u.pathname.startsWith("/rest/v1/")) {
      assert.equal(opt.headers.Authorization, "Bearer service");
      const table = db[u.pathname.slice(9)];
      if (method === "GET") return Response.json(filterRows(table, u.searchParams));
      if (method === "POST" && u.pathname.endsWith("speaker_mp_accounts")) { const i = table.findIndex((r) => r.speaker_id === body.speaker_id); if (i >= 0) table[i] = body; else table.push(body); return new Response(null, { status: 201 }); }
      if (method === "POST") { const row = { id: `20000000-0000-0000-0000-00000000000${++seq}`, status: "pending", commission_cents: 0, payout_cents: 0, split: false, created_at: new Date().toISOString(), ...body }; table.push(row); return Response.json([row]); }
      if (method === "PATCH") { for (const r of filterRows(table, u.searchParams)) Object.assign(r, body); return new Response(null, { status: 204 }); }
    }
    if (u.host === "api.mercadopago.com") mpCalls.push({ path: u.pathname, method, auth: opt.headers.Authorization, headers: opt.headers, body });
    if (u.host === "api.mercadopago.com" && u.pathname === "/oauth/token") return Response.json({ access_token: "NOVO-SELLER", refresh_token: "R", user_id: 888, public_key: "PUB-NOVO", expires_in: 15552000 });
    if (u.host === "api.mercadopago.com" && u.pathname.endsWith("/refunds")) return Response.json({ id: 1, status: "approved" });
    if (u.host === "api.mercadopago.com" && u.pathname === "/v1/payments" && method === "POST") {
      const pix = body.payment_method_id === "pix";
      const m = { id: ++mpSeq, status: pix ? "pending" : cardStatus, status_detail: cardStatus === "rejected" ? "cc_rejected_insufficient_amount" : "accredited",
        currency_id: "BRL", transaction_amount: (mpAmount ?? Math.round(body.transaction_amount * 100)) / 100, external_reference: body.external_reference, _owner: opt.headers.Authorization,
        ...(pix ? { date_of_expiration: new Date(Date.now() + 1800000).toISOString(), point_of_interaction: { transaction_data: { qr_code: "PIX-COPIA-E-COLA", qr_code_base64: "QRBASE64" } } } : {}) };
      mpPayments[m.id] = m;
      return Response.json(m, { status: 201 });
    }
    if (u.host === "api.mercadopago.com" && u.pathname.startsWith("/v1/payments/")) {
      const m = mpPayments[u.pathname.split("/").pop()];
      if (!m || opt.headers.Authorization !== m._owner) return new Response("{}", { status: 404 }); // cada conta só vê os próprios pagamentos
      return Response.json(m);
    }
    if (u.host === "api.resend.com") { mails.push(body); return Response.json({ id: "m" }); }
    throw new Error("rede inesperada: " + url);
  };
  const call = (path, { method = "GET", token, body, headers = {} } = {}) => {
    const h = { Origin: "https://site.test", ...headers };
    if (token) h.Authorization = "Bearer " + token;
    return worker.fetch(new Request("https://site.test" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} });
  };
  return { db, env, mails, deleted, call, mpCalls, mpPayments };
}

async function signed(env, dataId) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`id:${dataId};request-id:req-1;ts:${ts};`));
  return { "x-signature": `ts=${ts},v1=` + [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, "0")).join(""), "x-request-id": "req-1" };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const card = { method: "card", token: "card-token-123", installments: 1, payment_method_id: "visa", device_id: "device-abc-123" };

test("valores e comissão", () => {
  assert.equal(brl(800000), "R$ 8.000,00");
  assert.deepEqual(split(800000, "15"), { commission: 120000, payout: 680000 });
});

test("cartão: cobrança na conta do palestrante, comissão por application_fee, contrato liberado", async () => {
  const t = await setup();
  const r = await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, amount_cents: 1, ...card } });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.ok, true);
  const mpc = t.mpCalls.find((c) => c.path === "/v1/payments" && c.method === "POST");
  assert.equal(mpc.auth, "Bearer SELLER-TOKEN", "cobrança criada na conta do palestrante");
  assert.equal(mpc.body.transaction_amount, 8000, "valor vem do banco, não do navegador");
  assert.equal(mpc.body.application_fee, 1200, "comissão da plataforma via Split");
  assert.equal(mpc.headers["X-meli-session-id"], "device-abc-123");
  const p = t.db.payments[0];
  assert.equal(p.status, "paid");
  assert.equal(p.split, true);
  assert.ok(p.payout_done_at, "sem repasse manual");
  assert.equal(t.db.quotes[0].status, "paid");
  await tick();
  assert.deepEqual(t.mails.map((m) => m.to[0]).sort(), ["ana@x.com", "equipe@x.com", "rh@x.com"]);
  assert.match(t.mails.find((m) => m.to[0] === "ana@x.com").text, /R\$ 6\.800,00.*direto na sua conta do Mercado Pago/);
});

test("cartão recusado: mensagem clara e pedido continua aguardando pagamento", async () => {
  const t = await setup({ cardStatus: "rejected" });
  const d = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } })).json();
  assert.equal(d.ok, false);
  assert.match(d.error, /Limite insuficiente/);
  assert.equal(t.db.quotes[0].status, "accepted");
});

test("Pix: devolve QR Code, reaproveita o mesmo código e confirma pelo aviso do Mercado Pago", async () => {
  const t = await setup();
  const d = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "pix" } })).json();
  assert.equal(d.status, "pending");
  assert.equal(d.pix.code, "PIX-COPIA-E-COLA");
  assert.equal(d.pix.qr_base64, "QRBASE64");
  const again = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "pix" } })).json();
  assert.equal(again.id, d.id, "não cria um segundo Pix");
  assert.equal(t.mpCalls.filter((c) => c.path === "/v1/payments").length, 1);
  // a empresa paga no banco; o Mercado Pago avisa
  const mpId = t.db.payments[0].mp_payment_id;
  t.mpPayments[mpId].status = "approved";
  const w = await t.call(`/api/mp-webhook?data.id=${mpId}&type=payment`, { method: "POST", body: { type: "payment", data: { id: mpId } }, headers: await signed(t.env, mpId) });
  assert.equal(w.status, 200);
  assert.equal(t.db.quotes[0].status, "paid");
  // o app consulta o status
  const s = await (await t.call(`/api/pagamento?id=${d.id}`, { token: "a.b.carla" })).json();
  assert.equal(s.status, "paid");
  assert.equal((await t.call(`/api/pagamento?id=${d.id}`, { token: "a.b.ana" })).status, 404, "outra pessoa não consulta");
});

test("Pix: se o aviso atrasar, a consulta do app confirma direto na API", async () => {
  const t = await setup();
  const d = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "pix" } })).json();
  t.mpPayments[t.db.payments[0].mp_payment_id].status = "approved";
  const s = await (await t.call(`/api/pagamento?id=${d.id}`, { token: "a.b.carla" })).json();
  assert.equal(s.status, "paid");
  assert.equal(t.db.quotes[0].status, "paid");
});

test("barreiras: sem login, pedido de outra empresa, proposta não aceita, origem estranha, valor adulterado", async () => {
  let t = await setup();
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", body: { kind: "quote", quote_id: QUOTE, method: "pix" } })).status, 401);
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.ana", body: { kind: "quote", quote_id: QUOTE, method: "pix" } })).status, 404);
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "boleto" } })).status, 400);
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "pix" }, headers: { Origin: "https://ruim.test" } })).status, 403);
  t = await setup({ quoteStatus: "proposed" });
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "pix" } })).status, 400);
  t = await setup({ mpAmount: 100 });
  await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } });
  assert.equal(t.db.quotes[0].status, "accepted", "valor diferente não libera");
});

test("webhook sem assinatura é recusado", async () => {
  const t = await setup();
  assert.equal((await t.call("/api/mp-webhook?data.id=1&type=payment", { method: "POST", body: {} })).status, 401);
  assert.equal(await mpSignatureValid({ secret: "s", signature: "ts=1,v1=abc", requestId: "r", dataId: "1" }), false);
});

test("palestrante sem conta Mercado Pago: empresa não consegue pagar", async () => {
  const t = await setup({ connected: false });
  const r = await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, method: "pix" } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "speaker_not_connected");
  assert.equal(t.db.payments.length, 0);
});

test("config do cartão: chave pública do palestrante na contratação, da plataforma no selo", async () => {
  const t = await setup();
  assert.equal((await (await t.call(`/api/mp/config?quote_id=${QUOTE}`, { token: "a.b.carla" })).json()).public_key, "PUB-ANA");
  assert.equal((await (await t.call(`/api/mp/config`, { token: "a.b.ana" })).json()).public_key, "PUB-PLATAFORMA");
  assert.equal((await t.call(`/api/mp/config?quote_id=${QUOTE}`)).status, 401);
});

test("selo: só palestrante aprovado; cobrado na conta da plataforma; vale 1 ano", async () => {
  let t = await setup({ speakerStatus: "pending" });
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.ana", body: { kind: "verified", method: "pix" } })).status, 400);
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "verified", method: "pix" } })).status, 403);
  t = await setup();
  const d = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.ana", body: { kind: "verified", ...card } })).json();
  assert.equal(d.ok, true);
  const mpc = t.mpCalls.find((c) => c.path === "/v1/payments");
  assert.equal(mpc.auth, "Bearer mp");
  assert.equal(mpc.body.application_fee, undefined);
  assert.equal(mpc.body.transaction_amount, 99.9);
  const days = (new Date(t.db.speakers[0].verified_until) - Date.now()) / 864e5;
  assert.ok(days > 364 && days < 366);
  assert.equal((await t.call("/api/mp/pagar", { method: "POST", token: "a.b.ana", body: { kind: "verified", method: "pix" } })).status, 400, "selo já ativo");
});

test("conectar conta: só palestrante, state assinado, token cifrado e chave pública guardada", async () => {
  const t = await setup({ connected: false });
  assert.equal((await t.call("/api/mp/conectar", { method: "POST", token: "a.b.carla" })).status, 403);
  const { url } = await (await t.call("/api/mp/conectar", { method: "POST", token: "a.b.ana" })).json();
  const u = new URL(url);
  assert.equal(u.searchParams.get("redirect_uri"), "https://site.test/api/mp-oauth/callback");
  const fake = await makeState({ MP_TOKEN_KEY: "outra-chave-qualquer-com-24-chars" }, COMPANY);
  let cb = await t.call("/api/mp-oauth/callback?code=abc&state=" + encodeURIComponent(fake));
  assert.match(cb.headers.get("Location"), /mp=erro/);
  cb = await t.call("/api/mp-oauth/callback?code=abc&state=" + encodeURIComponent(u.searchParams.get("state")));
  assert.match(cb.headers.get("Location"), /\/app\/#\/conta\?mp=ok/);
  const acc = t.db.speaker_mp_accounts[0];
  assert.equal(acc.speaker_id, SPEAKER);
  assert.equal(acc.public_key, "PUB-NOVO");
  assert.ok(acc.access_token.startsWith("v1.") && !acc.access_token.includes("NOVO-SELLER"), "token cifrado");
});

test("reembolso: só a equipe; usa a conta do palestrante e cancela o pedido", async () => {
  const t = await setup();
  await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } });
  const id = t.db.payments[0].id;
  assert.equal((await t.call("/api/reembolso", { method: "POST", token: "a.b.carla", body: { payment_id: id } })).status, 403);
  assert.equal((await t.call("/api/reembolso", { method: "POST", token: "a.b.equipe", body: { payment_id: id } })).status, 200);
  assert.equal(t.mpCalls.find((c) => c.path.endsWith("/refunds")).auth, "Bearer SELLER-TOKEN");
  assert.equal(t.db.payments[0].status, "refunded");
  assert.equal(t.db.quotes[0].status, "cancelled");
});

test("aviso do Supabase: exige a senha e manda o e-mail certo", async () => {
  const t = await setup({ quoteStatus: "requested" });
  assert.equal((await t.call("/api/aviso", { method: "POST", body: { type: "pedido_novo", id: QUOTE } })).status, 401);
  const r = await t.call("/api/aviso", { method: "POST", body: { type: "pedido_novo", id: QUOTE }, headers: { "x-sc-secret": "segredo-de-teste-123456" } });
  assert.equal((await r.json()).enviados, 2); // palestrante + cópia para a equipe
  await tick();
  assert.equal(t.mails[0].to[0], "ana@x.com");
  assert.match(t.mails[0].text, /20\/11\/2026/);
  assert.match(t.mails[1].subject, /^Novo pedido para /);
  assert.notEqual(t.mails[1].to[0], "ana@x.com");
});

test("excluir conta: só a própria, e não com palestra paga em aberto", async () => {
  let t = await setup({ quoteStatus: "paid" });
  assert.equal((await t.call("/api/conta", { method: "DELETE", token: "a.b.carla" })).status, 400);
  t = await setup({ quoteStatus: "done" });
  assert.equal((await t.call("/api/conta", { method: "DELETE" })).status, 401);
  assert.equal((await t.call("/api/conta", { method: "DELETE", token: "a.b.carla" })).status, 200);
  assert.deepEqual(t.deleted, [COMPANY]);
});

test("endereços desconhecidos e páginas", async () => {
  const t = await setup();
  assert.equal((await t.call("/api/nada")).status, 404);
  assert.equal((await t.call("/api/mp/pagar")).status, 405);
  assert.equal(await (await t.call("/")).text(), "pagina");
});

test("excluir conta do palestrante apaga também o documento", async () => {
  const t = await setup({ quoteStatus: "done" });
  assert.equal((await t.call("/api/conta", { method: "DELETE", token: "a.b.ana" })).status, 200);
  assert.deepEqual(t.deleted, [SPEAKER + "/doc-frente.jpg", SPEAKER]);
});

// ---------- sinal e saldo ----------
const NOW = Date.parse("2026-11-18T15:00:00Z");
test("plano de cobrança: sinal de 30% com evento distante, integral com evento perto ou sem data", () => {
  const env = {};
  const q = { status: "accepted", amount_cents: 800000, event_date: "2027-01-20" };
  assert.deepEqual(chargePlan(env, q, NOW), { stage: "deposit", cents: 240000, due: "2027-01-13" });
  assert.deepEqual(chargePlan(env, { ...q, event_date: "2026-11-25" }, NOW), { stage: "full", cents: 800000 }, "7 dias: integral");
  assert.deepEqual(chargePlan(env, { ...q, event_date: "2026-11-26" }, NOW).stage, "deposit", "8 dias: sinal");
  assert.deepEqual(chargePlan(env, { ...q, event_date: null }, NOW), { stage: "full", cents: 800000 });
  assert.deepEqual(chargePlan(env, { status: "paid", amount_cents: 800000, deposit_cents: 240000, balance_due_on: "2027-01-13" }, NOW), { stage: "balance", cents: 560000, due: "2027-01-13" });
  assert.equal(chargePlan(env, { status: "paid", amount_cents: 800000, deposit_cents: 240000, balance_paid_at: "x" }, NOW), null);
  assert.equal(chargePlan(env, { status: "paid", amount_cents: 800000 }, NOW), null, "pago integral");
  assert.equal(chargePlan({ DEPOSIT_PCT: "50" }, q, NOW).cents, 400000);
});

test("sinal e saldo: duas cobranças, pedido confirmado no sinal e quitado no saldo", async () => {
  const ev = addDays(todaySP(), 60);
  const t = await setup({ eventDate: ev });
  let d = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } })).json();
  assert.equal(d.ok, true);
  let mpc = t.mpCalls.filter((c) => c.path === "/v1/payments" && c.method === "POST")[0];
  assert.equal(mpc.body.transaction_amount, 2400, "sinal de 30%");
  assert.equal(mpc.body.application_fee, 360, "comissão sobre o sinal");
  const q = t.db.quotes[0];
  assert.equal(q.status, "paid", "data confirmada e contato liberado");
  assert.equal(q.deposit_cents, 240000);
  assert.equal(q.balance_due_on, addDays(ev, -7));
  assert.equal(t.db.payments[0].stage, "deposit");
  await tick();
  assert.match(t.mails.find((m) => m.to[0] === "rh@x.com").text, /Saldo: R\$ 5\.600,00/);
  const cfg = await (await t.call("/api/mp/config?quote_id=" + QUOTE, { token: "a.b.carla" })).json();
  assert.deepEqual([cfg.amount_cents, cfg.stage], [560000, "balance"]);
  d = await (await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } })).json();
  assert.equal(d.ok, true);
  mpc = t.mpCalls.filter((c) => c.path === "/v1/payments" && c.method === "POST")[1];
  assert.equal(mpc.body.transaction_amount, 5600, "saldo");
  assert.ok(q.balance_paid_at, "saldo quitado");
  assert.equal(t.db.payments[1].stage, "balance");
  const r = await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } });
  assert.equal(r.status, 400, "nada mais a pagar");
});

test("reembolso com taxa: devolve o sinal menos 10% e cancela o pedido", async () => {
  const t = await setup({ eventDate: addDays(todaySP(), 60) });
  await t.call("/api/mp/pagar", { method: "POST", token: "a.b.carla", body: { kind: "quote", quote_id: QUOTE, ...card } });
  const pay = t.db.payments[0];
  const r = await t.call("/api/reembolso", { method: "POST", token: "a.b.equipe", body: { payment_id: pay.id, fee: true } });
  assert.equal(r.status, 200);
  const rc = t.mpCalls.find((c) => c.path.endsWith("/refunds"));
  assert.deepEqual(rc.body, { amount: 2160 });
  assert.equal(pay.refunded_cents, 216000);
  assert.equal(pay.status, "refunded");
  assert.equal(t.db.quotes[0].status, "cancelled");
  // o aviso do Mercado Pago continua "approved" (devolução parcial): não pode confirmar de novo
  const h = await signed(t.env, pay.mp_payment_id);
  await t.call("/api/mp-webhook?data.id=" + pay.mp_payment_id + "&type=payment", { method: "POST", headers: h, body: { type: "payment", data: { id: pay.mp_payment_id } } });
  assert.equal(pay.status, "refunded");
  assert.equal(t.db.quotes[0].status, "cancelled");
});

test("lembretes do saldo: 7 dias antes, 1 dia antes e vencido", () => {
  const q = { balance_due_on: "2026-12-10", balance_reminders: 0 };
  assert.equal(balanceStep(q, "2026-12-01"), null);
  assert.equal(balanceStep(q, "2026-12-03"), 0);
  assert.equal(balanceStep({ ...q, balance_reminders: 1 }, "2026-12-05"), null);
  assert.equal(balanceStep({ ...q, balance_reminders: 1 }, "2026-12-09"), 1);
  assert.equal(balanceStep({ ...q, balance_reminders: 2 }, "2026-12-11"), 2);
  assert.equal(balanceStep({ ...q, balance_reminders: 3 }, "2026-12-20"), null);
  assert.equal(balanceStep(q, "2026-12-09"), 1, "pulou direto para a véspera");
  const ms = balanceMails({ SITE_URL: "https://s.t", NOTIFY_EMAIL: "eq@x" }, { id: "q", title: "SIPAT", amount_cents: 800000, deposit_cents: 240000, balance_due_on: "2026-12-10", event_date: "2026-12-17", company_name: "Emp", speaker_name: "Ana" },
    { name: "Carla", email: "c@x" }, { name: "Ana", email: "a@x" }, 2);
  assert.deepEqual(ms.map((m) => m.to), ["c@x", "a@x", "eq@x"]);
  assert.match(ms[0].text, /R\$ 5\.600,00.*venceu em 10\/12\/2026/);
});

// ---------- "Nós indicamos" ----------
test("indicação: valida, grava, avisa a equipe e confirma para a empresa", async () => {
  const t = await setup();
  t.db.leads = [];
  const body = { name: "Carla Souza", company: "Porto Serra", email: "RH@Porto.com", phone: "27 99999-0000", theme: "Saúde Mental e NR-1",
    event_date: addDays(todaySP(), 30), format: "presencial", place: "Serra/ES", audience: "200", budget: "R$ 3 mil a 5 mil", message: "SIPAT de março", elapsed: 9000 };
  const r = await t.call("/api/indicacao", { method: "POST", body });
  assert.equal(r.status, 200);
  assert.equal(t.db.leads.length, 1);
  assert.equal(t.db.leads[0].email, "rh@porto.com");
  assert.equal(t.db.leads[0].audience, 200);
  assert.ok(t.db.leads[0].ip_hash && t.db.leads[0].ip_hash.length === 64);
  await tick();
  const team = t.mails.find((m) => m.to[0] === t.env.NOTIFY_EMAIL);
  assert.match(team.subject, /Pedido de indicação: Saúde Mental/);
  assert.equal(team.reply_to, "rh@porto.com");
  assert.ok(t.mails.find((m) => m.to[0] === "rh@porto.com"));
  // robô: campo escondido preenchido → finge que deu certo e não grava
  const r2 = await t.call("/api/indicacao", { method: "POST", body: { ...body, website: "http://spam" } });
  assert.equal(r2.status, 200);
  assert.equal(t.db.leads.length, 1);
  // origem de outro site é barrada
  const r3 = await t.call("/api/indicacao", { method: "POST", body, headers: { origin: "https://evil.example" } });
  assert.equal(r3.status, 403);
});

test("indicação: campos obrigatórios e data no passado", () => {
  assert.match(cleanLead({ company: "X Ltda", email: "a@b.co", theme: "x" }).error, /nome/);
  assert.match(cleanLead({ name: "Ana", company: "X Ltda", email: "a@", theme: "x" }).error, /e-mail/);
  assert.match(cleanLead({ name: "Ana", company: "X Ltda", email: "a@b.co" }).error, /tema/);
  assert.match(cleanLead({ name: "Ana", company: "X Ltda", email: "a@b.co", theme: "x", event_date: "2020-01-01" }, "2026-11-19").error, /passou/);
  assert.equal(cleanLead({ name: "Ana", company: "X Ltda", email: "a@b.co", theme: "x", format: "hack", audience: "-3" }).lead.format, null);
});

test("contato de entidade: grava como entidade e manda e-mails próprios", async () => {
  const t = await setup();
  t.db.leads = [];
  const r = await t.call("/api/indicacao", { method: "POST", body: { kind: "entidade", name: "Christian", role: "Gerente", company: "CDL Vitória", email: "c@cdl.org.br", place: "Vitória/ES", audience: "800", message: "Vamos conversar", elapsed: 9000 } });
  assert.equal(r.status, 200);
  assert.equal(t.db.leads[0].kind, "entidade");
  assert.equal(t.db.leads[0].theme, "Parceria com entidade");
  assert.equal(t.db.leads[0].role, "Gerente");
  await tick();
  assert.match(t.mails.find((m) => m.to[0] === t.env.NOTIFY_EMAIL).subject, /Entidade quer parceria: CDL Vitória/);
  assert.match(t.mails.find((m) => m.to[0] === "c@cdl.org.br").text, /parceria entre CDL Vitória/);
});
