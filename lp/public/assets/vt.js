/* Vizyo Tracky — interactivité vanilla (remplace support.js/React du design).
   Thème · menu mobile · reveal au scroll · scroll d'ancre · hover · simulateur. */
(function () {
  'use strict';
  var d = document, root = d.documentElement, slice = function (n) { return Array.prototype.slice.call(n); };

  // ── Thème sombre/clair (mémorisé) ──
  function setTheme(t) { root.dataset.theme = t; try { localStorage.setItem('vt-theme', t); } catch (e) {} }
  function toggleTheme() { setTheme(root.dataset.theme === 'light' ? 'dark' : 'light'); }

  // ── Menu mobile ──
  function toggleMenu() {
    var m = d.getElementById('vt-menu'); if (!m) return;
    m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
  }

  // Délégation de clics (thème + menu)
  d.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-vt]'); if (!t) return;
    var a = t.getAttribute('data-vt');
    if (a === 'theme') toggleTheme();
    else if (a === 'menu') toggleMenu();
  });

  // ── Hover inline (remplace l'attribut style-hover du design) ──
  function initHover() {
    slice(d.querySelectorAll('[data-vth]')).forEach(function (el) {
      var hov = el.getAttribute('data-vth');
      el.addEventListener('mouseenter', function () { el.setAttribute('data-vth-o', el.style.cssText); el.style.cssText += ';' + hov; });
      el.addEventListener('mouseleave', function () { var o = el.getAttribute('data-vth-o'); if (o !== null) el.style.cssText = o; });
    });
  }

  // ── Reveal au scroll ──
  function initReveal() {
    if (typeof IntersectionObserver === 'undefined') return;
    var els = slice(d.querySelectorAll('[data-reveal]')), vh = window.innerHeight || 800;
    els.forEach(function (el) {
      if (el.getBoundingClientRect().top > vh * 0.82) {
        el.style.opacity = '0'; el.style.transform = 'translateY(22px)';
        el.style.transition = 'opacity .7s cubic-bezier(.16,1,.3,1), transform .7s cubic-bezier(.16,1,.3,1)';
      }
    });
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { e.target.style.opacity = '1'; e.target.style.transform = 'none'; io.unobserve(e.target); } });
    }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  // ── Scroll vers l'ancre au chargement (offset header) ──
  function handleHash() {
    var hash = window.location.hash; if (!hash || hash.length < 2) return;
    var id = decodeURIComponent(hash.slice(1));
    function go() { var el = d.getElementById(id); if (!el) return; var top = window.pageYOffset || root.scrollTop || 0; window.scrollTo(0, el.getBoundingClientRect().top + top - 84); }
    requestAnimationFrame(go);
    [120, 350, 700, 1300].forEach(function (dl) { setTimeout(go, dl); });
  }

  // ── Simulateur tarifaire (page /tarifs) ──
  function initSim() {
    var wrap = d.getElementById('vt-sim'); if (!wrap) return;
    var PR = { lite: { annual: 22.90, monthly: 32.90, hw: 99 }, pro: { annual: 29.90, monthly: 42.90, hw: 189 } };
    var RET = { '90j': 0, '1an': 3.90, '2ans': 6.90, '3ans': 9.90 };
    var st = { plan: 'pro', vehicles: 5, eng: 'annual', live: false, micro: false, agent: false, ret: '90j' };
    var fmt = function (n, dec) { return n.toLocaleString('fr-FR', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 }); };
    var seg = function (a) { return 'flex:1;padding:11px;border-radius:9px;border:none;cursor:pointer;font-weight:700;font-size:.9rem;font-family:inherit;transition:all .2s;' + (a ? 'background:var(--accent);color:var(--accent-ink)' : 'background:transparent;color:var(--tx2)'); };
    var opt = function (a) { return 'padding:13px 10px;border-radius:11px;cursor:pointer;font-weight:700;font-size:.88rem;font-family:inherit;text-align:center;transition:all .2s;' + (a ? 'background:var(--accent-soft);border:1.5px solid var(--accent);color:var(--accent)' : 'background:var(--surface);border:1px solid var(--border);color:var(--tx2)'); };
    var tog = function (a) { return 'flex:none;width:50px;height:28px;border-radius:16px;border:none;cursor:pointer;padding:3px;display:flex;transition:all .2s;justify-content:' + (a ? 'flex-end' : 'flex-start') + ';background:' + (a ? 'var(--accent)' : 'var(--border2)'); };
    var q = function (s) { return wrap.querySelector(s); }, qa = function (s) { return slice(wrap.querySelectorAll(s)); };
    var set = function (s, v) { var el = q('[data-out="' + s + '"]'); if (el) el.textContent = v; };

    function render() {
      var base = PR[st.plan][st.eng];
      var perVeh = base + (st.live ? 9.90 : 0) + (st.micro ? 6.90 : 0) + (st.agent ? 14.90 : 0) + RET[st.ret];
      var monthTotal = perVeh * st.vehicles, install = st.vehicles >= 10 ? 0 : (st.vehicles >= 5 ? 29 : 49), hw = PR[st.plan].hw;
      set('vehicles', st.vehicles);
      set('perDay', fmt(perVeh / 30, 2) + ' €');
      set('monthTotal', fmt(monthTotal, 2) + ' €');
      set('perVeh', fmt(perVeh, 2) + ' €/véh');
      set('year1', fmt(hw * st.vehicles + install * st.vehicles + monthTotal * 12, 0) + ' €');
      set('recurring', fmt(monthTotal * 12, 0) + ' €');
      set('roi', fmt(200 * st.vehicles, 0) + ' – ' + fmt(400 * st.vehicles, 0) + ' €/an');
      set('installNote', 'Installation : ' + (st.vehicles >= 10 ? 'offerte dès 10 véhicules' : (st.vehicles >= 5 ? '29 €/véhicule (dès 5)' : '49 €/véhicule')) + '.');
      qa('[data-sim="plan"]').forEach(function (b) { b.style.cssText = seg(b.getAttribute('data-val') === st.plan); });
      qa('[data-sim="eng"]').forEach(function (b) { b.style.cssText = opt(b.getAttribute('data-val') === st.eng); });
      qa('[data-sim="ret"]').forEach(function (b) { b.style.cssText = opt(b.getAttribute('data-val') === st.ret); });
      qa('[data-sim="opt"]').forEach(function (b) { b.style.cssText = tog(st[b.getAttribute('data-val')]); });
    }
    qa('[data-sim="plan"]').forEach(function (b) { b.addEventListener('click', function () { st.plan = b.getAttribute('data-val'); render(); }); });
    qa('[data-sim="eng"]').forEach(function (b) { b.addEventListener('click', function () { st.eng = b.getAttribute('data-val'); render(); }); });
    qa('[data-sim="ret"]').forEach(function (b) { b.addEventListener('click', function () { st.ret = b.getAttribute('data-val'); render(); }); });
    qa('[data-sim="opt"]').forEach(function (b) { b.addEventListener('click', function () { var k = b.getAttribute('data-val'); st[k] = !st[k]; render(); }); });
    var sl = q('[data-sim="vehicles"]'); if (sl) sl.addEventListener('input', function () { st.vehicles = parseInt(sl.value, 10) || 1; render(); });
    render();
  }

  function init() { initHover(); initReveal(); handleHash(); initSim(); }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();
})();
