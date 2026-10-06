// Testes do servidor com Supabase, Mercado Pago e Resend de mentira. Rodar: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import worker, { mpSignatureValid, split, brl } from "../worker.js";

const SPEAKER = "00000000-0000-0000-0000-000000000001";
const COMPANY = "00000000-0000-0000-0000-000000000003";
const QUOTE = "10000000-0000-0000-0000-000000000001";

function setup({ speakerStatus = "approved", quoteStatus = "accepted", mpAmount } = {}) {
  const db = {
    profiles: [
      { id: SPEAKER, role: "speaker", name: "Ana Palestrante", email: "ana@x.com", phone: "1" },
      { id: COMPANY, role: "company", name: "Carla RH", email: "rh@x.com", phone: "2" },
    ],
    speakers: [{ id: SPEAKER, public_name: "Ana Palestrante", status: speakerStatus, verified_until: null }],
    quotes: [{ id: QUOTE, company_id: COMPANY, speaker_id: SPEAKER, title: "SIPAT 2026", status: quoteStatus, amount_cents: 800000,
               company_name: "Empresa Boa", speaker_name: "Ana Palestrante", event_date: "2026-11-20", format: "presencial", city: "Serra", uf: "ES" }],
    quote_messages: [],
    payments: [],
  };
  const tokens = { "a.b.ana": SPEAKER, "a.b.carla": COMPANY };
  const mails = [], prefs = [], deleted = [];
  let seq = 0;
  const env = {
    SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    MP_ACCESS_TOKEN: "mp", MP_WEBHOOK_SECRET: "whsecret", RESEND_API_KEY: "re", MAIL_FROM: "SC <a@b.c>", NOTIFY_EMAIL: "equipe@x.com",
    NOTIFY_SECRET: "segredo-de-teste-123456", SITE_URL: "https://site.test", COMMISSION_PCT: "15", VERIFIED_PRICE_CENTS: "9990", VERIFIED_DAYS: "365",
    ALLOWED_ORIGINS: "https://site.test",
    ASSETS: { fetch: () => new Response("pagina") },
  };
  const filterRows = (rows, params) => rows.filter((r) => {
    for (const [k, v] of params) {
      if (["select", "order", "limit"].includes(k)) continue;
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
    if (u.host === "sb.test" && u.pathname.startsWith("/rest/v1/")) {
      assert.equal(opt.headers.Authorization, "Bearer service");
      const table = db[u.pathname.slice(9)];
      if (method === "GET") return Response.json(filterRows(table, u.searchParams));
      if (method === "POST") { const row = { id: `20000000-0000-0000-0000-00000000000${++seq}`, status: "pending", commission_cents: 0, payout_cents: 0, ...body }; table.push(row); return Response.json([row]); }
      if (method === "PATCH") { for (const r of filterRows(table, u.searchParams)) Object.assign(r, body); return new Response(null, { status: 204 }); }
    }
    if (u.host === "api.mercadopago.com" && u.pathname === "/checkout/preferences") { prefs.push(body); return Response.json({ init_point: "https://mp.test/pagar/" + body.external_reference }); }
    if (u.host === "api.mercadopago.com" && u.pathname.startsWith("/v1/payments/")) {
      const p = db.payments[db.payments.length - 1];
      return Response.json({ id: 555000111, status: "approved", currency_id: "BRL", transaction_amount: (mpAmount ?? p.amount_cents) / 100, external_reference: p.id });
    }
    if (u.host === "api.resend.com") { mails.push(body); return Response.json({ id: "m" }); }
    throw new Error("rede inesperada: " + url);
  };
  const call = (path, { method = "GET", token, body, headers = {} } = {}) => {
    const h = { Origin: "https://site.test", ...headers };
    if (token) h.Authorization = "Bearer " + token;
    return worker.fetch(new Request("https://site.test" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} });
  };
  return { db, env, mails, prefs, deleted, call };
}

async function signed(env, dataId) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`id:${dataId};request-id:req-1;ts:${ts};`));
  return { "x-signature": `ts=${ts},v1=` + [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, "0")).join(""), "x-request-id": "req-1" };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("valores e comissão", () => {
  assert.equal(brl(800000), "R$ 8.000,00");
  assert.deepEqual(split(800000, "15"), { commission: 120000, payout: 680000 });
  assert.deepEqual(split(999, "15"), { commission: 150, payout: 849 });
});

test("empresa paga proposta aceita: valor vem do banco, comissão separada", async () => {
  const t = setup();
  const r = await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: QUOTE, amount_cents: 1 } });
  assert.equal(r.status, 200);
  const p = t.db.payments[0];
  assert.equal(p.amount_cents, 800000);
  assert.equal(p.commission_cents, 120000);
  assert.equal(p.payout_cents, 680000);
  assert.equal(t.prefs[0].items[0].unit_price, 8000);
  assert.equal(t.prefs[0].notification_url, "https://site.test/api/mp-webhook");
});

test("pagar: sem login, pedido de outra empresa ou proposta não aceita são barrados", async () => {
  let t = setup();
  assert.equal((await t.call("/api/pagar", { method: "POST", body: { quote_id: QUOTE } })).status, 401);
  assert.equal((await t.call("/api/pagar", { method: "POST", token: "a.b.ana", body: { quote_id: QUOTE } })).status, 404);
  assert.equal((await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: "x" } })).status, 400);
  t = setup({ quoteStatus: "proposed" });
  assert.equal((await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: QUOTE } })).status, 400);
  assert.equal((await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: QUOTE }, headers: { Origin: "https://ruim.test" } })).status, 403);
  assert.equal(t.db.payments.length, 0);
});

test("webhook com assinatura válida marca pago, libera o pedido e manda e-mails", async () => {
  const t = setup();
  await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: QUOTE } });
  const r = await t.call("/api/mp-webhook?data.id=555000111&type=payment", { method: "POST", body: { type: "payment", data: { id: "555000111" } }, headers: await signed(t.env, "555000111") });
  assert.equal(r.status, 200);
  await tick();
  assert.equal(t.db.payments[0].status, "paid");
  assert.equal(t.db.quotes[0].status, "paid");
  const to = t.mails.map((m) => m.to[0]).sort();
  assert.deepEqual(to, ["ana@x.com", "equipe@x.com", "rh@x.com"]);
  assert.match(t.mails.find((m) => m.to[0] === "ana@x.com").text, /R\$ 6\.800,00/);
  // reenvio do mesmo aviso não duplica e-mails
  await t.call("/api/mp-webhook?data.id=555000111&type=payment", { method: "POST", body: {}, headers: await signed(t.env, "555000111") });
  await tick();
  assert.equal(t.mails.length, 3);
});

test("webhook sem assinatura ou com valor diferente não libera nada", async () => {
  let t = setup();
  await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: QUOTE } });
  assert.equal((await t.call("/api/mp-webhook?data.id=1&type=payment", { method: "POST", body: {} })).status, 401);
  assert.equal(t.db.quotes[0].status, "accepted");
  t = setup({ mpAmount: 100 });
  await t.call("/api/pagar", { method: "POST", token: "a.b.carla", body: { quote_id: QUOTE } });
  await t.call("/api/mp-webhook?data.id=9&type=payment", { method: "POST", body: {}, headers: await signed(t.env, "9") });
  assert.equal(t.db.payments[0].status, "pending");
  assert.equal(t.db.quotes[0].status, "accepted");
});

test("selo: só palestrante aprovado; pagamento ativa por 1 ano", async () => {
  let t = setup({ speakerStatus: "pending" });
  assert.equal((await t.call("/api/selo", { method: "POST", token: "a.b.ana" })).status, 400);
  assert.equal((await t.call("/api/selo", { method: "POST", token: "a.b.carla" })).status, 403);
  t = setup();
  const r = await t.call("/api/selo", { method: "POST", token: "a.b.ana" });
  assert.equal(r.status, 200);
  assert.equal(t.db.payments[0].amount_cents, 9990);
  // volta do Mercado Pago com payment_id: confirma direto na API
  const id = t.db.payments[0].id;
  const s = await (await t.call(`/api/pagamento?id=${id}&payment_id=555000111`)).json();
  assert.equal(s.status, "paid");
  const days = (new Date(t.db.speakers[0].verified_until) - Date.now()) / 864e5;
  assert.ok(days > 364 && days < 366, "validade de 1 ano");
  assert.equal((await t.call("/api/selo", { method: "POST", token: "a.b.ana" })).status, 400, "selo já ativo");
});

test("selo para sempre quando VERIFIED_DAYS=0", async () => {
  const t = setup();
  t.env.VERIFIED_DAYS = "0";
  await t.call("/api/selo", { method: "POST", token: "a.b.ana" });
  await t.call(`/api/pagamento?id=${t.db.payments[0].id}&payment_id=555000111`);
  assert.equal(t.db.speakers[0].verified_until, "infinity");
});

test("aviso do Supabase: exige a senha e manda o e-mail certo", async () => {
  const t = setup({ quoteStatus: "requested" });
  assert.equal((await t.call("/api/aviso", { method: "POST", body: { type: "pedido_novo", id: QUOTE } })).status, 401);
  const r = await t.call("/api/aviso", { method: "POST", body: { type: "pedido_novo", id: QUOTE }, headers: { "x-sc-secret": "segredo-de-teste-123456" } });
  assert.equal((await r.json()).enviados, 1);
  await tick();
  assert.equal(t.mails[0].to[0], "ana@x.com");
  assert.match(t.mails[0].text, /20\/11\/2026/);
  assert.match(t.mails[0].text, /Serra\/ES/);
});

test("excluir conta: só a própria, e não com palestra paga em aberto", async () => {
  let t = setup({ quoteStatus: "paid" });
  assert.equal((await t.call("/api/conta", { method: "DELETE", token: "a.b.carla" })).status, 400);
  t = setup({ quoteStatus: "done" });
  assert.equal((await t.call("/api/conta", { method: "DELETE" })).status, 401);
  assert.equal((await t.call("/api/conta", { method: "DELETE", token: "a.b.carla" })).status, 200);
  assert.deepEqual(t.deleted, [COMPANY]);
});

test("assinatura do Mercado Pago velha é recusada", async () => {
  const ok = await mpSignatureValid({ secret: "s", signature: "ts=1,v1=abc", requestId: "r", dataId: "1" });
  assert.equal(ok, false);
});

test("endereços desconhecidos e páginas", async () => {
  const t = setup();
  assert.equal((await t.call("/api/nada")).status, 404);
  assert.equal((await t.call("/api/pagar")).status, 405);
  assert.equal(await (await t.call("/")).text(), "pagina");
});
