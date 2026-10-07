// Supabase de mentira, só para testar as telas no navegador sem internet.
// Guarda tudo em memória (window.__db). Não aplica as regras de segurança: essas são testadas no Postgres (db.test.sql).
(function () {
  var now = Date.now();
  var iso = function (d) { return new Date(now - d * 864e5).toISOString(); };
  var db = window.__db = window.__db || {
    categories: ["Liderança", "Motivacional", "Vendas", "Gestão de Pessoas e RH", "Saúde e Bem-Estar", "Saúde Mental", "Segurança do Trabalho e SIPAT", "Direito", "Tecnologia e Inovação"]
      .map(function (n, i) { return { name: n, sort: i, active: true }; }),
    profiles: [
      { id: "a0000000-0000-4000-8000-000000000000", role: "admin", name: "Equipe SC", email: "equipe@x.com", phone: "27999990000", created_at: iso(30) },
      { id: "a0000000-0000-4000-8000-000000000001", role: "speaker", name: "Ana Ribeiro", email: "ana@x.com", phone: "27999990001", created_at: iso(20) },
      { id: "a0000000-0000-4000-8000-000000000002", role: "speaker", name: "Bruno Tavares", email: "bruno@x.com", phone: "11999990002", created_at: iso(15) },
      { id: "a0000000-0000-4000-8000-000000000003", role: "speaker", name: "Clara Menezes", email: "clara@x.com", phone: "21999990003", created_at: iso(10) },
      { id: "a0000000-0000-4000-8000-000000000004", role: "speaker", name: "Diego Fontes", email: "diego@x.com", phone: "31999990004", created_at: iso(2) },
      { id: "a0000000-0000-4000-8000-000000000005", role: "company", name: "Carla Souza", email: "rh@empresa.com", phone: "27999990005", created_at: iso(5) }
    ],
    speakers: [
      { id: "a0000000-0000-4000-8000-000000000001", public_name: "Ana Ribeiro", headline: "Segurança do trabalho que as equipes levam para casa", bio: "Engenheira de segurança há 18 anos, já falou para mais de 300 SIPATs em indústrias, portos e construtoras.\n\nUsa histórias reais e dinâmicas com a plateia para transformar normas em atitude.", topics: "• Percepção de risco no dia a dia\n• Saúde mental e segurança\n• Liderança em segurança", categories: ["Segurança do Trabalho e SIPAT", "Saúde Mental"], city: "Vitória", uf: "ES", formats: ["presencial", "online"], fee_from_cents: 350000, photo_url: null, video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", instagram: "@anaribeiro", linkedin: "https://linkedin.com/in/ana", status: "approved", verified_until: new Date(now + 200 * 864e5).toISOString(), updated_at: iso(3), created_at: iso(20) },
      { id: "a0000000-0000-4000-8000-000000000002", public_name: "Bruno Tavares", headline: "Vendas consultivas para times que precisam bater meta", bio: "Ex-diretor comercial, autor de dois livros sobre negociação.", categories: ["Vendas", "Liderança"], city: "São Paulo", uf: "SP", formats: ["presencial"], fee_from_cents: 800000, status: "approved", verified_until: null, updated_at: iso(4), created_at: iso(15) },
      { id: "a0000000-0000-4000-8000-000000000003", public_name: "Clara Menezes", headline: "Liderança humana em tempos de trabalho híbrido", bio: "Psicóloga organizacional.", categories: ["Liderança", "Gestão de Pessoas e RH"], city: "Rio de Janeiro", uf: "RJ", formats: ["online"], fee_from_cents: 250000, status: "approved", verified_until: null, updated_at: iso(5), created_at: iso(10) },
      { id: "a0000000-0000-4000-8000-000000000004", public_name: "Diego Fontes", headline: "Inovação sem jargão", bio: "Fundador de duas startups. Fala sobre como inovar em empresas tradicionais, com exemplos práticos e ferramentas simples.", categories: ["Tecnologia e Inovação"], city: "Belo Horizonte", uf: "MG", formats: ["presencial", "online"], fee_from_cents: 400000, status: "pending", verified_until: null, updated_at: iso(1), created_at: iso(2) }
    ],
    companies: [{ id: "a0000000-0000-4000-8000-000000000005", company_name: "Porto Serra Logística", cnpj: null, city: "Serra", uf: "ES", website: null, created_at: iso(5) }],
    quotes: [
      { id: "b0000000-0000-4000-8000-000000000001", company_id: "a0000000-0000-4000-8000-000000000005", speaker_id: "a0000000-0000-4000-8000-000000000001", company_name: "Porto Serra Logística", speaker_name: "Ana Ribeiro", title: "SIPAT 2026 — turno da manhã", event_date: "2026-11-20", format: "presencial", city: "Serra", uf: "ES", audience: 250, duration_min: 60, message: "Queremos algo bem prático, com participação do público.", status: "proposed", amount_cents: 420000, speaker_note: "Inclui material de apoio e deslocamento na Grande Vitória.", proposed_at: iso(1), created_at: iso(3), updated_at: iso(1) },
      { id: "b0000000-0000-4000-8000-000000000002", company_id: "a0000000-0000-4000-8000-000000000005", speaker_id: "a0000000-0000-4000-8000-000000000003", company_name: "Porto Serra Logística", speaker_name: "Clara Menezes", title: "Encontro de líderes", event_date: null, format: "online", city: null, uf: null, audience: 40, duration_min: 90, message: null, status: "paid", amount_cents: 300000, speaker_note: null, paid_at: iso(1), created_at: iso(6), updated_at: iso(1) }
    ],
    quote_messages: [
      { id: "m1", quote_id: "b0000000-0000-4000-8000-000000000001", sender_id: "a0000000-0000-4000-8000-000000000005", body: "Olá, Ana! Dá para incluir uma dinâmica de 10 minutos?", created_at: iso(2) },
      { id: "m2", quote_id: "b0000000-0000-4000-8000-000000000001", sender_id: "a0000000-0000-4000-8000-000000000001", body: "Dá sim! Já considerei na proposta.", created_at: iso(1) }
    ],
    payments: [
      { id: "c0000000-0000-4000-8000-000000000001", kind: "quote", user_id: "a0000000-0000-4000-8000-000000000005", quote_id: "b0000000-0000-4000-8000-000000000002", speaker_id: "a0000000-0000-4000-8000-000000000003", description: "Palestra: Encontro de líderes - Clara Menezes", amount_cents: 300000, commission_cents: 45000, payout_cents: 255000, status: "paid", mp_payment_id: "1234567", payer_name: "Carla Souza", payer_email: "rh@empresa.com", payout_done_at: null, paid_at: iso(1), created_at: iso(1) },
      { id: "c0000000-0000-4000-8000-000000000002", kind: "verified", user_id: "a0000000-0000-4000-8000-000000000001", speaker_id: "a0000000-0000-4000-8000-000000000001", description: "Selo de palestrante verificado", amount_cents: 9990, commission_cents: 0, payout_cents: 0, status: "paid", mp_payment_id: "7654321", payer_name: "Ana Ribeiro", payer_email: "ana@x.com", paid_at: iso(10), created_at: iso(10) }
    ]
  };
  var session = null;
  try { var s = sessionStorage.getItem("__mock_session"); if (s) session = JSON.parse(s); } catch (x) {}
  var listeners = [];
  function setSession(u) {
    session = u ? { access_token: "a.b." + u.id, user: { id: u.id, email: u.email } } : null;
    try { session ? sessionStorage.setItem("__mock_session", JSON.stringify(session)) : sessionStorage.removeItem("__mock_session"); } catch (x) {}
  }
  function uid() { return "d0000000-0000-4000-8000-" + String(Math.floor(Math.random() * 1e12)).padStart(12, "0"); }
  var pkeys = { categories: "name" };

  function Q(table) {
    this.t = table; this.f = []; this.op = "select"; this.ord = null; this.lim = null; this.mode = null; this.payload = null; this.sel = "*";
  }
  Q.prototype.select = function (s) { if (this.op === "select") this.op = "select"; this.sel = s || "*"; this.wantRows = true; return this; };
  Q.prototype.eq = function (k, v) { this.f.push(function (r) { return String(r[k]) === String(v); }); return this; };
  Q.prototype.neq = function (k, v) { this.f.push(function (r) { return String(r[k]) !== String(v); }); return this; };
  Q.prototype.in = function (k, vs) { this.f.push(function (r) { return vs.map(String).indexOf(String(r[k])) > -1; }); return this; };
  Q.prototype.or = function (expr) {
    var parts = expr.split(",").map(function (p) { var m = p.split("."); return [m[0], m.slice(2).join(".")]; });
    this.f.push(function (r) { return parts.some(function (p) { return String(r[p[0]]) === p[1]; }); }); return this;
  };
  Q.prototype.order = function (k, o) { this.ord = [k, !(o && o.ascending === false)]; return this; };
  Q.prototype.limit = function (n) { this.lim = n; return this; };
  Q.prototype.range = function (a, b) { this.lim = b - a + 1; return this; };
  Q.prototype.maybeSingle = function () { this.mode = "maybe"; return this; };
  Q.prototype.single = function () { this.mode = "single"; return this; };
  Q.prototype.insert = function (v) { this.op = "insert"; this.payload = Array.isArray(v) ? v : [v]; return this; };
  Q.prototype.update = function (v) { this.op = "update"; this.payload = v; return this; };
  Q.prototype.upsert = function (v) { this.op = "upsert"; this.payload = Array.isArray(v) ? v : [v]; return this; };
  Q.prototype.delete = function () { this.op = "delete"; return this; };
  Q.prototype.then = function (ok, bad) {
    var self = this;
    return new Promise(function (res) { setTimeout(function () { res(self.run()); }, 60); }).then(ok, bad);
  };
  Q.prototype.run = function () {
    var rows = db[this.t] || (db[this.t] = []), f = this.f, out;
    var match = function (r) { return f.every(function (fn) { return fn(r); }); };
    var me = session && session.user.id;
    if (this.op === "insert" || this.op === "upsert") {
      var pk = pkeys[this.t] || "id";
      out = this.payload.map(function (p) {
        var r = Object.assign({ id: uid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, p);
        if (this.t === "quote_messages" && !r.sender_id) r.sender_id = me;
        if (this.t === "quotes") {
          r.status = r.status || "requested";
          r.company_name = (db.companies.filter(function (c) { return c.id === r.company_id; })[0] || {}).company_name;
          r.speaker_name = (db.speakers.filter(function (s) { return s.id === r.speaker_id; })[0] || {}).public_name;
        }
        var ex = rows.filter(function (x) { return x[pk] === r[pk]; })[0];
        if (ex) Object.assign(ex, p); else rows.push(r);
        return ex || r;
      }, this);
    } else if (this.op === "update") {
      out = rows.filter(match);
      var pl = this.payload;
      if (this.t === "quotes" && pl.status === "proposed") pl.proposed_at = new Date().toISOString();
      if (this.t === "quotes" && pl.status === "accepted") pl.accepted_at = new Date().toISOString();
      out.forEach(function (r) { Object.assign(r, pl, { updated_at: new Date().toISOString() }); });
    } else if (this.op === "delete") {
      out = rows.filter(match);
      db[this.t] = rows.filter(function (r) { return !match(r); });
    } else {
      out = rows.filter(match);
    }
    out = out.map(function (r) { return Object.assign({}, r); });
    if (this.ord) {
      var k = this.ord[0], asc = this.ord[1];
      out.sort(function (a, b) { var x = a[k] == null ? "" : a[k], y = b[k] == null ? "" : b[k]; return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1); });
    }
    if (this.lim) out = out.slice(0, this.lim);
    window.__calls = (window.__calls || []).concat([{ t: this.t, op: this.op, payload: this.payload }]);
    if (this.mode === "single") return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "not found" } };
    if (this.mode === "maybe") return { data: out[0] || null, error: null };
    return { data: out, error: null, count: out.length };
  };

  function client() {
    return {
      from: function (t) { return new Q(t); },
      rpc: function (fn, args) {
        return Promise.resolve().then(function () {
          if (fn === "quote_contacts") {
            var q = db.quotes.filter(function (x) { return x.id === args.qid; })[0];
            if (!q || ["paid", "done"].indexOf(q.status) < 0) return { data: [], error: null };
            var c = db.profiles.filter(function (p) { return p.id === q.company_id; })[0], s = db.profiles.filter(function (p) { return p.id === q.speaker_id; })[0];
            return { data: [{ company_contact: c.name, company_phone: c.phone, company_email: c.email, speaker_contact: s.name, speaker_phone: s.phone, speaker_email: s.email }], error: null };
          }
          if (fn === "mp_connected") return { data: (window.__mpConnected || ["a0000000-0000-4000-8000-000000000001"]).indexOf(args.sid) > -1, error: null };
          return { data: null, error: { message: "rpc desconhecida" } };
        });
      },
      channel: function () { var ch = { on: function () { return ch; }, subscribe: function () { return ch; } }; return ch; },
      removeChannel: function () {},
      storage: { from: function () { return {
        upload: function (path) { return Promise.resolve({ data: { path: path }, error: null }); },
        getPublicUrl: function (path) { return { data: { publicUrl: "https://picsum.photos/seed/" + encodeURIComponent(path) + "/600/700" } }; }
      }; } },
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
        onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
        signInWithPassword: function (c) {
          var u = db.profiles.filter(function (p) { return p.email === c.email; })[0];
          if (!u || c.password.length < 8) return Promise.resolve({ data: {}, error: { message: "Invalid login credentials" } });
          setSession(u); listeners.forEach(function (l) { l("SIGNED_IN", session); });
          return Promise.resolve({ data: { session: session, user: session.user }, error: null });
        },
        signUp: function (c) {
          var m = (c.options && c.options.data) || {}, id = uid();
          var p = { id: id, role: m.role === "speaker" ? "speaker" : "company", name: m.name, email: c.email, phone: m.phone, created_at: new Date().toISOString() };
          db.profiles.push(p);
          if (p.role === "speaker") db.speakers.push({ id: id, public_name: m.name, categories: [], formats: ["presencial", "online"], status: "draft" });
          else db.companies.push({ id: id, company_name: m.company_name || m.name });
          setSession(p); listeners.forEach(function (l) { l("SIGNED_IN", session); });
          return Promise.resolve({ data: { session: session, user: session.user }, error: null });
        },
        signOut: function () { setSession(null); listeners.forEach(function (l) { l("SIGNED_OUT", null); }); return Promise.resolve({ error: null }); },
        resetPasswordForEmail: function () { return Promise.resolve({ data: {}, error: null }); },
        updateUser: function () { return Promise.resolve({ data: {}, error: null }); }
      }
    };
  }
  window.supabase = { createClient: client };
})();
