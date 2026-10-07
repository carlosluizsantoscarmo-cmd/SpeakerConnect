/* SpeakerConnect — partes comuns do site público (topo, rodapé, catálogo e página do palestrante). */
(function () {
  "use strict";
  var C = window.SC || {};
  var ready = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(C.supabaseUrl || "") && C.supabaseKey && !/COLE_AQUI/.test(C.supabaseKey);
  var sb = ready && window.supabase ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: false } }) : null;
  var COLS = "id,public_name,headline,bio,topics,categories,city,uf,formats,fee_from_cents,photo_url,video_url,instagram,linkedin,verified_until";

  function e(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(c) { return "R$ " + (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
  function $(s) { return document.querySelector(s); }
  function initials(n) { var p = String(n || "?").trim().split(/\s+/); return ((p[0] || "?").charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : "")).toUpperCase(); }
  function verified(s) { return !!(s.verified_until && (s.verified_until === "infinity" || new Date(s.verified_until) > new Date())); }
  function norm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function safeUrl(u) { return /^https:\/\//.test(u || "") ? u : ""; }
  var MIC = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>';
  var CHECK = '<svg class="verified-ic" width="18" height="18" viewBox="0 0 24 24" aria-label="Verificado" role="img"><path fill="currentColor" d="M12 1.5l2.6 1.9 3.2-.2 1 3.1 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3.1-3.2-.2L12 22.5l-2.6-1.9-3.2.2-1-3.1L2.6 15.8l1-3.1-1-3.1 2.6-1.9 1-3.1 3.2.2z"/><path d="M8 12.3l2.7 2.7L16.3 9.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  window.SCsite = { e: e, brl: brl, sb: sb, ready: ready, verified: verified, CHECK: CHECK };

  // ---------- topo e rodapé ----------
  function chrome() {
    var top = $("#top");
    if (top) {
      top.className = "nav";
      top.innerHTML = '<div class="wrap"><a class="logo" href="/" aria-label="SpeakerConnect, página inicial">' + MIC + "SpeakerConnect</a>" +
        '<button class="menu-btn" type="button" aria-expanded="false" aria-controls="menu" aria-label="Abrir menu"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>' +
        '<nav id="menu" aria-label="Principal"><a href="/#palestrantes">Palestrantes</a><a href="/#como-funciona">Como funciona</a><a href="/#para-palestrantes">Para palestrantes</a>' +
        '<a href="/app/">Entrar</a><a class="btn spot" href="/app/#/cadastro">Criar conta</a></nav></div>';
      var b = top.querySelector(".menu-btn"), m = top.querySelector("nav");
      b.onclick = function () { var o = m.classList.toggle("open"); b.setAttribute("aria-expanded", o ? "true" : "false"); };
      m.addEventListener("click", function (ev) { if (ev.target.tagName === "A") { m.classList.remove("open"); b.setAttribute("aria-expanded", "false"); } });
    }
    var f = $("#bottom");
    if (f) {
      f.innerHTML = '<div class="wrap"><div><a class="logo" href="/">' + MIC + "SpeakerConnect</a>" +
        '<p class="small" style="margin-top:10px;max-width:38ch">Palestrantes para eventos corporativos, SIPAT, convenções e treinamentos, com orçamento e pagamento pela plataforma.</p></div>' +
        '<div><nav aria-label="Rodapé"><a href="/termos.html">Termos de uso</a><a href="/privacidade.html">Privacidade</a><a href="/app/">Entrar</a></nav>' +
        (C.email ? '<p class="small" style="margin-top:12px">Contato: <a href="mailto:' + e(C.email) + '">' + e(C.email) + "</a></p>" : "") +
        '<p class="small">© ' + new Date().getFullYear() + " SpeakerConnect</p></div></div>";
    }
    if (C.whatsapp && /^\d{12,13}$/.test(C.whatsapp)) {
      var a = document.createElement("a");
      a.className = "wa"; a.target = "_blank"; a.rel = "noopener"; a.setAttribute("aria-label", "Falar pelo WhatsApp");
      a.href = "https://wa.me/" + C.whatsapp + "?text=" + encodeURIComponent("Olá! Vim pelo site do SpeakerConnect.");
      a.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2s.2-1.1.2-1.2-.2-.2-.4-.3z"/></svg>';
      document.body.appendChild(a);
    }
  }

  // ---------- ícones dos temas ----------
  var TI = {
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 2 1 3 3 3 5"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.8 3.5 6"/>',
    heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    mind: '<path d="M9 21v-3H7a2 2 0 0 1-2-2v-3l-2-1 2-3a7 7 0 0 1 13.5 2c0 2.5-1 4.5-2.5 6v4"/><path d="M11 9.5a2 2 0 0 1 3.5 1.3"/>',
    scale: '<path d="M12 4v16M7 20h10"/><path d="M5 8h14"/><path d="M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M9 15l-3-3c1.5-5 6-9 13-9 0 7-4 11.5-9 13z"/><circle cx="15" cy="9" r="1.5"/>',
    mega: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14"/>',
    coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.7-2.7-3-6-3"/>',
    leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19l8-8"/>',
    hands: '<circle cx="7" cy="6" r="2.5"/><circle cx="17" cy="6" r="2.5"/><path d="M3 20v-4a4 4 0 0 1 8 0M13 16a4 4 0 0 1 8 0v4"/><path d="M11 13h2"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M19 19v2H6"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    pin: '<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'
  };
  function svg(name, size) { return '<svg width="' + (size || 22) + '" height="' + (size || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (TI[name] || TI.spark) + "</svg>"; }
  function themeIcon(n) {
    n = norm(n);
    return /segur|sipat/.test(n) ? "shield" : /mental/.test(n) ? "mind" : /saude|bem-estar/.test(n) ? "heart" : /lideran/.test(n) ? "flag" : /motiva/.test(n) ? "flame" :
      /venda/.test(n) ? "trend" : /pessoas|rh/.test(n) ? "users" : /direito/.test(n) ? "scale" : /tecnolog|inova/.test(n) ? "bulb" : /empreend/.test(n) ? "rocket" :
      /marketing/.test(n) ? "mega" : /financ/.test(n) ? "coins" : /ambiente|esg/.test(n) ? "leaf" : /diversid|inclus/.test(n) ? "hands" :
      /comunica|orator/.test(n) ? "mic" : /educa/.test(n) ? "book" : "spark";
  }
  window.SCsite.svg = svg;

  // ---------- cartão do palestrante ----------
  function fmtLabel(s) { return (s.formats || []).length === 2 ? "Presencial e online" : (s.formats || [])[0] === "online" ? "Online" : "Presencial"; }
  function card(s) {
    var photo = safeUrl(s.photo_url);
    var cats = (s.categories || []).slice(0, 2).map(function (c) { return '<span class="tag">' + e(c) + "</span>"; }).join("");
    var place = [s.city, s.uf].filter(Boolean).join("/");
    return '<a class="sp" href="/palestrante.html?id=' + e(s.id) + '" aria-label="' + e(s.public_name) + (verified(s) ? ", palestrante verificado" : "") + '">' +
      '<div class="ph">' + (photo ? '<img src="' + e(photo) + '" alt="" loading="lazy">' : '<div class="mono" aria-hidden="true">' + e(initials(s.public_name)) + "</div>") +
      (verified(s) ? '<span class="badge vchip">' + CHECK.replace('class="verified-ic"', 'style="color:var(--stage)"') + "<span>Verificado</span></span>" : "") + "</div>" +
      '<div class="bd"><h3>' + e(s.public_name) + "</h3>" +
      (s.headline ? '<p class="hl">' + e(s.headline) + "</p>" : "") +
      (cats ? '<div class="tags">' + cats + "</div>" : "") +
      '<div class="where">' + svg("pin", 16) + e((place ? place + " · " : "") + fmtLabel(s)) + "</div>" +
      '<div class="foot"><span class="fee">' + (s.fee_from_cents ? "a partir de<b>" + brl(s.fee_from_cents) + "</b>" : "valor sob consulta") + '</span><span class="go">Ver perfil</span></div></div></a>';
  }

  // ---------- catálogo e temas (página inicial) ----------
  var all = [];
  function catalog() {
    var grid = $("#grid");
    if (!grid) return;
    var q = $("#f-q"), cat = $("#f-cat"), uf = $("#f-uf"), fmt = $("#f-fmt"), cats = [];
    function themes() {
      var box = $("#themes");
      if (!box || !cats.length) return;
      var count = {};
      all.forEach(function (s) { (s.categories || []).forEach(function (c) { count[c] = (count[c] || 0) + 1; }); });
      var list = cats.slice().sort(function (a, b) { return (count[b] || 0) - (count[a] || 0); });
      box.innerHTML = list.map(function (c) {
        var n = count[c] || 0;
        return '<a class="theme' + (cat.value === c ? " on" : "") + '" href="/?tema=' + encodeURIComponent(c) + '#palestrantes" data-theme="' + e(c) + '"><span class="ti">' + svg(themeIcon(c)) + "</span><b>" + e(c) + "</b><small>" +
          (n ? n + (n === 1 ? " palestrante" : " palestrantes") : "Em breve") + "</small></a>";
      }).join("");
      box.querySelectorAll("[data-theme]").forEach(function (a) {
        a.addEventListener("click", function (ev) {
          ev.preventDefault();
          var c = a.getAttribute("data-theme");
          cat.value = cat.value === c ? "" : c;
          apply(); $("#palestrantes").scrollIntoView();
        });
      });
    }
    function apply() {
      var t = norm(q.value).trim(), c = cat.value, u = uf.value, f = fmt.value;
      var list = all.filter(function (s) {
        if (c && (s.categories || []).indexOf(c) < 0) return false;
        if (u && s.uf !== u) return false;
        if (f && (s.formats || []).indexOf(f) < 0) return false;
        if (t && norm([s.public_name, s.headline, s.topics, (s.categories || []).join(" "), s.city].join(" ")).indexOf(t) < 0) return false;
        return true;
      });
      themes();
      if (!all.length) {
        grid.innerHTML = '<div class="empty"><h3>Os primeiros palestrantes estão chegando</h3><p class="muted">Estamos aprovando os perfis. Se você é palestrante, crie sua conta e saia na frente.</p><a class="btn" href="/app/#/cadastro?tipo=palestrante">Quero ser palestrante</a></div>';
        return;
      }
      grid.innerHTML = list.length ? list.map(card).join("") :
        '<div class="empty"><h3>Nenhum palestrante com esses filtros</h3><p class="muted">Tente outro tema ou tire o filtro de estado.</p><button class="btn line" type="button" id="clear">Limpar filtros</button></div>';
      var cl = $("#clear");
      if (cl) cl.onclick = function () { q.value = ""; cat.value = ""; uf.value = ""; fmt.value = ""; apply(); };
    }
    [q, cat, uf, fmt].forEach(function (el) { el.addEventListener("input", apply); });
    var hero = $("#hero-find");
    if (hero) hero.addEventListener("submit", function (ev) {
      ev.preventDefault(); q.value = $("#hero-q").value; apply();
      $("#palestrantes").scrollIntoView();
    });

    if (!sb) { grid.innerHTML = '<div class="empty"><h3>Catálogo em preparação</h3><p class="muted">O site ainda não foi ligado ao banco de dados.</p></div>'; return; }
    grid.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    sb.from("categories").select("name").eq("active", true).order("sort").then(function (r) {
      cats = (r.data || []).map(function (c) { return c.name; });
      cats.forEach(function (c) { var o = document.createElement("option"); o.value = o.textContent = c; cat.appendChild(o); });
      var pre = new URLSearchParams(location.search).get("tema"); if (pre) cat.value = pre;
      apply();
    });
    sb.from("speakers").select(COLS).eq("status", "approved").order("updated_at", { ascending: false }).limit(500).then(function (r) {
      if (r.error) { grid.innerHTML = '<div class="empty"><h3>Não foi possível carregar os palestrantes</h3><p class="muted">Confira sua internet e atualize a página.</p></div>'; return; }
      all = (r.data || []).sort(function (a, b) { return verified(b) - verified(a); });
      apply();
    });
  }

  // ---------- página do palestrante ----------
  function videoEmbed(u) {
    var m = String(u || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    if (m) return "https://www.youtube-nocookie.com/embed/" + m[1];
    m = String(u || "").match(/vimeo\.com\/(\d+)/);
    return m ? "https://player.vimeo.com/video/" + m[1] : "";
  }
  function profile() {
    var root = $("#prof");
    if (!root) return;
    var id = new URLSearchParams(location.search).get("id") || "";
    function missing(msg) { root.innerHTML = '<section><div class="wrap"><div class="empty"><h3>' + e(msg) + '</h3><a class="btn" href="/#palestrantes">Ver palestrantes</a></div></div></section>'; }
    if (!/^[0-9a-f-]{36}$/.test(id)) return missing("Palestrante não encontrado");
    if (!sb) return missing("O site ainda não foi ligado ao banco de dados");
    sb.from("speakers").select(COLS).eq("id", id).eq("status", "approved").maybeSingle().then(function (r) {
      var s = r.data;
      if (!s) return missing("Este perfil não está disponível");
      document.title = s.public_name + " | SpeakerConnect";
      var d = document.querySelector('meta[name="description"]'); if (d) d.setAttribute("content", (s.headline || "Palestrante") + " — peça um orçamento pelo SpeakerConnect.");
      var photo = safeUrl(s.photo_url), vid = videoEmbed(s.video_url);
      var ask = "/app/#/novo-pedido?p=" + encodeURIComponent(s.id);
      var links = [safeUrl(s.linkedin) ? '<a href="' + e(s.linkedin) + '" target="_blank" rel="noopener">LinkedIn</a>' : "",
        s.instagram ? '<a href="https://instagram.com/' + e(String(s.instagram).replace(/^@/, "")) + '" target="_blank" rel="noopener">Instagram</a>' : ""].filter(Boolean).join("&nbsp;&nbsp;");
      var from = s.fee_from_cents ? '<span class="from">Palestras a partir de<b>' + brl(s.fee_from_cents) + "</b></span>" : '<span class="from">Valor<b>sob consulta</b></span>';
      var talks = String(s.topics || "").split(/\n+/).map(function (t) { return t.replace(/^[\s•\-–*·\d.)]+/, "").trim(); }).filter(Boolean);
      root.innerHTML =
        '<div class="prof-top"><div class="wrap"><div class="ph">' + (photo ? '<img src="' + e(photo) + '" alt="Foto de ' + e(s.public_name) + '">' : '<div class="mono" aria-hidden="true">' + e(initials(s.public_name)) + "</div>") + "</div>" +
        '<div><a class="back" href="/#palestrantes">← Todos os palestrantes</a>' +
        "<h1>" + e(s.public_name) + "</h1>" + (verified(s) ? '<p style="margin:14px 0 0"><span class="badge">' + CHECK.replace('class="verified-ic"', 'style="color:var(--stage)"') + "Palestrante verificado</span></p>" : "") +
        (s.headline ? '<p class="hl">' + e(s.headline) + "</p>" : "") +
        '<div class="tags">' + (s.categories || []).map(function (c) { return '<span class="tag">' + e(c) + "</span>"; }).join("") + "</div>" +
        '<div class="facts"><span>Atende<b>' + e(fmtLabel(s)) + "</b></span>" + (s.city ? "<span>Base<b>" + e(s.city + (s.uf ? "/" + s.uf : "")) + "</b></span>" : "") + (links ? "<span>Redes<b>" + links + "</b></span>" : "") + "</div>" +
        '<div class="cta"><a class="btn spot" href="' + ask + '">Pedir orçamento</a>' + from + "</div></div></div></div>" +
        '<div class="prof-body"><div class="wrap"><div>' +
        (vid ? '<div class="blk"><h2>Veja em ação</h2><div class="video"><iframe src="' + e(vid) + '" title="Vídeo de ' + e(s.public_name) + '" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div></div>' : "") +
        (s.bio ? '<div class="blk"><h2>Sobre</h2><div class="bio">' + e(s.bio) + "</div></div>" : "") +
        (talks.length ? '<div class="blk"><h2>Palestras</h2><div class="talks">' + talks.map(function (t) { return '<div class="talk">' + e(t) + "</div>"; }).join("") + "</div></div>" : "") +
        "</div>" +
        '<aside><div class="card"><h3>Como contratar ' + e(s.public_name.split(" ")[0]) + '</h3><ol><li>Peça o orçamento com a data e o local do evento. Não custa nada.</li><li>Receba a proposta e combine os detalhes pelas mensagens.</li><li>Pague por Pix ou cartão. O contato é liberado na hora.</li></ol>' +
        '<a class="btn" style="width:100%" href="' + ask + '">Pedir orçamento</a></div></aside></div></div>' +
        '<div class="askbar">' + from + '<a class="btn spot" href="' + ask + '">Pedir orçamento</a></div>';
      document.body.classList.add("with-askbar");
    });
  }

  document.addEventListener("DOMContentLoaded", function () { chrome(); catalog(); profile(); });
})();
