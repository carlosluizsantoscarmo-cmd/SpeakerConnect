# Abre as páginas num Chromium sem internet (Supabase de mentira) e tira fotos. Uso: python3 -I test/shots.py <saida> <script de passos>
import sys, json, threading, http.server, functools, os
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PUB = os.path.join(ROOT, "public")
MOCK = open(os.path.join(ROOT, "test", "mock-supabase.js")).read()
CONF = 'window.SC={supabaseUrl:"https://teste.supabase.co",supabaseKey:"sb_publishable_teste",whatsapp:"5527999999999",email:"contato@speakerconnect.com.br",commissionPct:15,verifiedPrice:"R$ 99,90 por ano"};'
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), functools.partial(H, directory=PUB))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8765"
def wire(page, api=None):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    def route(r):
        u = r.request.url
        if "supabase-js" in u: return r.fulfill(body=MOCK, content_type="application/javascript")
        if u.endswith("/config.js"): return r.fulfill(body=CONF, content_type="application/javascript")
        if "/api/" in u:
            body = (api or {}).get(u.split("/api/")[1].split("?")[0], {"error": "sem mock"})
            return r.fulfill(status=200, body=json.dumps(body), content_type="application/json")
        if u.startswith(BASE): return r.continue_()
        return r.abort()
    page.route("**/*", route)
    return errors
if __name__ == "__main__":
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    steps = open(sys.argv[2]).read()
    with sync_playwright() as p:
        b = p.chromium.launch()
        exec(steps, {"b": b, "wire": wire, "BASE": BASE, "out": out})
        b.close()
