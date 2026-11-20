// Prévia do perfil (WhatsApp/LinkedIn/Google) e sitemap. Rodar: node --test test/seo.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const ID = "a0000000-0000-4000-8000-000000000001";
const PAGE = '<!doctype html><html><head><title>Palestrante | SpeakerConnect</title>\n<meta name="description" content="Perfil genérico"></head><body><main id="prof"><div class="skel"></div></main><div class="grid" id="grid" aria-live="polite"></div></body></html>';
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
  const r = await get("/palestrante/ana-ribeiro-a0000000", e);
  const h = await r.text();
  assert.equal(r.status, 200);
  assert.match(h, /<title>Ana &lt;Ribeiro&gt; \| Palestrante \| SpeakerConnect<\/title>/);
  assert.match(h, /<meta name="description" content="Segurança do trabalho · Vitória\/ES\. Peça um orçamento/);
  assert.match(h, /og:image" content="https:\/\/abc\.supabase\.co\/storage\/v1\/object\/public\/fotos\/ana\.jpg"/);
  assert.match(h, /og:url" content="https:\/\/speakerconnect\.com\.br\/palestrante\/ana-ribeiro-a0000000"/);
  assert.match(h, /application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"Person","name":"Ana \\u003cRibeiro>"/);
  assert.equal(r.headers.get("content-length"), null);
  assert.match(calls[0].u, /id_short=eq\.a0000000&status=eq\.approved/);
  assert.equal(calls[0].init.headers.apikey, "anon");
});

test("endereço antigo (?id=) e nome desatualizado mandam para o endereço com o nome", async () => {
  const { env: e } = env([{ id: ID, public_name: "Ana Ribeiro", headline: "x" }]);
  for (const path of ["/palestrante?id=" + ID, "/palestrante/nome-antigo-a0000000", "/palestrante/a0000000"]) {
    const r = await get(path, e);
    assert.equal(r.status, 301, path);
    assert.equal(r.headers.get("location"), "/palestrante/ana-ribeiro-a0000000");
  }
});

test("foto de fora do Supabase usa a imagem padrão", async () => {
  const { env: e } = env([{ id: ID, public_name: "Ana", headline: "x", photo_url: "https://malicioso.com/a.jpg" }]);
  const h = await (await get("/palestrante/ana-a0000000", e)).text();
  assert.match(h, /og:image" content="https:\/\/speakerconnect\.com\.br\/og\.png"/);
});

test("perfil inexistente ou id inválido: 404 de verdade e noindex", async () => {
  for (const path of ["/palestrante?id=" + ID, "/palestrante?id=abc", "/palestrante"]) {
    const { env: e } = env([]);
    const r = await get(path, e);
    assert.equal(r.status, 404, path);
    assert.match(await r.text(), /<meta name="robots" content="noindex">/);
  }
});

test("erro no banco: página original (não marca como 404)", async () => {
  const { env: e } = env([], { fail: true });
  const r = await get("/palestrante?id=" + ID, e);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), PAGE);
});

test("o texto do perfil já vem no HTML (apresentação, palestras, valor)", async () => {
  const { env: e } = env([{ id: ID, public_name: "Ana", headline: "Segurança", bio: "Sou engenheira <b>de</b> segurança.", topics: "1. NR-1 na prática\n2. Cultura de segurança",
    categories: ["SIPAT"], formats: ["presencial", "online"], fee_from_cents: 150000, city: "Serra", uf: "ES" }]);
  const h = await (await get("/palestrante/ana-a0000000", e)).text();
  assert.match(h, /<main id="prof"><div class="prof-top">/);
  assert.match(h, /<h1>Ana<\/h1>/);
  assert.match(h, /Sou engenheira &lt;b&gt;de&lt;\/b&gt; segurança\./);
  assert.match(h, /<div class="talk">NR-1 na prática<\/div><div class="talk">Cultura de segurança<\/div>/);
  assert.match(h, /R\$\s1\.500,00/);
  assert.match(h, /Presencial e online/);
  assert.doesNotMatch(h, /class="skel"/);
});

test("página inicial já traz os links dos perfis aprovados", async () => {
  const { env: e, calls } = env([{ id: ID, public_name: "Ana <R>", headline: "Segurança", categories: ["SIPAT"], city: "Serra", uf: "ES", formats: ["online"] }, { id: "x", public_name: "Sem id" }]);
  const r = await get("/", e);
  const h = await r.text();
  assert.equal(r.status, 200);
  assert.match(h, /<a class="sp" href="\/palestrante\/ana-r-a0000000"><div class="bd"><h3>Ana &lt;R&gt;<\/h3>/);
  assert.doesNotMatch(h, /Sem id/);
  assert.match(calls[0].u, /status=eq\.approved/);
  const { env: e2 } = env([], { fail: true });
  assert.equal(await (await get("/", e2)).text(), PAGE, "banco fora: página original");
});

test("endereço antigo .html redireciona mantendo o id", async () => {
  const { env: e } = env([]);
  const r = await get("/palestrante.html?id=" + ID, e);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/palestrante?id=" + ID);
});

test("sitemap inclui páginas fixas e perfis aprovados", async () => {
  const { env: e, calls } = env([{ id: ID, public_name: "Ana Ribeiro", name: "Saúde Mental", updated_at: "2026-10-10T12:00:00Z" }, { id: "nao-e-uuid" }]);
  const r = await get("/sitemap.xml", e);
  const x = await r.text();
  assert.match(r.headers.get("content-type"), /xml/);
  assert.match(x, /<loc>https:\/\/speakerconnect\.com\.br\/termos<\/loc>/);
  assert.match(x, /<loc>https:\/\/speakerconnect\.com\.br\/palestrante\/ana-ribeiro-a0000000<\/loc><lastmod>2026-10-10<\/lastmod>/);
  assert.match(x, /<loc>https:\/\/speakerconnect\.com\.br\/palestras\/saude-mental<\/loc>/);
  assert.match(x, /<loc>https:\/\/speakerconnect\.com\.br\/campanhas<\/loc>/);
  assert.doesNotMatch(x, /nao-e-uuid/);
  assert.match(calls[0].u, /status=eq\.approved/);
});

test("sitemap cai no arquivo fixo se o banco falhar", async () => {
  const { env: e } = env([], { fail: true });
  assert.equal(await (await get("/sitemap.xml", e)).text(), "<urlset>estatico</urlset>");
});

test("página de tema: título, texto, palestrantes do tema e 404 para tema inexistente", async () => {
  globalThis.fetch = async (u) => {
    u = String(u);
    const rows = u.includes("/categories?") ? [{ name: "Saúde Mental" }, { name: "Liderança" }]
      : [{ id: ID, public_name: "Ana", headline: "NR-1", categories: ["Saúde Mental"], formats: ["online"], invoice: "mei" }, { id: "b0000000-0000-4000-8000-000000000002", public_name: "Bia", categories: ["Liderança"], formats: ["online"] }];
    return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
  };
  const e = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SITE_URL: "https://speakerconnect.com.br",
    ASSETS: { fetch: async () => new Response('<title>{{TITLE}}</title><meta name="description" content="{{DESC}}"><link rel="canonical" href="{{CANON}}"><main class="about tema" id="tema"></main>', { headers: { "Content-Type": "text/html" } }) } };
  let r = await get("/palestras/saude-mental", e), h = await r.text();
  assert.equal(r.status, 200);
  assert.match(h, /<title>Palestras sobre Saúde Mental \| SpeakerConnect<\/title>/);
  assert.match(h, /href="https:\/\/speakerconnect\.com\.br\/palestras\/saude-mental"/);
  assert.match(h, /href="\/palestrante\/ana-a0000000"/);
  assert.match(h, /Emite NF/);
  assert.doesNotMatch(h, /Bia<\/h3>/);
  assert.match(h, /Setembro Amarelo/);
  r = await get("/palestras/nao-existe", e);
  assert.equal(r.status, 404);
  h = await (await get("/palestras", e)).text();
  assert.match(h, /href="\/palestras\/lideranca"/);
  h = await (await get("/campanhas", e)).text();
  assert.match(h, /Outubro Rosa/);
  assert.match(h, /href="\/palestras\/saude-mental"/);
});
