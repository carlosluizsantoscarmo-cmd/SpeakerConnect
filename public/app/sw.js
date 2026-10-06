// Service worker do app: guarda só os arquivos da própria tela para abrir mais rápido e mostrar algo sem internet.
// Nunca guarda dados do Supabase nem de pagamento.
const V = "sc-app-v1";
const SHELL = ["./", "app.css", "app.js", "manifest.webmanifest", "icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith("/app/")) return;
  // rede primeiro (sempre a versão nova); sem internet, usa a guardada
  e.respondWith(fetch(r).then((res) => { const copy = res.clone(); caches.open(V).then((c) => c.put(r, copy)); return res; }).catch(() => caches.match(r).then((m) => m || caches.match("./"))));
});
