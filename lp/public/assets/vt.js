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
      // Devis signable : injecte le récap de la config dans les champs cachés du formulaire.
      var msg = q('[name="message"]');
      if (msg) {
        var opts = []; if (st.live) opts.push('Live temps réel (15 s)'); if (st.micro) opts.push("Micro d'assistance"); if (st.agent) opts.push('Agent IA');
        var retLbl = { '90j': '90 jours', '1an': '1 an', '2ans': '2 ans', '3ans': '3 ans' }[st.ret];
        var planLbl = st.plan === 'pro' ? 'Tracky Pro' : 'Tracky Lite';
        var engLbl = st.eng === 'annual' ? 'annuel renouvelable (tarif bloqué)' : 'mensuel sans engagement';
        msg.value =
          'DEVIS AUTO-CONFIGURÉ — ' + planLbl + ' (' + engLbl + ')\n' +
          st.vehicles + ' véhicule(s) · Options : ' + (opts.length ? opts.join(', ') : 'aucune') + ' · Rétention : ' + retLbl + '\n' +
          'Par véhicule : ' + fmt(perVeh, 2) + ' €/mois HT · Mensuel total : ' + fmt(monthTotal, 2) + ' € HT\n' +
          '1re année (boîtier + install + abo) : ' + fmt(hw * st.vehicles + install * st.vehicles + monthTotal * 12, 0) + ' € · Années suivantes : ' + fmt(monthTotal * 12, 0) + ' €\n' +
          'Économies estimées : ' + fmt(200 * st.vehicles, 0) + ' – ' + fmt(400 * st.vehicles, 0) + ' €/an\n' +
          'Bon pour accord (devis indicatif, à confirmer par Vizyo).';
      }
      var fsEl = q('[name="fleetSize"]'); if (fsEl) fsEl.value = st.vehicles + ' véhicule' + (st.vehicles > 1 ? 's' : '');
    }
    qa('[data-sim="plan"]').forEach(function (b) { b.addEventListener('click', function () { st.plan = b.getAttribute('data-val'); render(); }); });
    qa('[data-sim="eng"]').forEach(function (b) { b.addEventListener('click', function () { st.eng = b.getAttribute('data-val'); render(); }); });
    qa('[data-sim="ret"]').forEach(function (b) { b.addEventListener('click', function () { st.ret = b.getAttribute('data-val'); render(); }); });
    qa('[data-sim="opt"]').forEach(function (b) { b.addEventListener('click', function () { var k = b.getAttribute('data-val'); st[k] = !st[k]; render(); }); });
    var sl = q('[data-sim="vehicles"]'); if (sl) sl.addEventListener('input', function () { st.vehicles = parseInt(sl.value, 10) || 1; render(); });
    render();
  }

  // ── Formulaires lead (« recevoir une présentation » + devis) → POST /api/leads/contact ──
  function postLead(url, data, cb) {
    try {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { cb(r.ok); }).catch(function () { cb(false); });
    } catch (e) { cb(false); }
  }
  function initForms() {
    slice(d.querySelectorAll('form[data-vt-lead]')).forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var url = form.getAttribute('data-vt-lead');
        var val = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? String(el.value || '').trim() : ''; };
        var status = form.querySelector('[data-form-status]');
        var err = function (m) { if (status) { status.textContent = m; status.style.color = '#e5484d'; } };
        var name = val('name'), email = val('email');
        if (!name || email.indexOf('@') < 1 || email.indexOf('.') < 0) { err('Indiquez au moins votre nom et un e-mail valide.'); return; }
        if (form.hasAttribute('data-require-accord')) {
          var acc = form.querySelector('[name="accord"]');
          if (!acc || !acc.checked) { err('Cochez « bon pour accord » pour valider votre devis.'); return; }
        }
        var btn = form.querySelector('[type="submit"]'); if (btn) btn.disabled = true;
        if (status) { status.textContent = 'Envoi…'; status.style.color = 'var(--tx2)'; }
        postLead(url, {
          name: name, email: email, phone: val('phone'), company: val('company'),
          fleetSize: val('fleetSize'), message: val('message'),
        }, function (ok) {
          if (btn) btn.disabled = false;
          if (ok) {
            form.innerHTML = '<div style="text-align:center;padding:26px 8px">' +
              '<div style="width:52px;height:52px;border-radius:50%;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">' +
              '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>' +
              '<div style="font-size:1.12rem;font-weight:800;margin-bottom:6px">C\'est envoyé, merci !</div>' +
              '<div style="color:var(--tx2);font-size:.95rem">Votre demande est bien reçue. Réponse sous 2h ouvrées.</div></div>';
          } else { err('Une erreur est survenue. Réessayez, ou contactez-nous directement.'); }
        });
      });
    });
  }

  function init() { initHover(); initReveal(); handleHash(); initSim(); initForms(); }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();
})();
