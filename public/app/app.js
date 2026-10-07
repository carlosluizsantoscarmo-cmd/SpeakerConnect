/* SpeakerConnect — app (PWA). Palestrante e empresa no mesmo aplicativo.
   Fala direto com o Supabase usando a chave pública; quem protege os dados são as regras do banco (RLS).
   Pagamentos passam pelo servidor (/api/*), que confere tudo de novo. */
(function () {
  "use strict";
  var C = window.SC || {};
  var app = document.getElementById("app");
  var TERMS = "2026-10-v1";
  var sb = null, user = null, profile = null, me = null, cats = [], timer = null, installEvt = null, recovering = false, mpConn = null, payActive = false, payTimer = null;

  // ---------- utilidades ----------
  function e(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function brl(c) { return "R$ " + (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function parseBrl(s) {
    s = String(s || "").trim().replace(/[R$\s]/g, "");
    if (!s) return NaN;
    if (s.indexOf(",") > -1) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    var n = Number(s);
    return isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
  }
  function date(d) { return d ? d.split("-").reverse().join("/") : "A combinar"; }
  function when(iso) { var d = new Date(iso); return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? String(el.value || "").trim() : ""; }
  function toast(m) { var t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 3200); }
  function initials(n) { var p = String(n || "?").trim().split(/\s+/); return ((p[0] || "?").charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : "")).toUpperCase(); }
  function avatar(name, photo) { return '<span class="av" aria-hidden="true">' + (/^https:\/\//.test(photo || "") ? '<img src="' + e(photo) + '" alt="">' : e(initials(name))) + "</span>"; }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function go(h) { if (location.hash === h) route(); else location.hash = h; }
  function isVerified(s) { return !!(s && s.verified_until && (s.verified_until === "infinity" || new Date(s.verified_until) > new Date())); }
  function busy(btn, on, label) { if (!btn) return; btn.disabled = on; if (on) { btn._t = btn.textContent; btn.textContent = label || "Aguarde…"; } else if (btn._t) btn.textContent = btn._t; }
  function friendly(err) {
    var m = String((err && (err.message || err.error_description || err.error)) || err || "");
    if (/invalid login/i.test(m)) return "E-mail ou senha incorretos.";
    if (/already registered|already been registered|already exists/i.test(m)) return "Este e-mail já tem cadastro. Use a opção Entrar.";
    if (/not confirmed/i.test(m)) return "Confirme seu e-mail (veja a caixa de entrada) antes de entrar.";
    if (/password/i.test(m) && /(short|least|weak|characters)/i.test(m)) return "A senha precisa ter pelo menos 8 caracteres.";
    if (/rate limit|too many/i.test(m)) return "Muitas tentativas. Espere um pouco e tente de novo.";
    if (/failed to fetch|network|load failed/i.test(m)) return "Sem conexão. Confira a internet e tente de novo.";
    if (/row-level security|permission denied|42501/i.test(m)) return "Sem permissão para essa ação.";
    if (/Complete o perfil|Categoria inválida|não está disponível|Mudança|Só a|Depois da proposta|Informe o valor|Você não pode/.test(m)) return m;
    try { console.error("Erro do app:", err); } catch (x) {}
    return "Não foi possível concluir agora. Tente de novo em instantes.";
  }

  // ---------- ícones ----------
  var ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    list: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    send: '<path d="M3 11l18-8-8 18-2-8z"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2"/>'
  };
  function icon(n, s) { s = s || 22; return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || "") + "</svg>"; }
  var LOGO = '<span class="logo">' + icon("mic", 20) + "SpeakerConnect</span>";

  // ---------- situação de pedidos ----------
  var QS = {
    requested: ["Aguardando proposta", "warn"], proposed: ["Proposta recebida", ""], accepted: ["Aguardando pagamento", "warn"],
    paid: ["Contratado", "ok"], done: ["Realizado", "ok"], declined: ["Recusado", "err"], cancelled: ["Cancelado", "err"]
  };
  var QS_SPEAKER = { requested: ["Responder", "warn"], proposed: ["Proposta enviada", ""] };
  function pill(st, asSpeaker) { var m = (asSpeaker && QS_SPEAKER[st]) || QS[st] || [st, ""]; return '<span class="pill ' + m[1] + '">' + e(m[0]) + "</span>"; }

  // ---------- molduras ----------
  function shell(inner, tab, head) {
    var sp = profile && profile.role === "speaker";
    var items = sp
      ? [["home", "#/", "Início", "home"], ["pedidos", "#/pedidos", "Pedidos", "list"], ["perfil", "#/perfil", "Meu perfil", "mic"], ["conta", "#/conta", "Conta", "user"]]
      : [["home", "#/", "Início", "home"], ["buscar", "/#palestrantes", "Palestrantes", "search"], ["pedidos", "#/pedidos", "Pedidos", "list"], ["conta", "#/conta", "Conta", "user"]];
    var nav = items.map(function (i) { var on = tab === i[0]; return '<a href="' + i[1] + '" class="' + (on ? "on" : "") + '"' + (on ? ' aria-current="page"' : "") + ">" + icon(i[3]) + i[2] + "</a>"; }).join("");
    app.className = "";
    var side = '<a class="side-brand" href="/" aria-label="Ir para o site">' + LOGO + "</a>";
    var foot = '<div class="side-foot"><b>' + e(profile ? profile.name : "") + "</b><span>" + (sp ? "Palestrante" : "Empresa") + '</span><a href="/">Ir para o site</a><a href="#/sair">Sair</a></div>';
    app.innerHTML = (head || "") + '<div class="pad">' + inner + '</div><nav class="bottom" aria-label="Menu"><div class="in">' + side + nav + foot + "</div></nav>";
    try { window.scrollTo(0, 0); } catch (x) {}
  }
  function topbar(title, back) {
    return '<div class="topbar">' + (back ? '<a class="iconbtn" href="' + back + '" aria-label="Voltar">' + icon("back") + "</a>" : "") + "<h2>" + e(title) + "</h2></div>";
  }
  function plain(inner, title, sub) {
    var standalone = false;
    try { standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch (x) {}
    app.className = "noNav";
    app.innerHTML = '<div class="hero"><div class="hrow">' + (standalone ? LOGO : '<a href="/" style="color:inherit;text-decoration:none" aria-label="Voltar ao site">' + LOGO + "</a>") + "</div>" +
      (title ? "<h1>" + e(title) + "</h1>" + (sub ? '<p class="sub">' + e(sub) + "</p>" : "") : "") + '</div><div class="authbox">' + inner + "</div>";
  }
  function loading() { app.innerHTML = '<p class="boot">Carregando…</p>'; }
  function supportCard() {
    var wa = C.whatsapp && /^\d{12,13}$/.test(C.whatsapp) ? '<a class="btn full ghost" href="https://wa.me/' + C.whatsapp + "?text=" + encodeURIComponent("Olá! Preciso de ajuda com o SpeakerConnect.") + '" target="_blank" rel="noopener">Falar pelo WhatsApp</a>' : "";
    return '<div class="card"><h3>Precisa de ajuda?</h3><p class="muted small" style="margin:4px 0 0">Fale com a equipe do SpeakerConnect.' + (C.email ? ' E-mail: <a href="mailto:' + e(C.email) + '">' + e(C.email) + "</a>" : "") + "</p>" + wa + "</div>";
  }
  function installHint() {
    var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone) return "";
    if (installEvt) return '<button class="ghost full" id="inst" type="button">Instalar o app no celular</button>';
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return '<p class="muted small center" style="margin-top:14px">No iPhone: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>.</p>';
    return "";
  }
  function bindInstall() { var b = $("inst"); if (b) b.onclick = function () { installEvt.prompt(); installEvt.userChoice.finally(function () { installEvt = null; }); }; }

  // ---------- entrar / criar conta ----------
  function screenAuth(mode, q) {
    stopTimer();
    var signup = mode === "signup";
    var tipo = (q && q.get("tipo")) === "palestrante" ? "speaker" : "company";
    plain(
      '<div class="tabs" role="tablist"><button type="button" id="t1" class="' + (signup ? "" : "on") + '">Entrar</button><button type="button" id="t2" class="' + (signup ? "on" : "") + '">Criar conta</button></div>' +
      '<form class="card" id="f" novalidate>' +
      (signup
        ? '<label>Você é</label><div class="tabs" style="margin:0"><button type="button" id="r-company" class="' + (tipo === "company" ? "on" : "") + '">Empresa</button><button type="button" id="r-speaker" class="' + (tipo === "speaker" ? "on" : "") + '">Palestrante</button></div>' +
          '<label for="nm">Seu nome</label><input id="nm" autocomplete="name" maxlength="100" required>' +
          '<div id="cwrap"' + (tipo === "speaker" ? " hidden" : "") + '><label for="cn">Nome da empresa</label><input id="cn" autocomplete="organization" maxlength="120"></div>' +
          '<label for="ph">WhatsApp <span class="opt">(com DDD)</span></label><input id="ph" type="tel" inputmode="tel" autocomplete="tel" maxlength="20">'
        : "") +
      '<label for="em">E-mail</label><input id="em" type="email" autocomplete="email" required>' +
      '<label for="pw">Senha</label><input id="pw" type="password" autocomplete="' + (signup ? "new-password" : "current-password") + '" minlength="8" required>' +
      (signup ? '<p class="hint">Pelo menos 8 caracteres.</p><label class="check"><input type="checkbox" id="tc"><span>Li e aceito os <a href="/termos.html" target="_blank">termos de uso</a> e a <a href="/privacidade.html" target="_blank">política de privacidade</a>.</span></label>' : "") +
      '<input class="hp" id="hp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<div id="msg" role="alert"></div>' +
      '<button class="full" id="go" type="submit">' + (signup ? "Criar conta" : "Entrar") + "</button>" +
      (signup ? "" : '<p class="center" style="margin:12px 0 0"><a href="#/esqueci">Esqueci minha senha</a></p>') +
      "</form>" + installHint(),
      signup ? "Crie sua conta" : "Bem-vindo de volta",
      signup ? "Leva menos de um minuto." : "Entre para ver seus pedidos e propostas."
    );
    bindInstall();
    $("t1").onclick = function () { go("#/entrar"); };
    $("t2").onclick = function () { go("#/cadastro"); };
    if (signup) {
      $("r-company").onclick = function () { tipo = "company"; this.classList.add("on"); $("r-speaker").classList.remove("on"); $("cwrap").hidden = false; };
      $("r-speaker").onclick = function () { tipo = "speaker"; this.classList.add("on"); $("r-company").classList.remove("on"); $("cwrap").hidden = true; };
    }
    $("f").onsubmit = function (ev) {
      ev.preventDefault();
      var msg = $("msg"), btn = $("go"), em = val("em"), pw = $("pw").value;
      msg.innerHTML = "";
      if (val("hp")) return;
      function fail(t) { msg.innerHTML = '<div class="err">' + e(t) + "</div>"; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return fail("Confira o e-mail.");
      if (pw.length < 8) return fail("A senha precisa ter pelo menos 8 caracteres.");
      busy(btn, true);
      if (!signup) {
        sb.auth.signInWithPassword({ email: em, password: pw }).then(function (r) {
          busy(btn, false);
          if (r.error) return fail(friendly(r.error));
        });
        return;
      }
      var nm = val("nm"), cn = val("cn"), ph = val("ph").replace(/\D/g, "");
      if (nm.length < 2) { busy(btn, false); return fail("Informe seu nome."); }
      if (tipo === "company" && cn.length < 2) { busy(btn, false); return fail("Informe o nome da empresa."); }
      if (ph && (ph.length < 10 || ph.length > 13)) { busy(btn, false); return fail("Confira o WhatsApp. Use o DDD."); }
      if (!$("tc").checked) { busy(btn, false); return fail("Marque o aceite dos termos para continuar."); }
      var data = { role: tipo, name: nm, phone: ph || null, terms_version: TERMS };
      if (tipo === "company") data.company_name = cn;
      sb.auth.signUp({ email: em, password: pw, options: { data: data, emailRedirectTo: location.origin + "/app/" } }).then(function (r) {
        busy(btn, false);
        if (r.error) return fail(friendly(r.error));
        if (!r.data.session) {
          plain('<div class="card"><h3>Confirme seu e-mail</h3><p class="muted" style="margin:6px 0 0">Mandamos um link para <b>' + e(em) + '</b>. Abra o e-mail e toque no link para ativar a conta. Se não chegar em alguns minutos, veja a caixa de spam.</p></div><a class="btn full ghost" href="#/entrar">Já confirmei, quero entrar</a>', "Quase lá");
        }
      });
    };
  }

  function screenForgot() {
    plain('<form class="card" id="f" novalidate><label for="em">E-mail da conta</label><input id="em" type="email" autocomplete="email"><div id="msg" role="alert"></div><button class="full" id="go">Enviar link</button></form><p class="center"><a href="#/entrar">Voltar</a></p>',
      "Esqueci minha senha", "Mandamos um link para você criar uma nova.");
    $("f").onsubmit = function (ev) {
      ev.preventDefault();
      var em = val("em"), btn = $("go");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) { $("msg").innerHTML = '<div class="err">Confira o e-mail.</div>'; return; }
      busy(btn, true);
      sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + "/app/" }).then(function (r) {
        busy(btn, false);
        $("msg").innerHTML = r.error ? '<div class="err">' + e(friendly(r.error)) + "</div>" : '<div class="okmsg">Se este e-mail tiver cadastro, o link chega em alguns minutos.</div>';
      });
    };
  }

  function screenNewPassword() {
    plain('<form class="card" id="f" novalidate><label for="pw">Nova senha</label><input id="pw" type="password" autocomplete="new-password" minlength="8"><p class="hint">Pelo menos 8 caracteres.</p><div id="msg" role="alert"></div><button class="full" id="go">Salvar nova senha</button></form>', "Crie uma nova senha");
    $("f").onsubmit = function (ev) {
      ev.preventDefault();
      var pw = $("pw").value, btn = $("go");
      if (pw.length < 8) { $("msg").innerHTML = '<div class="err">A senha precisa ter pelo menos 8 caracteres.</div>'; return; }
      busy(btn, true);
      sb.auth.updateUser({ password: pw }).then(function (r) {
        busy(btn, false);
        if (r.error) { $("msg").innerHTML = '<div class="err">' + e(friendly(r.error)) + "</div>"; return; }
        recovering = false; toast("Senha alterada."); go("#/");
      });
    };
  }

  // ---------- dados ----------
  function loadMe() {
    return sb.from("profiles").select("*").eq("id", user.id).maybeSingle().then(function (r) {
      profile = r.data;
      if (!profile) return null;
      if (profile.role === "speaker") return sb.from("speakers").select("*").eq("id", user.id).maybeSingle().then(function (s) { me = s.data; });
      if (profile.role === "company") return sb.from("companies").select("*").eq("id", user.id).maybeSingle().then(function (c) { me = c.data; });
    });
  }
  function loadCats() {
    if (cats.length) return Promise.resolve(cats);
    return sb.from("categories").select("name").eq("active", true).order("sort").then(function (r) { cats = (r.data || []).map(function (c) { return c.name; }); return cats; });
  }
  function myQuotes() {
    var col = profile.role === "speaker" ? "speaker_id" : "company_id";
    return sb.from("quotes").select("*").eq(col, user.id).order("created_at", { ascending: false }).limit(200).then(function (r) { return r.data || []; });
  }
  function quoteItem(q) {
    var sp = profile.role === "speaker";
    return '<a class="item" href="#/pedido?id=' + e(q.id) + '">' + avatar(sp ? q.company_name : q.speaker_name) +
      '<div class="grow"><h3>' + e(q.title) + '</h3><div class="sub">' + e(sp ? q.company_name : q.speaker_name) + " · " + e(date(q.event_date)) + "</div>" +
      '<div style="margin-top:6px">' + pill(q.status, sp) + (q.amount_cents ? ' <span class="small muted">' + brl(q.amount_cents) + "</span>" : "") + "</div></div></a>";
  }

  // ---------- início ----------
  function profileChecklist(s) {
    var items = [
      [!!s.photo_url, "Foto"], [(s.headline || "").length >= 10, "Título da palestra"], [(s.bio || "").length >= 80, "Apresentação (mín. 80 letras)"],
      [(s.categories || []).length > 0, "Pelo menos um tema"], [!!(s.city && s.uf), "Cidade e estado"], [!!s.fee_from_cents, "Valor de referência"]
    ];
    return '<ul class="steps">' + items.map(function (i) { return '<li class="' + (i[0] ? "done" : "") + '"><span class="dot">' + (i[0] ? icon("check", 14) : "") + "</span>" + e(i[1]) + "</li>"; }).join("") + "</ul>";
  }
  function speakerStatusCard() {
    var s = me || {};
    if (s.status === "approved") {
      return '<div class="card dark"><h3>Seu perfil está publicado</h3><p class="muted small" style="margin:4px 0 12px">As empresas já encontram você no site.</p><a class="btn spot slim" href="/palestrante.html?id=' + e(s.id) + '">Ver minha página</a></div>' + seloCard();
    }
    if (s.status === "pending") return '<div class="card"><span class="pill warn">Em análise</span><h3 style="margin-top:10px">Recebemos seu perfil</h3><p class="muted small" style="margin:0">Nossa equipe revisa em até 2 dias úteis e avisa você por e-mail.</p></div>';
    if (s.status === "suspended") return '<div class="card"><span class="pill err">Suspenso</span><p class="muted small" style="margin:10px 0 0">Seu perfil está fora do ar. Fale com a equipe para entender o motivo.</p></div>';
    return '<div class="card">' + (s.status === "rejected" ? '<span class="pill err">Precisa de ajustes</span>' + (s.review_note ? '<p class="small" style="margin:10px 0 0"><b>O que ajustar:</b> ' + e(s.review_note) + "</p>" : "") : "<h3>Complete seu perfil</h3>") +
      '<p class="muted small" style="margin:6px 0 0">Depois envie para análise. Perfis aprovados aparecem para as empresas.</p>' + profileChecklist(s) +
      '<a class="btn full" href="#/perfil">Editar meu perfil</a></div>';
  }
  function seloCard() {
    var s = me || {};
    if (isVerified(s)) {
      var until = s.verified_until === "infinity" ? "sem data para vencer" : "válido até " + new Date(s.verified_until).toLocaleDateString("pt-BR");
      return '<div class="card"><span class="pill ok">Palestrante verificado</span><p class="muted small" style="margin:8px 0 0">Selo ativo, ' + e(until) + ".</p></div>";
    }
    return '<div class="card"><h3>Selo de palestrante verificado</h3><p class="muted small" style="margin:4px 0 0">Apareça primeiro na busca e ganhe a marca de verificado no seu perfil.' + (C.verifiedPrice ? " " + e(C.verifiedPrice) + "." : "") + '</p><button class="full spot" id="selo" type="button">Ativar o selo</button><div id="selomsg" role="alert"></div></div>';
  }
  // ---------- recebimento pelo Mercado Pago (Split) ----------
  function loadMpConn() {
    if (!profile || profile.role !== "speaker") return Promise.resolve(null);
    return sb.rpc("mp_connected", { sid: user.id }).then(function (r) { mpConn = !r.error && r.data === true; return mpConn; }).catch(function () { return mpConn; });
  }
  function mpCard() {
    if (mpConn) return '<div class="card"><span class="pill ok">Recebimento ativo</span><p class="muted small" style="margin:8px 0 0">Os pagamentos das empresas caem direto na sua conta do Mercado Pago, já descontada a comissão da plataforma.</p></div>';
    return '<div class="card"><h3>Receba pelo Mercado Pago</h3><p class="muted small" style="margin:4px 0 0">Conecte sua conta para as empresas conseguirem pagar. O valor cai direto para você, já descontada a comissão de ' + (Number(C.commissionPct) || 0) + '%. Se não tiver conta, dá para criar na hora, de graça.</p>' +
      '<button class="full" id="mpc" type="button">Conectar minha conta do Mercado Pago</button><div id="mpcmsg" role="alert"></div></div>';
  }
  function bindMp() {
    var b = $("mpc");
    if (!b) return;
    b.onclick = function () {
      busy(b, true, "Abrindo o Mercado Pago…");
      api("/api/mp/conectar", "POST", {}).then(function (d) { location.href = d.url; }).catch(function (err) {
        busy(b, false); var m = $("mpcmsg"); if (m) m.innerHTML = '<div class="err">' + e(err.message) + "</div>";
      });
    };
  }
  // ---------- pagamento dentro do app (Pix e cartão, Mercado Pago) ----------
  var mpSdk = null, mpSec = null;
  function loadScript(src, attrs) {
    return new Promise(function (ok, bad) {
      var s = document.createElement("script"); s.src = src;
      Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      s.onload = ok; s.onerror = function () { bad(new Error("Não foi possível carregar o pagamento. Confira a internet.")); };
      document.head.appendChild(s);
    });
  }
  function loadMpSdk() {
    if (window.MercadoPago) return Promise.resolve();
    if (!mpSdk) mpSdk = loadScript("https://sdk.mercadopago.com/js/v2").catch(function (x) { mpSdk = null; throw x; });
    return mpSdk;
  }
  // Script de segurança do Mercado Pago: gera o identificador do aparelho usado pelo antifraude.
  function loadMpSecurity() {
    if (window.MP_DEVICE_SESSION_ID) return Promise.resolve();
    if (!mpSec) mpSec = loadScript("https://www.mercadopago.com/v2/security.js", { view: "checkout" }).then(function () { return new Promise(function (ok) { setTimeout(ok, 600); }); }, function () {});
    return mpSec;
  }
  function stopPay() { payActive = false; if (payTimer) { clearInterval(payTimer); payTimer = null; } }
  // opts: { kind: "quote"|"verified", quoteId, amount, onPaid }
  function payPanel(box, opts) {
    payActive = true;
    box.innerHTML = '<div id="payerr" role="alert"></div><div class="row" style="margin-top:4px"><button type="button" class="spot" id="ppix">Pix</button><button type="button" class="ghost" id="pcrd">Cartão</button></div><div id="paybody"></div>' +
      '<p class="hint center" style="margin-top:12px">Pagamento seguro pelo Mercado Pago. Os dados do cartão não passam pelo SpeakerConnect.</p>';
    function err(m) { var b = $("payerr"); if (b) b.innerHTML = m ? '<div class="err" style="margin:0 0 10px">' + e(m) + "</div>" : ""; }
    function base() { var b = { kind: opts.kind }; if (opts.quoteId) b.quote_id = opts.quoteId; return b; }
    function paid() { stopPay(); toast("Pagamento confirmado!"); if (opts.onPaid) opts.onPaid(); }
    function watch(id) {
      if (payTimer) clearInterval(payTimer);
      var n = 0;
      payTimer = setInterval(function () {
        if (++n > 120 || !$("paybody")) { clearInterval(payTimer); payTimer = null; return; }
        api("/api/pagamento?id=" + encodeURIComponent(id), "GET").then(function (d) { if (d.status === "paid") paid(); }).catch(function () {});
      }, 5000);
    }
    function pixView(id, pix) {
      $("paybody").innerHTML = (pix.qr_base64 ? '<img alt="QR Code do Pix" style="width:210px;height:210px;display:block;margin:14px auto 8px;border-radius:12px" src="data:image/png;base64,' + e(pix.qr_base64) + '">' : "") +
        '<p class="small center muted" style="margin:0 0 8px">Abra o app do seu banco, escolha Pix e leia o QR Code, ou copie o código.</p>' +
        '<input id="pixcode" readonly value="' + e(pix.code || "") + '" aria-label="Código Pix copia e cola"><button type="button" class="full" id="cp">Copiar código Pix</button>' +
        '<p class="small center muted" style="margin:10px 0 0">Esta tela atualiza sozinha quando o pagamento for confirmado.' + (pix.expires_at ? " O código vale até " + new Date(pix.expires_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + "." : "") + "</p>";
      $("cp").onclick = function () {
        var v = $("pixcode").value;
        (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () { toast("Código copiado!"); }, function () { $("pixcode").select(); toast("Selecione e copie o código."); });
      };
      watch(id);
    }
    $("ppix").onclick = function () {
      err(""); var b = this; busy(b, true, "Gerando…");
      $("paybody").innerHTML = '<p class="muted small center">Gerando o Pix…</p>';
      api("/api/mp/pagar", "POST", Object.assign(base(), { method: "pix" })).then(function (d) {
        busy(b, false);
        if (d.status === "paid" || d.status === "approved") return paid();
        if (!d.pix || !d.pix.code) throw new Error(d.error || "Não foi possível gerar o Pix agora.");
        pixView(d.id, d.pix);
      }).catch(function (x) { busy(b, false); $("paybody").innerHTML = ""; err(x.message); });
    };
    $("pcrd").onclick = function () {
      err(""); stopPay(); payActive = true;
      $("paybody").innerHTML = '<p class="muted small center">Carregando o formulário do cartão…</p>';
      var cfgUrl = "/api/mp/config" + (opts.quoteId ? "?quote_id=" + encodeURIComponent(opts.quoteId) : "");
      Promise.all([api(cfgUrl, "GET"), loadMpSdk(), loadMpSecurity()]).then(function (r) {
        var mp = new window.MercadoPago(r[0].public_key, { locale: "pt-BR" });
        $("paybody").innerHTML = '<div id="cardbrick" style="margin-top:12px"></div>';
        return mp.bricks().create("cardPayment", "cardbrick", {
          initialization: { amount: opts.amount / 100, payer: { email: (user && user.email) || "" } },
          customization: { paymentMethods: { maxInstallments: 12 } },
          callbacks: {
            onReady: function () {},
            onError: function () { err("Confira os dados do cartão e tente de novo."); },
            onSubmit: function (d) {
              err("");
              return api("/api/mp/pagar", "POST", Object.assign(base(), { method: "card", token: d.token, installments: d.installments, payment_method_id: d.payment_method_id,
                issuer_id: d.issuer_id, identification: d.payer && d.payer.identification, device_id: window.MP_DEVICE_SESSION_ID || null })).then(function (res) {
                if (!res.ok) { err(res.error || "Pagamento não aprovado."); throw new Error("recusado"); }
                if (res.status === "paid" || res.status === "approved") return paid();
                toast("Pagamento em análise pelo Mercado Pago. Avisamos por e-mail."); watch(res.id);
              });
            }
          }
        });
      }).catch(function (x) { $("paybody").innerHTML = ""; err(x.message || "Não foi possível abrir o cartão. Use o Pix."); });
    };
  }

  function screenSelo() {
    stopTimer(); stopPay();
    var head = topbar("Selo de verificado", "#/conta");
    if (profile.role !== "speaker") { go("#/"); return; }
    if (isVerified(me)) { shell(seloCard(), "conta", head); return; }
    if (!me || me.status !== "approved") { shell('<div class="card"><h3>Primeiro, a aprovação</h3><p class="muted small" style="margin:6px 0 0">O selo pode ser ativado depois que a equipe aprovar seu perfil.</p></div>', "conta", head); return; }
    shell('<div class="card dark"><span class="pill ok">Palestrante verificado</span><h3 style="margin-top:12px">Apareça primeiro e ganhe a marca de verificado</h3><p class="muted small" style="margin:6px 0 0">' + e(C.verifiedPrice || "") + '. Você pode desistir em até 7 dias e receber o valor de volta.</p></div>' +
      '<div class="card"><p class="muted small" style="margin:0">Valor</p><p class="price">Carregando…</p><div id="paybox"></div></div>', "conta", head);
    api("/api/mp/config", "GET").then(function (cfg) {
      document.querySelector(".price").textContent = brl(cfg.amount_cents);
      payPanel($("paybox"), { kind: "verified", amount: cfg.amount_cents, onPaid: function () { loadMe().then(function () { go("#/"); }); } });
    }).catch(function (x) { $("paybox").innerHTML = '<div class="err">' + e(x.message) + "</div>"; });
  }

  function bindSelo() {
    var b = $("selo");
    if (!b) return;
    b.onclick = function () {
      go("#/selo");
    };
  }
  function screenHome() {
    stopTimer();
    var first = (profile.name || "").split(" ")[0];
    var head = '<div class="hero"><div class="hrow">' + LOGO + "</div><p class=\"hello\">Olá, " + e(first) + "</p><h1>" +
      (profile.role === "speaker" ? "Seus palcos começam aqui" : "Encontre o palestrante do seu próximo evento") + "</h1>" +
      (profile.role === "company" ? '<a class="btn spot full" href="/#palestrantes">' + icon("search", 18) + "Ver palestrantes</a>" : "") + "</div>";
    shell('<p class="boot" style="padding:30px 0">Carregando…</p>', "home", head);
    Promise.all([myQuotes(), loadMpConn()]).then(function (res) {
      var qs = res[0];
      var open = qs.filter(function (q) { return ["requested", "proposed", "accepted"].indexOf(q.status) > -1; });
      var html = "";
      if (profile.role === "speaker") {
        html += speakerStatusCard();
        if (me && me.status !== "draft" && me.status !== "rejected") html += mpCard();
        var todo = qs.filter(function (q) { return q.status === "requested"; });
        html += "<h2>" + (todo.length ? "Pedidos para responder" : "Pedidos recentes") + "</h2>";
        var list = todo.length ? todo : qs.slice(0, 5);
        html += list.length ? '<div class="list">' + list.map(quoteItem).join("") + "</div>" : '<div class="card empty"><h3>Nenhum pedido ainda</h3><p class="small">Quando uma empresa pedir orçamento, ele aparece aqui e chega no seu e-mail.</p></div>';
      } else {
        var pay = qs.filter(function (q) { return q.status === "accepted"; });
        if (pay.length) html += '<div class="card dark"><h3>Falta pagar</h3><p class="muted small" style="margin:4px 0 12px">' + e(pay[0].title) + " com " + e(pay[0].speaker_name) + '</p><a class="btn spot slim" href="#/pedido?id=' + e(pay[0].id) + '">Ver e pagar</a></div>';
        html += "<h2>Seus pedidos em andamento</h2>";
        html += open.length ? '<div class="list">' + open.map(quoteItem).join("") + "</div>" :
          '<div class="card empty"><h3>Nenhum pedido em andamento</h3><p class="small">Escolha um palestrante no site e toque em <b>Pedir orçamento</b>.</p><a class="btn slim" href="/#palestrantes">Ver palestrantes</a></div>';
      }
      html += supportCard();
      shell(html, "home", head);
      bindSelo(); bindMp();
    }).catch(function (err) { shell('<div class="err">' + e(friendly(err)) + "</div>", "home", head); });
  }

  // ---------- pedidos ----------
  function screenQuotes() {
    stopTimer();
    var head = topbar("Pedidos");
    shell('<p class="boot">Carregando…</p>', "pedidos", head);
    myQuotes().then(function (qs) {
      var active = qs.filter(function (q) { return ["requested", "proposed", "accepted", "paid"].indexOf(q.status) > -1; });
      var past = qs.filter(function (q) { return active.indexOf(q) < 0; });
      var html = active.length ? '<div class="list">' + active.map(quoteItem).join("") + "</div>" :
        '<div class="card empty"><h3>Nenhum pedido em andamento</h3>' + (profile.role === "company" ? '<p class="small">Escolha um palestrante no site para pedir o primeiro orçamento.</p><a class="btn slim" href="/#palestrantes">Ver palestrantes</a>' : '<p class="small">Os pedidos das empresas aparecem aqui.</p>') + "</div>";
      if (past.length) html += "<h2>Encerrados</h2><div class=\"list\">" + past.map(quoteItem).join("") + "</div>";
      shell(html, "pedidos", head);
    }).catch(function (err) { shell('<div class="err">' + e(friendly(err)) + "</div>", "pedidos", head); });
  }

  // ---------- novo pedido (empresa) ----------
  var UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
  function ufSelect(id, cur) { return '<select id="' + id + '"><option value="">UF</option>' + UFS.map(function (u) { return "<option" + (u === cur ? " selected" : "") + ">" + u + "</option>"; }).join("") + "</select>"; }
  function screenNewQuote(q) {
    stopTimer();
    var pid = q.get("p") || "";
    var head = topbar("Pedir orçamento", "/palestrante.html?id=" + encodeURIComponent(pid));
    if (profile.role !== "company") {
      shell('<div class="card"><h3>Pedidos são feitos por empresas</h3><p class="muted small" style="margin:6px 0 0">Você entrou como palestrante. Para pedir um orçamento, crie uma conta de empresa com outro e-mail.</p></div>', "pedidos", head);
      return;
    }
    if (!/^[0-9a-f-]{36}$/.test(pid)) { go("#/"); return; }
    shell('<p class="boot">Carregando…</p>', "pedidos", head);
    sb.from("speakers").select("id,public_name,headline,photo_url,formats,fee_from_cents").eq("id", pid).eq("status", "approved").maybeSingle().then(function (r) {
      var s = r.data;
      if (!s) { shell('<div class="card empty"><h3>Este palestrante não está disponível</h3><a class="btn slim" href="/#palestrantes">Ver outros palestrantes</a></div>', "pedidos", head); return; }
      var online = (s.formats || []).indexOf("online") > -1, pres = (s.formats || []).indexOf("presencial") > -1;
      var c = me || {};
      shell('<div class="item" style="margin-bottom:14px">' + avatar(s.public_name, s.photo_url) + '<div class="grow"><h3>' + e(s.public_name) + '</h3><div class="sub">' + e(s.headline || "") + "</div>" +
        (s.fee_from_cents ? '<div class="small muted" style="margin-top:4px">A partir de ' + brl(s.fee_from_cents) + "</div>" : "") + "</div></div>" +
        '<form class="card" id="f" novalidate>' +
        '<label for="ti">Nome do evento</label><input id="ti" maxlength="120" placeholder="Ex.: SIPAT 2026, convenção de vendas">' +
        '<div class="row"><div><label for="dt">Data <span class="opt">(se já tiver)</span></label><input id="dt" type="date"></div>' +
        '<div><label for="du">Duração</label><select id="du"><option value="">A combinar</option><option value="30">30 min</option><option value="60" selected>1 hora</option><option value="90">1h30</option><option value="120">2 horas</option><option value="240">Meio período</option></select></div></div>' +
        '<label for="fm">Formato</label><select id="fm">' + (pres ? '<option value="presencial">Presencial</option>' : "") + (online ? '<option value="online">Online</option>' : "") + "</select>" +
        '<div id="locw"><div class="row"><div style="flex:2"><label for="ci">Cidade do evento</label><input id="ci" maxlength="60" value="' + e(c.city || "") + '"></div><div><label for="uf">UF</label>' + ufSelect("uf", c.uf) + "</div></div></div>" +
        '<label for="au">Público estimado <span class="opt">(pessoas)</span></label><input id="au" type="number" inputmode="numeric" min="1" max="100000">' +
        '<label for="ms">O que vocês esperam da palestra?</label><textarea id="ms" maxlength="2000" placeholder="Objetivo, perfil do público, horário, tema que gostariam de abordar…"></textarea>' +
        '<div id="msg" role="alert"></div><button class="full" id="go">Enviar pedido</button>' +
        '<p class="hint center">Pedir não custa nada. Você só paga se aceitar a proposta.</p></form>', "pedidos", head);
      function loc() { $("locw").hidden = $("fm").value === "online"; }
      $("fm").onchange = loc; loc();
      $("f").onsubmit = function (ev) {
        ev.preventDefault();
        var btn = $("go"), title = val("ti"), fmt = $("fm").value, aud = parseInt(val("au"), 10);
        function fail(t) { $("msg").innerHTML = '<div class="err">' + e(t) + "</div>"; }
        if (title.length < 3) return fail("Dê um nome para o evento.");
        if (fmt === "presencial" && (!val("ci") || !val("uf"))) return fail("Informe a cidade e o estado do evento.");
        if (val("dt") && val("dt") < new Date().toISOString().slice(0, 10)) return fail("A data do evento já passou.");
        busy(btn, true, "Enviando…");
        sb.from("quotes").insert({
          company_id: user.id, speaker_id: s.id, title: title, event_date: val("dt") || null, format: fmt,
          city: fmt === "presencial" ? val("ci") : null, uf: fmt === "presencial" ? val("uf") : null,
          audience: aud > 0 ? aud : null, duration_min: parseInt(val("du"), 10) || null, message: val("ms") || null
        }).select("id").single().then(function (r) {
          busy(btn, false);
          if (r.error) return fail(friendly(r.error));
          toast("Pedido enviado. Avisamos o palestrante.");
          go("#/pedido?id=" + r.data.id);
        });
      };
    });
  }

  // ---------- detalhe do pedido ----------
  function api(path, method, body) {
    return sb.auth.getSession().then(function (r) {
      var token = r.data && r.data.session && r.data.session.access_token;
      return fetch(path, { method: method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || "Não foi possível concluir agora."); return d; });
    });
  }
  function screenQuote(q) {
    stopTimer();
    var id = q.get("id") || "";
    var head = topbar("Pedido", "#/pedidos");
    if (!/^[0-9a-f-]{36}$/.test(id)) { go("#/pedidos"); return; }
    shell('<p class="boot">Carregando…</p>', "pedidos", head);
    var sp = profile.role === "speaker";
    function load() {
      return Promise.all([
        sb.from("quotes").select("*").eq("id", id).maybeSingle(),
        sb.from("quote_messages").select("*").eq("quote_id", id).order("created_at").limit(300),
        sp ? loadMpConn() : null
      ]);
    }
    function render(res) {
      var Q = res[0].data, msgs = res[1].data || [];
      if (!Q) { shell('<div class="card empty"><h3>Pedido não encontrado</h3></div>', "pedidos", head); return; }
      var other = sp ? Q.company_name : Q.speaker_name;
      var pct = Number(C.commissionPct) || 0;
      var html = '<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:start"><div><h3 style="font-size:19px">' + e(Q.title) + '</h3><p class="muted small" style="margin:0">' + (sp ? "Empresa: " : "Palestrante: ") + e(other) + "</p></div>" + pill(Q.status, sp) + "</div>" +
        '<dl class="kv" style="margin-top:14px"><dt>Data</dt><dd>' + e(date(Q.event_date)) + "</dd><dt>Formato</dt><dd>" + (Q.format === "online" ? "Online" : "Presencial" + (Q.city ? " em " + e(Q.city) + (Q.uf ? "/" + e(Q.uf) : "") : "")) + "</dd>" +
        (Q.audience ? "<dt>Público</dt><dd>" + e(Q.audience) + " pessoas</dd>" : "") + (Q.duration_min ? "<dt>Duração</dt><dd>" + (Q.duration_min >= 60 ? (Q.duration_min / 60).toString().replace(".", ",") + " h" : Q.duration_min + " min") + "</dd>" : "") + "</dl>" +
        (Q.message ? '<p class="small" style="margin:12px 0 0;white-space:pre-wrap">' + e(Q.message) + "</p>" : "") + "</div>";

      // proposta
      if (Q.amount_cents) {
        html += '<div class="card"><p class="muted small" style="margin:0">' + (Q.status === "declined" ? "Última proposta" : "Proposta") + '</p><p class="price">' + brl(Q.amount_cents) + "</p>" +
          (Q.speaker_note ? '<p class="small" style="margin:6px 0 0;white-space:pre-wrap">' + e(Q.speaker_note) + "</p>" : "");
        if (sp && pct) {
          var com = Math.round(Q.amount_cents * pct / 100);
          html += '<div class="split"><span class="muted">Comissão da plataforma (' + pct + '%)</span><span>− ' + brl(com) + '</span><span class="tot">Você recebe</span><span class="tot">' + brl(Q.amount_cents - com) + "</span></div>" +
            '<p class="hint" style="margin-top:8px">Direto na sua conta do Mercado Pago, quando a empresa pagar.</p>';
        }
        html += "</div>";
      } else if (Q.status === "declined" && Q.speaker_note) {
        html += '<div class="card"><p class="muted small" style="margin:0">Motivo</p><p style="margin:4px 0 0">' + e(Q.speaker_note) + "</p></div>";
      }

      // ações
      if (sp && (Q.status === "requested" || Q.status === "proposed")) {
        html += '<form class="card" id="pf" novalidate><h3>' + (Q.status === "proposed" ? "Atualizar proposta" : "Enviar proposta") + "</h3>" +
          '<label for="am">Valor total da palestra</label><input id="am" inputmode="decimal" placeholder="Ex.: 4.500,00" value="' + (Q.amount_cents ? (Q.amount_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : "") + '">' +
          '<p class="hint">Inclua deslocamento e materiais, se houver. A comissão de ' + pct + "% é descontada desse valor.</p>" +
          '<label for="nt">Observações <span class="opt">(o que está incluso)</span></label><textarea id="nt" maxlength="1000">' + e(Q.speaker_note || "") + "</textarea>" +
          '<div id="pmsg" role="alert"></div>' +
          (mpConn ? '<button class="full" id="psend">Enviar proposta</button>'
                  : '<div class="err">Antes de enviar a proposta, conecte sua conta do Mercado Pago. É nela que você recebe o pagamento da empresa.</div><button class="full" id="mpc" type="button">Conectar minha conta do Mercado Pago</button>') +
          '<button class="full danger" type="button" id="pdecl">Não posso atender</button></form>';
      }
      if (!sp && Q.status === "proposed") html += '<button class="full" id="acc" type="button">Aceitar proposta de ' + brl(Q.amount_cents) + "</button>";
      if (!sp && Q.status === "accepted") html += '<div class="card"><h3>Pagamento</h3><p class="price">' + brl(Q.amount_cents) + '</p><p class="muted small" style="margin:4px 0 8px">Pague por Pix ou cartão aqui mesmo. O valor vai para o palestrante pelo Mercado Pago, e o contato dele é liberado assim que o pagamento for confirmado.</p><div id="paybox"></div></div>';
      if (sp && Q.status === "accepted") html += '<div class="card"><h3>Aguardando o pagamento da empresa</h3><p class="muted small" style="margin:4px 0 0">Avisamos você por e-mail assim que ele for confirmado.</p></div>';
      if (Q.status === "paid" || Q.status === "done") html += '<div class="card" id="contacts"><h3>Contato liberado</h3><p class="muted small">Carregando…</p></div>';
      if (!sp && Q.status === "paid") html += '<button class="full ghost" id="done" type="button">A palestra já aconteceu</button>';

      // conversa
      var canWrite = ["declined", "cancelled"].indexOf(Q.status) < 0;
      html += "<h2>Mensagens</h2>";
      html += '<div class="chat" id="chat">' + (msgs.length ? msgs.map(function (m) {
        var mine = m.sender_id === user.id;
        return '<div class="bubble' + (mine ? " me" : "") + '">' + e(m.body) + "<small>" + (mine ? "Você" : e(other)) + ", " + e(when(m.created_at)) + "</small></div>";
      }).join("") : '<p class="muted small center">Nenhuma mensagem ainda. Use este espaço para combinar os detalhes.</p>') + "</div>";
      if (canWrite) html += '<form class="composer" id="cf"><label class="hp" for="mb">Mensagem</label><textarea id="mb" maxlength="2000" placeholder="Escreva uma mensagem"></textarea><button aria-label="Enviar mensagem">' + icon("send", 20) + "</button></form>" +
        (["paid", "done"].indexOf(Q.status) < 0 ? '<p class="hint">Para sua segurança, combine o pagamento só pela plataforma. Os contatos são liberados depois do pagamento.</p>' : "");
      if (!sp && ["requested", "proposed", "accepted"].indexOf(Q.status) > -1) html += '<button class="full linkbtn" id="cancel" type="button">Cancelar pedido</button>';

      shell(html, "pedidos", head);
      bind(Q);
    }
    function update(patch, okMsg) {
      return sb.from("quotes").update(patch).eq("id", id).select("id").then(function (r) {
        if (r.error) { toast(friendly(r.error)); return; }
        if (okMsg) toast(okMsg);
        load().then(render);
      });
    }
    function bind(Q) {
      bindMp();
      if ($("pf")) {
        $("pf").onsubmit = function (ev) {
          ev.preventDefault();
          if (!mpConn) return;
          var cents = parseBrl(val("am"));
          if (!(cents >= 100)) { $("pmsg").innerHTML = '<div class="err">Informe o valor. Ex.: 4.500,00</div>'; return; }
          busy($("psend"), true);
          update({ status: "proposed", amount_cents: cents, speaker_note: val("nt") || null }, "Proposta enviada.");
        };
        $("pdecl").onclick = function () {
          var why = window.prompt("Quer dizer o motivo para a empresa? (opcional)", "Agenda indisponível nesta data.");
          if (why === null) return;
          update({ status: "declined", speaker_note: String(why).slice(0, 1000) || null }, "Pedido recusado.");
        };
      }
      if ($("acc")) $("acc").onclick = function () {
        if (!window.confirm("Aceitar a proposta de " + brl(Q.amount_cents) + "? Em seguida você poderá pagar.")) return;
        update({ status: "accepted" }, "Proposta aceita.");
      };
      if ($("paybox")) payPanel($("paybox"), { kind: "quote", quoteId: Q.id, amount: Q.amount_cents, onPaid: function () { load().then(render); } });
      if ($("done")) $("done").onclick = function () { update({ status: "done" }, "Que bom! Obrigado por usar o SpeakerConnect."); };
      if ($("cancel")) $("cancel").onclick = function () { if (window.confirm("Cancelar este pedido?")) update({ status: "cancelled" }, "Pedido cancelado."); };
      if ($("contacts")) sb.rpc("quote_contacts", { qid: Q.id }).then(function (r) {
        var c = (r.data || [])[0], box = $("contacts");
        if (!box) return;
        if (!c) { box.innerHTML = '<h3>Contato</h3><p class="muted small" style="margin:0">Ainda não disponível.</p>'; return; }
        var nm = sp ? c.company_contact : c.speaker_contact, ph = sp ? c.company_phone : c.speaker_phone, em = sp ? c.company_email : c.speaker_email;
        var d = String(ph || "").replace(/\D/g, ""); if (d && d.indexOf("55") !== 0) d = "55" + d;
        box.innerHTML = '<h3>Contato liberado</h3><dl class="kv" style="margin-top:10px"><dt>Nome</dt><dd>' + e(nm) + "</dd>" + (em ? '<dt>E-mail</dt><dd><a href="mailto:' + e(em) + '">' + e(em) + "</a></dd>" : "") + (ph ? "<dt>Telefone</dt><dd>" + e(ph) + "</dd>" : "") + "</dl>" +
          (d.length >= 12 ? '<a class="btn full ghost" href="https://wa.me/' + d + '" target="_blank" rel="noopener">' + icon("phone", 18) + "Chamar no WhatsApp</a>" : "");
      });
      if ($("cf")) {
        $("cf").onsubmit = function (ev) {
          ev.preventDefault();
          var body = val("mb");
          if (!body) return;
          var b = this.querySelector("button"); b.disabled = true;
          sb.from("quote_messages").insert({ quote_id: Q.id, body: body }).then(function (r) {
            b.disabled = false;
            if (r.error) { toast(friendly(r.error)); return; }
            load().then(render);
          });
        };
        $("mb").onkeydown = function (ev) { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) $("cf").requestSubmit(); };
      }
    }
    load().then(function (res) {
      render(res);
      // novas mensagens a cada 20 s, sem atrapalhar quem está digitando
      timer = setInterval(function () {
        var typing = $("mb") && $("mb").value, editing = $("am") && document.activeElement && document.activeElement.closest && document.activeElement.closest("form");
        if (typing || editing || payActive || document.hidden) return;
        load().then(render);
      }, 20000);
    }).catch(function (err) { shell('<div class="err">' + e(friendly(err)) + "</div>", "pedidos", head); });
  }

  // ---------- perfil do palestrante ----------
  function resizeImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 900, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { b ? res(b) : rej(new Error("imagem")); }, "image/jpeg", 0.85);
      };
      img.onerror = function () { rej(new Error("Não consegui abrir essa imagem. Use JPG ou PNG.")); };
      img.src = url;
    });
  }
  function screenProfile() {
    stopTimer();
    var head = topbar("Meu perfil público");
    if (profile.role !== "speaker") { go("#/conta"); return; }
    loadCats().then(function () {
      var s = me || {};
      var status = { draft: ["Rascunho", "warn"], pending: ["Em análise", "warn"], approved: ["Publicado", "ok"], rejected: ["Precisa de ajustes", "err"], suspended: ["Suspenso", "err"] }[s.status] || ["", ""];
      var html = '<p style="margin:0 0 12px"><span class="pill ' + status[1] + '">' + status[0] + "</span>" + (s.status === "approved" ? ' <a class="small" href="/palestrante.html?id=' + e(s.id) + '">Ver página</a>' : "") + "</p>" +
        (s.status === "rejected" && s.review_note ? '<div class="err" style="margin:0 0 12px"><b>O que ajustar:</b> ' + e(s.review_note) + "</div>" : "") +
        '<form id="f" class="pform" novalidate><div class="card"><div class="photo">' + avatar(s.public_name, s.photo_url).replace('class="av"', 'class="av" id="pv"') +
        '<div><label for="pic" class="btn slim ghost" style="margin:0;cursor:pointer">Trocar foto</label><input id="pic" type="file" accept="image/jpeg,image/png,image/webp" hidden><p class="hint">Rosto bem visível, fundo neutro.</p></div></div>' +
        '<label for="pn">Nome público</label><input id="pn" maxlength="100" value="' + e(s.public_name || "") + '">' +
        '<label for="hl">Título <span class="opt">(uma frase sobre o que você entrega)</span></label><input id="hl" maxlength="120" value="' + e(s.headline || "") + '" placeholder="Ex.: Segurança do trabalho que as equipes levam para casa">' +
        '<label for="bi">Apresentação</label><textarea id="bi" maxlength="4000" style="min-height:160px" placeholder="Sua trajetória, experiência e o que a plateia leva da palestra.">' + e(s.bio || "") + "</textarea><p class=\"hint\" id=\"bic\"></p>" +
        '<label for="tp">Palestras e temas <span class="opt">(opcional)</span></label><textarea id="tp" maxlength="1500" placeholder="Uma palestra por linha">' + e(s.topics || "") + "</textarea></div>" +
        '<div class="card"><label style="margin-top:0">Temas <span class="opt">(até 5)</span></label><div class="chips" id="cats">' +
        cats.map(function (c) { return '<label><input type="checkbox" value="' + e(c) + '"' + ((s.categories || []).indexOf(c) > -1 ? " checked" : "") + ">" + e(c) + "</label>"; }).join("") + "</div>" +
        '<label>Formatos</label><div class="chips"><label><input type="checkbox" id="fp"' + ((s.formats || []).indexOf("presencial") > -1 ? " checked" : "") + '>Presencial</label><label><input type="checkbox" id="fo"' + ((s.formats || []).indexOf("online") > -1 ? " checked" : "") + ">Online</label></div>" +
        '<div class="row"><div style="flex:2"><label for="ci">Cidade onde você mora</label><input id="ci" maxlength="60" value="' + e(s.city || "") + '"></div><div><label for="uf">UF</label>' + ufSelect("uf", s.uf) + "</div></div>" +
        '<label for="fe">Valor de referência <span class="opt">(a partir de)</span></label><input id="fe" inputmode="decimal" placeholder="Ex.: 3.500,00" value="' + (s.fee_from_cents ? (s.fee_from_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : "") + '"><p class="hint">Aparece no seu perfil. O valor de cada evento você define na proposta.</p></div>' +
        '<div class="card"><label for="vd" style="margin-top:0">Vídeo <span class="opt">(link do YouTube ou Vimeo)</span></label><input id="vd" type="url" inputmode="url" maxlength="300" value="' + e(s.video_url || "") + '" placeholder="https://youtube.com/…">' +
        '<label for="ln">LinkedIn <span class="opt">(opcional)</span></label><input id="ln" type="url" inputmode="url" maxlength="300" value="' + e(s.linkedin || "") + '" placeholder="https://linkedin.com/in/…">' +
        '<label for="ig">Instagram <span class="opt">(opcional)</span></label><input id="ig" maxlength="60" value="' + e(s.instagram || "") + '" placeholder="@seuperfil"></div>' +
        '<div id="msg" role="alert"></div><button class="full" id="save">Salvar</button>' +
        (s.status === "draft" || s.status === "rejected" ? '<button class="full spot" type="button" id="submit">Salvar e enviar para análise</button>' : "") +
        "</form>";
      shell(html, "perfil", head);
      function count() { var n = val("bi").length; $("bic").textContent = n < 80 ? "Faltam " + (80 - n) + " letras para o mínimo." : n + " letras."; }
      $("bi").oninput = count; count();
      $("cats").onchange = function (ev) {
        var on = $("cats").querySelectorAll("input:checked");
        if (on.length > 5) { ev.target.checked = false; toast("Escolha até 5 temas."); }
      };
      $("pic").onchange = function () {
        var f = this.files && this.files[0];
        if (!f) return;
        if (f.size > 12 * 1024 * 1024) { toast("Imagem muito grande."); return; }
        toast("Enviando foto…");
        resizeImage(f).then(function (blob) {
          var path = user.id + "/foto-" + Date.now() + ".jpg";
          return sb.storage.from("fotos").upload(path, blob, { contentType: "image/jpeg", upsert: false }).then(function (r) {
            if (r.error) throw r.error;
            var url = sb.storage.from("fotos").getPublicUrl(path).data.publicUrl;
            return sb.from("speakers").update({ photo_url: url }).eq("id", user.id).then(function (u) {
              if (u.error) throw u.error;
              me.photo_url = url;
              $("pv").innerHTML = '<img src="' + e(url) + '" alt="">';
              toast("Foto atualizada.");
            });
          });
        }).catch(function (err) { toast(friendly(err)); });
      };
      function collect() {
        var catsOn = Array.prototype.map.call($("cats").querySelectorAll("input:checked"), function (i) { return i.value; });
        var formats = [];
        if ($("fp").checked) formats.push("presencial");
        if ($("fo").checked) formats.push("online");
        var fee = val("fe") ? parseBrl(val("fe")) : null;
        var https = function (u) { return u ? (/^https:\/\//.test(u) ? u : /^http:\/\//.test(u) ? u.replace(/^http:/, "https:") : "https://" + u) : null; };
        return {
          error: val("pn").length < 2 ? "Informe o nome público." : !formats.length ? "Escolha pelo menos um formato." : (val("fe") && !(fee > 0)) ? "Confira o valor de referência. Ex.: 3.500,00" : null,
          data: { public_name: val("pn"), headline: val("hl") || null, bio: val("bi") || null, topics: val("tp") || null, categories: catsOn, formats: formats,
                  city: val("ci") || null, uf: val("uf") || null, fee_from_cents: fee || null, video_url: https(val("vd")), linkedin: https(val("ln")), instagram: val("ig") || null }
        };
      }
      function save(sendReview) {
        var c = collect(), btn = sendReview ? $("submit") : $("save");
        $("msg").innerHTML = "";
        if (c.error) { $("msg").innerHTML = '<div class="err">' + e(c.error) + "</div>"; return; }
        if (sendReview) c.data.status = "pending";
        busy(btn, true, "Salvando…");
        sb.from("speakers").update(c.data).eq("id", user.id).select("*").single().then(function (r) {
          busy(btn, false);
          if (r.error) { $("msg").innerHTML = '<div class="err">' + e(friendly(r.error)) + "</div>"; return; }
          me = r.data;
          toast(sendReview ? "Perfil enviado para análise." : "Perfil salvo.");
          if (sendReview) go("#/"); else screenProfile();
        });
      }
      $("f").onsubmit = function (ev) { ev.preventDefault(); save(false); };
      if ($("submit")) $("submit").onclick = function () { save(true); };
    });
  }

  // ---------- conta ----------
  function screenAccount() {
    stopTimer();
    var head = topbar("Conta");
    var co = profile.role === "company", c = me || {};
    var html = '<form class="card" id="f" novalidate><h3>Seus dados</h3>' +
      '<label for="nm">Seu nome</label><input id="nm" maxlength="100" value="' + e(profile.name) + '">' +
      '<label for="ph">WhatsApp</label><input id="ph" type="tel" inputmode="tel" maxlength="20" value="' + e(profile.phone || "") + '"><p class="hint">Só é mostrado para a outra parte depois do pagamento.</p>' +
      '<label>E-mail</label><input value="' + e(profile.email || user.email || "") + '" disabled>' +
      (co ? '<label for="cn">Nome da empresa</label><input id="cn" maxlength="120" value="' + e(c.company_name || "") + '">' +
        '<label for="cj">CNPJ <span class="opt">(opcional)</span></label><input id="cj" inputmode="numeric" maxlength="18" value="' + e(c.cnpj || "") + '">' +
        '<div class="row"><div style="flex:2"><label for="ci">Cidade</label><input id="ci" maxlength="60" value="' + e(c.city || "") + '"></div><div><label for="uf">UF</label>' + ufSelect("uf", c.uf) + "</div></div>" +
        '<label for="ws">Site <span class="opt">(opcional)</span></label><input id="ws" maxlength="200" value="' + e(c.website || "") + '">' : "") +
      '<div id="msg" role="alert"></div><button class="full" id="save">Salvar</button></form>';
    if (profile.role === "speaker") html += '<div id="mpbox"></div>' + seloCard();
    html += supportCard();
    html += '<button class="full ghost" id="out" type="button">Sair</button>' +
      '<button class="full linkbtn" id="del" type="button" style="color:var(--err)!important">Apagar minha conta</button>' +
      '<p class="center small muted" style="margin-top:14px"><a href="/termos.html">Termos</a> · <a href="/privacidade.html">Privacidade</a></p>';
    shell(html, "conta", head);
    bindSelo();
    var back = hashParts().q.get("mp");
    if (back === "ok") toast("Conta do Mercado Pago conectada.");
    if (back === "erro") toast("Não foi possível conectar a conta. Tente de novo.");
    if (profile.role === "speaker") loadMpConn().then(function () { var bx = $("mpbox"); if (bx) { bx.innerHTML = mpCard(); bindMp(); } });
    $("f").onsubmit = function (ev) {
      ev.preventDefault();
      var btn = $("save"), ph = val("ph").replace(/\D/g, ""), cj = co ? val("cj").replace(/\D/g, "") : "";
      function fail(t) { $("msg").innerHTML = '<div class="err">' + e(t) + "</div>"; }
      if (val("nm").length < 2) return fail("Informe seu nome.");
      if (ph && (ph.length < 10 || ph.length > 13)) return fail("Confira o WhatsApp. Use o DDD.");
      if (co && val("cn").length < 2) return fail("Informe o nome da empresa.");
      if (cj && cj.length !== 14) return fail("O CNPJ tem 14 números.");
      busy(btn, true, "Salvando…");
      var jobs = [sb.from("profiles").update({ name: val("nm"), phone: ph || null }).eq("id", user.id)];
      if (co) jobs.push(sb.from("companies").update({ company_name: val("cn"), cnpj: cj || null, city: val("ci") || null, uf: val("uf") || null, website: val("ws") || null }).eq("id", user.id));
      Promise.all(jobs).then(function (rs) {
        busy(btn, false);
        var err = rs.filter(function (r) { return r.error; })[0];
        if (err) return fail(friendly(err.error));
        loadMe().then(function () { toast("Dados salvos."); });
      });
    };
    $("out").onclick = function () { sb.auth.signOut(); };
    $("del").onclick = function () {
      var w = window.prompt("Isso apaga sua conta, perfil, pedidos e mensagens. Registros de pagamento ficam guardados como manda a lei.\n\nPara confirmar, digite APAGAR:");
      if (w === null) return;
      if (String(w).trim().toUpperCase() !== "APAGAR") { toast("Conta mantida."); return; }
      api("/api/conta", "DELETE").then(function () { sb.auth.signOut(); toast("Conta apagada."); })
        .catch(function (err) { toast(err.message); });
    };
  }

  // ---------- rotas ----------
  function hashParts() {
    var h = location.hash || "#/", i = h.indexOf("?");
    return { path: i < 0 ? h : h.slice(0, i), q: new URLSearchParams(i < 0 ? "" : h.slice(i + 1)) };
  }
  function route() {
    stopPay();
    var p = hashParts();
    if (p.path === "#/sair") {
      if (route.leaving) return;
      route.leaving = true;
      app.innerHTML = '<p class="boot">Saindo…</p>';
      sb.auth.signOut().then(function () { location.replace("/"); }, function () { location.replace("/"); });
      return;
    }
    if (recovering) return screenNewPassword();
    if (!user) {
      if (p.path === "#/novo-pedido") { try { sessionStorage.setItem("sc_after_login", location.hash); } catch (x) {} return screenAuth("signup", new URLSearchParams("tipo=empresa")); }
      if (p.path === "#/cadastro") return screenAuth("signup", p.q);
      if (p.path === "#/esqueci") return screenForgot();
      return screenAuth("login");
    }
    if (!profile) {
      app.className = "noNav";
      app.innerHTML = '<div class="pad"><div class="card"><h3>Não encontramos seu perfil</h3><p class="muted small">Saia e entre de novo. Se continuar, fale com a equipe.</p><button class="full" id="out">Sair</button></div></div>';
      $("out").onclick = function () { sb.auth.signOut(); };
      return;
    }
    if (profile.role === "admin") {
      // A equipe vai direto para o painel. Só explica quando ela tenta pedir orçamento (ação de empresa).
      if (p.path !== "#/novo-pedido") { location.replace("/equipe/"); return; }
      app.className = "noNav";
      app.innerHTML = '<div class="pad"><div class="card"><h3>Você entrou com a conta da equipe</h3><p class="muted small" style="margin:6px 0 0">Contas da equipe não pedem orçamento nem têm perfil de palestrante. Para testar como empresa ou palestrante, saia e entre com outra conta.</p>' +
        '<a class="btn full" href="/equipe/">Abrir o painel da equipe</a><button class="full ghost" id="out" type="button">Sair e entrar com outra conta</button></div></div>';
      $("out").onclick = function () { sb.auth.signOut(); };
      return;
    }
    var after = null; try { after = sessionStorage.getItem("sc_after_login"); if (after) sessionStorage.removeItem("sc_after_login"); } catch (x) {}
    if (after && after !== location.hash) { location.hash = after; return; }
    if (p.path === "#/pedidos") return screenQuotes();
    if (p.path === "#/pedido") return screenQuote(p.q);
    if (p.path === "#/novo-pedido") return screenNewQuote(p.q);
    if (p.path === "#/perfil") return screenProfile();
    if (p.path === "#/conta") return screenAccount();
    if (p.path === "#/selo") return screenSelo();
    return screenHome();
  }

  // ---------- início ----------
  function boot() {
    var ok = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(C.supabaseUrl || "") && C.supabaseKey && !/COLE_AQUI/.test(C.supabaseKey);
    if (!ok || !window.supabase) {
      plain('<div class="card"><p class="muted" style="margin:0">' + (ok ? "Sem conexão. Confira a internet e atualize a página." : "O aplicativo ainda não foi ligado ao banco de dados (config.js).") + "</p></div>", "App em preparação");
      return;
    }
    sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    var started = false;
    function setUser(session) {
      var nu = session ? session.user : null;
      var changed = (nu && nu.id) !== (user && user.id);
      user = nu;
      if (!user) { profile = null; me = null; route(); return; }
      if (changed || !profile) { loading(); loadMe().then(route).catch(function (err) { plain('<div class="err">' + e(friendly(err)) + "</div>", "Ops"); }); }
    }
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === "PASSWORD_RECOVERY") { recovering = true; user = session && session.user; screenNewPassword(); return; }
      if (ev === "TOKEN_REFRESHED" || ev === "USER_UPDATED") { user = session ? session.user : user; return; }
      if (!started) return;
      setUser(session);
    });
    sb.auth.getSession().then(function (r) { started = true; setUser(r.data.session); });
    window.addEventListener("hashchange", function () { if (started) route(); });
  }

  window.addEventListener("beforeinstallprompt", function (ev) { ev.preventDefault(); installEvt = ev; });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
  boot();
})();
