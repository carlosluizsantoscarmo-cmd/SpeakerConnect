/* Cloudflare Turnstile para os logins do Supabase (app e painel da equipe).
   Liga sozinho quando SC.turnstile (config.js) tem a Site Key. Os tokens valem uma vez só:
   depois de cada tentativa chame SCCaptcha.reset(). */
(function () {
  "use strict";
  var widget = null, token = "", carregando = null, falhou = false;

  function carregar() {
    if (window.turnstile) return Promise.resolve();
    if (carregando) return carregando;
    carregando = new Promise(function (ok, falha) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { carregando = null; falhou = true; falha(new Error("turnstile")); };
      document.head.appendChild(s);
    });
    return carregando;
  }

  window.SCCaptcha = {
    ativo: function () { return !!(window.SC && SC.turnstile); },
    // Desenha a caixa dentro do elemento (troca a anterior, se houver)
    montar: function (el) {
      token = "";
      if (!this.ativo() || !el) return;
      carregar().then(function () {
        try { if (widget !== null) window.turnstile.remove(widget); } catch (x) {}
        widget = window.turnstile.render(el, {
          sitekey: SC.turnstile,
          language: "pt-br",
          theme: "light",
          callback: function (t) { token = t; },
          "expired-callback": function () { token = ""; },
          "error-callback": function () { token = ""; falhou = true; }
        });
      }).catch(function () {});
    },
    token: function () { return token || undefined; },
    // Sem token ainda (a caixa não terminou a verificação). Se a caixa não carregou
    // (bloqueador, rede), deixa tentar: o Supabase responde com a mensagem de erro.
    falta: function () { return this.ativo() && !token && !falhou; },
    reset: function () {
      token = "";
      try { if (widget !== null) window.turnstile.reset(widget); } catch (x) {}
    }
  };
})();
