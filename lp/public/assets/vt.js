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

  // Ancres MÊME PAGE (ex. « Demander une démo » → #demo) : scroll fiable via
  // scrollIntoView (le scroll natif de l'ancre ne saute pas toujours au bon
  // endroit après repositionnement de sections). Respecte scroll-margin-top,
  // ferme le menu mobile, met à jour le hash.
  d.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button) return;
    var a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) !== '#' || href.length < 2) return;
    var el = d.getElementById(decodeURIComponent(href.slice(1))); if (!el) return;
    e.preventDefault();
    var m = d.getElementById('vt-menu'); if (m && m.style.display === 'flex') m.style.display = 'none';
    try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (x) { el.scrollIntoView(); }
    try { if (history.replaceState) history.replaceState(null, '', href); } catch (x2) {}
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
            try { localStorage.setItem('vt-lead-done', '1'); } catch (e2) {}
            vtTrack('lp_lead_submit', { target: 'form' });
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

  // ── Pré-remplissage depuis Maestroo (?from=maestroo) : message tout prêt ──
  function prefillPartner() {
    try {
      var p = new URLSearchParams(location.search);
      if (p.get('from') !== 'maestroo') return;
      slice(d.querySelectorAll('form[data-vt-lead] [name="message"]')).forEach(function (el) {
        if (!el.value) el.value = 'Bonjour, je suis client Maestroo et je souhaite équiper ma flotte avec Vizyo Tracky. Pouvez-vous me présenter vos offres et l’intégration Tracky × Maestroo ? Merci.';
      });
    } catch (e) {}
  }

  // ── Beacons d'activité LP → observabilité Tracky (POST /api/partner/activity)
  // Fire-and-forget, non bloquant. Alimente le centre « Trafic & sources » de
  // l'app (intelligence IP : une IP déjà vue dans un lead LP = prospect reconnu).
  var VT_SID = null;
  function vtSid() {
    if (VT_SID) return VT_SID;
    try { VT_SID = sessionStorage.getItem('vt-sid') || ''; } catch (e) {}
    if (!VT_SID) {
      VT_SID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('lp-' + Math.random().toString(36).slice(2) + Date.now());
      try { sessionStorage.setItem('vt-sid', VT_SID); } catch (e) {}
    }
    return VT_SID;
  }
  // Consentement traceurs (RGPD/CNIL) : '' = non décidé, 'granted', 'denied'.
  function vtConsent() { try { return localStorage.getItem('vt-consent') || ''; } catch (e) { return ''; } }
  function vtTrack(action, extra) {
    try {
      if (vtConsent() !== 'granted') return; // aucune mesure tant que le consentement n'est pas donné
      var cfg = window.VT_CFG || {}; if (!cfg.partnerApi || !action) return;
      var body = { source: 'LP', action: String(action).slice(0, 60), sessionId: vtSid() };
      if (extra) {
        if (extra.target) body.target = String(extra.target).slice(0, 80);
        if (extra.label) body.label = String(extra.label).slice(0, 120);
        if (typeof extra.durationMs === 'number' && isFinite(extra.durationMs)) body.durationMs = Math.max(0, Math.round(extra.durationMs));
        if (extra.meta) body.meta = extra.meta;
      }
      var payload = JSON.stringify(body);
      if (payload.length > 3900) return; // borne serveur (4 Ko)
      if (navigator.sendBeacon) navigator.sendBeacon(cfg.partnerApi, new Blob([payload], { type: 'application/json' }));
      else fetch(cfg.partnerApi, { method: 'POST', keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: payload });
    } catch (e) {}
  }
  function initTracking() {
    var cfg = window.VT_CFG || {}; if (!cfg.partnerApi) return;
    var page = (location.pathname.replace(/\/$/, '').split('/').pop() || 'accueil').replace(/\.html$/, '');
    // page_view (+ referrer / utm / from)
    var m = {};
    try {
      var p = new URLSearchParams(location.search);
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { var v = p.get(k); if (v) m[k] = v.slice(0, 60); });
      if (p.get('from')) m.from = p.get('from').slice(0, 40);
      if (d.referrer && d.referrer.indexOf(location.host) < 0) m.ref = d.referrer.slice(0, 120);
    } catch (e) {}
    vtTrack('lp_page_view', { target: page, meta: Object.keys(m).length ? m : undefined });

    // clics CTA importants (délégation, capture)
    d.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a,button'); if (!a) return;
      var href = (a.getAttribute && a.getAttribute('href')) || '';
      var label = (a.getAttribute('data-track') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (/wa\.me|whatsapp/i.test(href)) vtTrack('lp_cta_click', { target: 'whatsapp', label: label });
      else if (/^tel:/i.test(href)) vtTrack('lp_cta_click', { target: 'phone', label: label });
      else if (/partenariat-maestroo/i.test(href)) vtTrack('lp_cta_click', { target: 'maestroo', label: label });
      else if (/#demo/i.test(href) || /démo|demande|rappel/i.test(label)) vtTrack('lp_cta_click', { target: 'demo', label: label });
      else if (/tarifs/i.test(href) || /devis/i.test(label)) vtTrack('lp_cta_click', { target: 'tarifs', label: label });
    }, true);

    // simulateur utilisé (une seule fois) — « a simulé »
    var simTracked = false;
    d.addEventListener('click', function (e) {
      if (simTracked || !(e.target.closest && e.target.closest('[data-sim]'))) return;
      simTracked = true; vtTrack('lp_sim_use', { target: page });
    }, true);

    // engagement formulaire : focus = start ; touché mais non soumis = hésitation
    var formTouched = false, formSubmitted = false;
    d.addEventListener('focusin', function (e) {
      if (formTouched || !(e.target.closest && e.target.closest('form[data-vt-lead], .vt-pop form'))) return;
      formTouched = true; vtTrack('lp_form_start', { target: page });
    });
    d.addEventListener('submit', function (e) { if (e.target.closest && e.target.closest('form[data-vt-lead], .vt-pop form')) formSubmitted = true; }, true);

    // temps passé + hésitation à la sortie (une seule fois)
    var t0 = Date.now(), sent = false;
    function onLeave() {
      if (sent) return; sent = true;
      var dur = Date.now() - t0;
      if (formTouched && !formSubmitted) vtTrack('lp_form_abandon', { target: page, durationMs: dur, meta: { simule: simTracked } });
      vtTrack('lp_time_spent', { target: page, durationMs: dur });
    }
    d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') onLeave(); });
    window.addEventListener('pagehide', onLeave);
  }

  // ── Pop-up « demande » intelligente & DISCRÈTE ─────────────────────────────
  // Se déclenche UNE seule fois, sur intention de sortie (souris qui quitte par
  // le haut) OU engagement (scroll > 40% ET > 4 s) OU 2ᵉ page vue dans la
  // session. Ne s'affiche JAMAIS si : le visiteur a déjà envoyé une demande, il
  // l'a fermée récemment (silence 3 jours), ou il regarde déjà un formulaire.
  // Carte d'angle non bloquante, fermable — pas un spam plein écran.
  function initSmartPopup() {
    var cfg = window.VT_CFG || {};
    if (!cfg.leadApi) return;
    try {
      if (localStorage.getItem('vt-lead-done')) return;
      var off = +localStorage.getItem('vt-popup-off') || 0;
      if (Date.now() - off < 3 * 864e5) return; // 3 jours de silence après fermeture
    } catch (e) {}

    var shown = false, el = null, t0 = Date.now();

    function formInView() {
      var fs = d.querySelectorAll('form[data-vt-lead]'), vh = window.innerHeight || 800;
      for (var i = 0; i < fs.length; i++) { var r = fs[i].getBoundingClientRect(); if (r.top < vh && r.bottom > 0) return true; }
      return false;
    }
    function injectStyle() {
      if (d.getElementById('vt-pop-css')) return;
      var s = d.createElement('style'); s.id = 'vt-pop-css';
      s.textContent =
        '.vt-pop{position:fixed;right:20px;bottom:20px;z-index:9999;width:340px;max-width:calc(100vw - 32px);background:var(--surface);border:1px solid var(--border2);border-radius:16px;box-shadow:0 20px 60px -12px rgba(0,0,0,.5);padding:20px 20px 18px;opacity:0;transform:translateY(16px);transition:opacity .35s cubic-bezier(.16,1,.3,1),transform .35s cubic-bezier(.16,1,.3,1)}' +
        '.vt-pop.vt-in{opacity:1;transform:none}' +
        '.vt-pop-x{position:absolute;top:9px;right:9px;width:28px;height:28px;border:none;background:transparent;color:var(--tx3);font-size:20px;line-height:26px;cursor:pointer;border-radius:8px;padding:0}' +
        '.vt-pop-x:hover{background:var(--bg2);color:var(--tx)}' +
        '.vt-pop h3{margin:0 0 5px;font-size:1.06rem;font-weight:800;letter-spacing:-.02em;color:var(--tx)}' +
        '.vt-pop p{margin:0 0 14px;font-size:.87rem;line-height:1.5;color:var(--tx2)}' +
        '.vt-pop input{width:100%;box-sizing:border-box;padding:11px 13px;margin-bottom:9px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--tx);font:inherit;font-size:.9rem;outline:none}' +
        '.vt-pop input:focus{border-color:var(--accent)}' +
        '.vt-pop button[type=submit]{width:100%;padding:12px;border:none;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:.92rem;cursor:pointer}' +
        '.vt-pop-alt{margin:10px 0 0;font-size:.8rem;color:var(--tx2);text-align:center}' +
        '.vt-pop-st{font-size:.8rem;min-height:1em;margin-top:8px;text-align:center;color:var(--tx2)}' +
        '@media (max-width:520px){.vt-pop{right:12px;left:12px;bottom:12px;width:auto}}' +
        '@media (prefers-reduced-motion:reduce){.vt-pop{transition:none}}';
      d.head.appendChild(s);
    }
    function close(remember) {
      if (!el) return;
      var e2 = el; el = null; e2.classList.remove('vt-in');
      setTimeout(function () { if (e2 && e2.parentNode) e2.parentNode.removeChild(e2); }, 350);
      if (remember) { try { localStorage.setItem('vt-popup-off', String(Date.now())); } catch (e) {} }
    }
    function show() {
      if (shown || el || formInView()) return;
      shown = true; injectStyle(); vtTrack('lp_popup_shown', { target: 'popup' });
      el = d.createElement('div'); el.className = 'vt-pop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Demander une démo Vizyo Tracky');
      el.innerHTML =
        '<button class="vt-pop-x" aria-label="Fermer">&times;</button>' +
        '<h3>Une démo gratuite ?</h3>' +
        '<p>Laissez vos coordonnées, on vous rappelle sous 2h — sans engagement.</p>' +
        '<form novalidate>' +
        '<input name="name" placeholder="Votre nom" autocomplete="name">' +
        '<input name="email" type="email" placeholder="E-mail" autocomplete="email">' +
        '<input name="phone" type="tel" placeholder="Téléphone (optionnel)" autocomplete="tel">' +
        '<button type="submit">Être rappelé →</button>' +
        '<div class="vt-pop-st"></div></form>' +
        '<div class="vt-pop-alt">ou <a href="' + cfg.wa + '" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">WhatsApp</a></div>';
      d.body.appendChild(el);
      requestAnimationFrame(function () { if (el) el.classList.add('vt-in'); });
      el.querySelector('.vt-pop-x').addEventListener('click', function () { close(true); });
      var form = el.querySelector('form'), st = el.querySelector('.vt-pop-st');
      var gv = function (n) { var e = form.querySelector('[name="' + n + '"]'); return e ? String(e.value || '').trim() : ''; };
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var name = gv('name'), email = gv('email'), phone = gv('phone');
        if (!name || (email.indexOf('@') < 1 && !phone)) { st.textContent = 'Votre nom + un e-mail ou un téléphone, svp.'; st.style.color = '#e5484d'; return; }
        var b = form.querySelector('button[type=submit]'); if (b) b.disabled = true;
        st.style.color = 'var(--tx2)'; st.textContent = 'Envoi…';
        postLead(cfg.leadApi, { name: name, email: email, phone: phone, company: '', fleetSize: '', message: 'Demande rapide via pop-up (LP)' }, function (ok) {
          if (b) b.disabled = false;
          if (ok) {
            try { localStorage.setItem('vt-lead-done', '1'); } catch (e) {}
            el.innerHTML = '<div style="text-align:center;padding:10px 4px"><div style="font-size:1.02rem;font-weight:800;color:var(--tx);margin-bottom:4px">C\'est noté, merci !</div><div style="font-size:.86rem;color:var(--tx2)">On vous rappelle très vite.</div></div>';
            setTimeout(function () { close(false); }, 2800);
          } else { st.textContent = 'Une erreur est survenue. Réessayez.'; st.style.color = '#e5484d'; }
        });
      });
    }

    // Déclencheurs (le 1er qui arrive gagne — `shown` verrouille ensuite)
    d.addEventListener('mouseout', function (e) { if (e.clientY <= 0 && !e.relatedTarget) show(); });
    window.addEventListener('scroll', function () {
      var se = root.scrollHeight - root.clientHeight;
      var depth = se > 0 ? (window.pageYOffset || root.scrollTop || 0) / se : 0;
      if (depth > 0.4 && Date.now() - t0 > 4000) show();
    }, { passive: true });
    try {
      var pv = (+sessionStorage.getItem('vt-pv') || 0) + 1;
      sessionStorage.setItem('vt-pv', String(pv));
      if (pv >= 2) setTimeout(show, 7000);
    } catch (e) {}
  }

  // Vidéos qui ne démarrent qu'à l'écran : on ne pose le src (donc on ne charge
  // et ne lance le lecteur) que lorsque l'iframe est réellement visible, et on le
  // retire quand elle sort de l'écran (le lecteur s'arrête). Marqueur data-vt-src.
  // Technique getBoundingClientRect + scroll/resize (fiable partout), doublée d'un
  // IntersectionObserver quand dispo.
  function initLazyVideos() {
    var vids = [].slice.call(d.querySelectorAll('iframe[data-vt-src]'));
    if (!vids.length) return;
    function vh() { return window.innerHeight || d.documentElement.clientHeight || 0; }
    function sync() {
      var h = vh();
      vids.forEach(function (f) {
        var src = f.getAttribute('data-vt-src'); if (!src) return;
        var r = f.getBoundingClientRect();
        var visible = r.height > 0 && r.top < h * 0.85 && r.bottom > h * 0.15;
        if (visible) { if (f.getAttribute('src') !== src) f.src = src; }
        else if (f.getAttribute('src')) { f.removeAttribute('src'); }
      });
    }
    var ticking = false;
    function onScroll() { if (ticking) return; ticking = true; requestAnimationFrame(function () { ticking = false; sync(); }); }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function () { sync(); }, { threshold: [0, 0.4] });
      vids.forEach(function (f) { io.observe(f); });
    }
    sync();
    // expose pour vérif/diagnostic
    window.__vtSyncVideos = sync;
  }

  // ── Consentement traceurs (bandeau CNIL) ──────────────────────────────────
  // Refus aussi simple que l'accord, choix mémorisé, révocable (window.vtOpenConsent).
  // Le tracking (initTracking + beacons) ne tourne QUE si le choix est 'granted'.
  function vtSetConsent(v) {
    try { localStorage.setItem('vt-consent', v); } catch (e) {}
    var b = d.getElementById('vt-consent'); if (b && b.parentNode) b.parentNode.removeChild(b);
    vtRecordConsent(v); // preuve serveur (IP côté serveur), NON gatée — accepter OU refuser est tracé
    if (v === 'granted') initTracking();
  }
  // Enregistre le choix de consentement côté serveur (preuve CNIL + IP) — strictement
  // nécessaire, donc envoyé quel que soit le choix (indépendant du gate de mesure).
  function vtRecordConsent(v) {
    try {
      var cfg = window.VT_CFG || {}; if (!cfg.consentApi) return;
      var page = (location.pathname.replace(/\/$/, '').split('/').pop() || 'accueil').replace(/\.html$/, '');
      var payload = JSON.stringify({ choice: v === 'granted' ? 'granted' : 'denied', sessionId: vtSid(), categories: { measure: v === 'granted' }, page: page });
      if (navigator.sendBeacon) navigator.sendBeacon(cfg.consentApi, new Blob([payload], { type: 'application/json' }));
      else fetch(cfg.consentApi, { method: 'POST', keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: payload });
    } catch (e) {}
  }
  function showConsentBanner() {
    if (d.getElementById('vt-consent')) return;
    var btn = 'font:inherit;font-weight:700;font-size:.84rem;padding:9px 15px;border-radius:9px;cursor:pointer;border:1px solid var(--border2,rgba(255,255,255,.14));background:transparent;color:var(--tx,#EAEFED)';
    var btnA = 'font:inherit;font-weight:700;font-size:.84rem;padding:9px 17px;border-radius:9px;cursor:pointer;border:0;background:var(--accent,#10E0A0);color:var(--accent-ink,#04130D)';
    var chk = vtConsent() === 'granted' ? ' checked' : '';
    var w = d.createElement('div');
    w.id = 'vt-consent';
    w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', 'Consentement aux traceurs');
    w.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:120;background:var(--surface,#101514);border-top:1px solid var(--border2,rgba(255,255,255,.14));box-shadow:0 -10px 34px rgba(0,0,0,.4);padding:15px 20px;font-family:inherit;transform:translateY(110%);transition:transform .34s cubic-bezier(.2,.7,.2,1)';
    w.innerHTML =
      '<div style="max-width:1000px;margin:0 auto;display:flex;gap:16px;flex-wrap:wrap;align-items:center;justify-content:space-between">' +
        '<div style="flex:1;min-width:250px;font-size:.88rem;line-height:1.5;color:var(--tx2,#9BA5A1)"><strong style="color:var(--tx,#EAEFED)">Votre vie privée.</strong> Nous utilisons des traceurs de mesure d\'audience et d\'accompagnement commercial (pages vues, clics, adresse&nbsp;IP). Aucun n\'est activé sans votre accord. <a href="mentions-legales.html" style="color:var(--accent,#10E0A0);text-decoration:none">En savoir plus</a>.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button type="button" data-vtc="refuse" style="' + btn + '">Tout refuser</button>' +
          '<button type="button" data-vtc="custom" style="' + btn + '">Personnaliser</button>' +
          '<button type="button" data-vtc="accept" style="' + btnA + '">Tout accepter</button>' +
        '</div>' +
      '</div>' +
      '<div data-vtc-panel style="display:none;max-width:1000px;margin:13px auto 0;border-top:1px solid var(--border,rgba(255,255,255,.08));padding-top:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:.84rem;color:var(--tx2,#9BA5A1);padding:5px 0"><span><strong style="color:var(--tx,#EAEFED)">Strictement nécessaires</strong> — sécurité, envoi de formulaire, mémorisation de votre choix.</span><span style="color:var(--tx3,#69736E);font-size:.76rem;white-space:nowrap">Toujours actif</span></div>' +
        '<label style="display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:.84rem;color:var(--tx2,#9BA5A1);padding:5px 0;cursor:pointer"><span><strong style="color:var(--tx,#EAEFED)">Mesure d\'audience &amp; prospection</strong> — clics, scroll, temps passé, reconnaissance par IP.</span><input type="checkbox" data-vtc-measure' + chk + ' style="width:18px;height:18px;accent-color:var(--accent,#10E0A0);flex:none"></label>' +
        '<div style="text-align:right;margin-top:10px"><button type="button" data-vtc="save" style="' + btnA + '">Enregistrer mon choix</button></div>' +
      '</div>';
    d.body.appendChild(w);
    requestAnimationFrame(function () { w.style.transform = 'translateY(0)'; });
    w.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-vtc]'); if (!t) return;
      var a = t.getAttribute('data-vtc');
      if (a === 'accept') vtSetConsent('granted');
      else if (a === 'refuse') vtSetConsent('denied');
      else if (a === 'custom') { var p = w.querySelector('[data-vtc-panel]'); if (p) p.style.display = (p.style.display === 'none' || !p.style.display) ? 'block' : 'none'; }
      else if (a === 'save') { var m = w.querySelector('[data-vtc-measure]'); vtSetConsent(m && m.checked ? 'granted' : 'denied'); }
    });
  }
  function initConsent() {
    var st = vtConsent();
    if (st === 'granted') { initTracking(); return; }
    if (st === 'denied') return;
    showConsentBanner();
  }
  window.vtOpenConsent = function () { showConsentBanner(); };
  // Lien « Gérer les traceurs » à côté des mentions légales (révocation en 1 clic, toutes pages).
  function injectConsentLink() {
    var links = d.querySelectorAll('a[href$="mentions-legales.html"]');
    for (var i = 0; i < links.length; i++) {
      var m = links[i];
      if (m.__vtcDone) continue; m.__vtcDone = true;
      var a = d.createElement('a');
      a.href = '#'; a.textContent = 'Gérer les traceurs';
      a.style.cssText = 'color:inherit;text-decoration:none;margin-left:14px;opacity:.9';
      a.addEventListener('click', function (e) { e.preventDefault(); if (window.vtOpenConsent) vtOpenConsent(); });
      if (m.parentNode) m.parentNode.insertBefore(a, m.nextSibling);
    }
  }

  function init() { initHover(); initReveal(); handleHash(); initSim(); initForms(); prefillPartner(); initSmartPopup(); initLazyVideos(); initConsent(); injectConsentLink(); }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();
})();
