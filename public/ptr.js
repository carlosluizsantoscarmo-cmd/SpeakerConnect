// Puxar para atualizar: arrastar o dedo para baixo no topo da tela recarrega os dados.
// Só liga com o app instalado na tela inicial (no navegador comum o celular já faz isso sozinho).
// Usa window.scRefresh() se a página definir (painel da equipe); senão recarrega a página.
(function () {
  "use strict";
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  if (!standalone || !("ontouchstart" in window)) return;

  var LIMIT = 70, MAX = 110, startY = null, dist = 0, busy = false, dirty = false;
  // não atualiza por cima de algo que a pessoa está digitando e ainda não salvou
  document.addEventListener("input", function (ev) { if (ev.target && ev.target.closest && !ev.target.closest("[data-ptr-ignore]")) dirty = true; }, true);
  document.addEventListener("submit", function () { dirty = false; }, true);
  window.addEventListener("hashchange", function () { dirty = false; });

  document.documentElement.style.overscrollBehaviorY = "contain";
  var bar = document.createElement("div");
  bar.setAttribute("aria-hidden", "true");
  bar.style.cssText = "position:fixed;left:50%;top:0;z-index:9999;transform:translate(-50%,-60px);width:44px;height:44px;border-radius:50%;" +
    "background:#fff;box-shadow:0 4px 16px rgba(27,26,75,.25);display:grid;place-items:center;transition:transform .2s;pointer-events:none";
  bar.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1B1A4B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
  var icon = bar.firstChild, spin = null;
  function show(px, angle) { bar.style.transform = "translate(-50%," + (px - 50) + "px)"; icon.style.transform = "rotate(" + angle + "deg)"; }
  function hide() { bar.style.transition = "transform .2s"; bar.style.transform = "translate(-50%,-60px)"; }
  function toast(t) {
    var n = document.createElement("div");
    n.textContent = t;
    n.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;background:#1B1A4B;color:#fff;padding:10px 16px;border-radius:999px;font:500 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);max-width:90vw;text-align:center";
    document.body.appendChild(n); setTimeout(function () { n.remove(); }, 2600);
  }
  // o toque começou dentro de algo que rola por conta própria (lista, janela) e não está no topo?
  function innerScrolled(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      if (el.scrollTop > 0) return true;
      if (el.hasAttribute && el.hasAttribute("data-ptr-ignore")) return true;
    }
    return false;
  }

  document.addEventListener("touchstart", function (ev) {
    if (busy || ev.touches.length !== 1 || window.scrollY > 0 || innerScrolled(ev.target)) { startY = null; return; }
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { startY = null; return; }
    if (ev.target.closest && ev.target.closest("canvas")) { startY = null; return; } // quadro de assinatura
    startY = ev.touches[0].clientY; dist = 0; bar.style.transition = "none";
  }, { passive: true });

  document.addEventListener("touchmove", function (ev) {
    if (startY === null) return;
    var dy = ev.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { dist = 0; show(0, 0); return; }
    dist = Math.min(MAX, dy * 0.5);
    show(dist, (dist / LIMIT) * 270);
    if (dist > 8 && ev.cancelable) ev.preventDefault();
  }, { passive: false });

  document.addEventListener("touchend", function () {
    if (startY === null) return;
    startY = null;
    if (dist < LIMIT) { hide(); return; }
    if (dirty) { hide(); toast("Salve suas alterações antes de atualizar."); return; }
    busy = true; bar.style.transition = "transform .2s"; show(LIMIT, 0);
    var a = 0; spin = setInterval(function () { a += 18; icon.style.transform = "rotate(" + a + "deg)"; }, 16);
    var done = function () { clearInterval(spin); busy = false; hide(); };
    if (typeof window.scRefresh === "function") {
      Promise.resolve().then(window.scRefresh).then(done, done);
    } else {
      setTimeout(function () { location.reload(); }, 150);
    }
  });

  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(bar); });
  if (document.body) document.body.appendChild(bar);
})();
