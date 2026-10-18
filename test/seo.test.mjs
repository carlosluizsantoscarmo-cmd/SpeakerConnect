// Prévia do perfil (WhatsApp/LinkedIn/Google) e sitemap. Rodar: node --test test/seo.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const ID = "a0000000-0000-4000-8000-000000000001";
const PAGE = '<!doctype html><html><head><title>Palestrante | SpeakerConnect</title>\n<meta name="description" content="Perfil genérico"></head><body></body></html>';
function env(rows, opts = {}) {
  const calls = [];
  globalThis.fetch = async (u, init) => {
    calls.push({ u: String(u), init });
    if (opts.fail) return new Response("erro", { status: 500 });
    return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
  };
  return { calls, env: {
    SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SITE_URL: "https://speakerconnect.com.br",
    ASSETS: { fetch: async (req) => new URL(req.url).pathname === "/sitemap.xml"
      ? new Response("<urlset>estatico</urlset>", { headers: { "Content-Type": "application/xml" } })
      : new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "999" } }) },
  } };
}
const get = (path, e) => worker.fetch(new Request("https://speakerconnect.com.br" + path), e, {});

test("perfil aprovado ganha título, descrição, og:image e dados estruturados", async () => {
  const { env: e, calls } = env([{ id: ID, public_name: "Ana <Ribeiro>", headline: "Segurança do trabalho", city: "Vitória", uf: "ES", categories: ["SIPAT"],
    photo_url: "https://abc.supabase.co/storage/v1/object/public/fotos/ana.jpg" }]);
  const r = await get("/palestrante?id=" + ID, e);
  const h = await r.text();
  assert.equal(r.status, 200);
  assert.match(h, /<title>Ana &lt;Ribeiro&gt; \| Palestrante \| SpeakerConnect<\/title>/);
  assert.match(h, /<meta name="description" content="Segurança do trabalho · Vitória\/ES\. Peça um orçamento/);
  assert.match(h, /og:image" content="https:\/\/abc\.supabase\.co\/storage\/v1\/object\/public\/fotos\/ana\.jpg"/);
  assert.match(h, /og:url" content="https:\/\/speakerconnect\.com\.br\/palestrante\?id=a0000000/);
  assert.match(h, /application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"Person","name":"Ana \\u003cRibeiro>"/);
  assert.equal(r.headers.get("content-length"), null);
  assert.match(calls[0].u, /status=eq\.approved/);
  assert.equal(calls[0].init.headers.apikey, "anon");
});

test("foto de fora do Supabase usa a imagem padrão", async () => {
  const { env: e } = env([{ id: ID, public_name: "Ana", headline: "x", photo_url: "https://malicioso.com/a.jpg" }]);
  const h = await (await get("/palestrante?id=" + ID, e)).text();
  assert.match(h, /og:image" content="https:\/\/speakerconnect\.com\.br\/og\.png"/);
});

test("perfil inexistente, id inválido ou erro no banco: página original", async () => {
  for (const [rows, path, fail] of [[[], "/palestrante?id=" + ID], [[], "/palestrante?id=abc"], [[], "/palestrante?id=" + ID, true]]) {
    const { env: e } = env(rows, { fail });
    const h = await (await get(path, e)).text();
    assert.equal(h, PAGE);
  }
});

test("endereço antigo .html redireciona mantendo o id", async () => {
  const { env: e } = env([]);
  const r = await get("/palestrante.html?id=" + ID, e);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/palestrante?id=" + ID);
});

test("sitemap inclui páginas fixas e perfis aprovados", async () => {
  const { env: e, calls } = env([{ id: ID, updated_at: "2026-10-10T12:00:00Z" }, { id: "nao-e-uuid" }]);
  const r = await get("/sitemap.xml", e);
  const x = await r.text();
  assert.match(r.headers.get("content-type"), /xml/);
  assert.match(x, /<loc>https:\/\/speakerconnect\.com\.br\/termos<\/loc>/);
  assert.match(x, new RegExp(`<loc>https://speakerconnect\\.com\\.br/palestrante\\?id=${ID}</loc><lastmod>2026-10-10</lastmod>`));
  assert.doesNotMatch(x, /nao-e-uuid/);
  assert.match(calls[0].u, /status=eq\.approved/);
});

test("sitemap cai no arquivo fixo se o banco falhar", async () => {
  const { env: e } = env([], { fail: true });
  assert.equal(await (await get("/sitemap.xml", e)).text(), "<urlset>estatico</urlset>");
});
