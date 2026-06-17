/* Vizyo Tracky — JS partagé (chargé sur toutes les pages).
   Données injectées par le build dans window.TRACKY = { site, pricing }.
   Chaque module est défensif : il ne s'exécute que si ses éléments existent. */
(function () {
  'use strict';
  var T = window.TRACKY || {};
  var SITE = T.site || {};
  var PRICING = T.pricing || {};
  var $ = function (id) { return document.getElementById(id); };
  var euro = function (n) { return n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
  var euro2 = function (n) { return n.toFixed(2).replace('.', ',') + ' €'; };

  /* ── Menu mobile ── */
  window.tmm = function () {
    var mm = $('mm'); if (!mm) return;
    var open = mm.classList.toggle('open');
    var btn = document.querySelector('.mt');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
  };

  /* ── Thème ── */
  window.thmt = function () {
    var c = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = c;
    try { localStorage.setItem('vt-theme', c); } catch (e) {}
  };

  /* ── Reveal on scroll ── */
  (function () {
    var all = document.querySelectorAll('.rv');
    if (!all.length) return;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    all.forEach(function (el) { var r = el.getBoundingClientRect(); if (r.top < vh && r.bottom > 0) el.classList.add('vis'); });
    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (e) { e.forEach(function (x) { if (x.isIntersecting) x.target.classList.add('vis'); }); }, { threshold: .1, rootMargin: '0px 0px -40px 0px' });
      all.forEach(function (el) { obs.observe(el); });
    } else { all.forEach(function (el) { el.classList.add('vis'); }); }
    window.addEventListener('load', function () { setTimeout(function () { document.querySelectorAll('.rv:not(.vis)').forEach(function (el) { var r = el.getBoundingClientRect(); if (r.top < window.innerHeight) el.classList.add('vis'); }); }, 50); });
  })();

  /* ── Ombre header au scroll ── */
  (function () {
    var hdr = $('hdr'); if (!hdr) return;
    window.addEventListener('scroll', function () { hdr.style.boxShadow = window.scrollY > 50 ? '0 10px 30px rgba(0,0,0,.3)' : 'none'; }, { passive: true });
  })();

  /* ── Barre de progression de scroll ── */
  (function () {
    var bar = $('scroll-progress'); if (!bar) return;
    function upd() { var h = document.documentElement, max = h.scrollHeight - h.clientHeight; bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%'; }
    window.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd, { passive: true });
    upd();
  })();

  /* ── Compteurs animés (data-count) à l'entrée dans l'écran ── */
  (function () {
    var els = document.querySelectorAll('[data-count]');
    if (!els.length) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function run(el) {
      var target = parseFloat(el.getAttribute('data-count')) || 0;
      if (reduce || !('requestAnimationFrame' in window)) { el.textContent = String(target); return; }
      var dur = 1200, t0 = 0;
      function step(ts) {
        if (!t0) t0 = ts;
        var p = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = String(Math.round(e * target));
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (xs) { xs.forEach(function (x) { if (x.isIntersecting) { run(x.target); io.unobserve(x.target); } }); }, { threshold: 0.5 });
      els.forEach(function (el) { io.observe(el); });
    } else { els.forEach(run); }
  })();

  /* ── Parallaxe douce de la vidéo hero (profondeur) ── */
  (function () {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var v = document.querySelector('.hero-bg-video video'); if (!v || !('requestAnimationFrame' in window)) return;
    var ticking = false;
    function upd() { v.style.transform = 'translateY(' + Math.min(window.scrollY * 0.06, 48) + 'px)'; ticking = false; }
    window.addEventListener('scroll', function () { if (!ticking) { requestAnimationFrame(upd); ticking = true; } }, { passive: true });
  })();

  /* ── FAQ accordéon ── */
  window.tgf = function (b) {
    var a = b.nextElementSibling, i = b.querySelector('.fqi'), o = a.classList.contains('open');
    document.querySelectorAll('.fqa').forEach(function (x) { x.classList.remove('open'); });
    document.querySelectorAll('.fqi').forEach(function (x) { x.style.transform = ''; });
    if (!o) { a.classList.add('open'); if (i) i.style.transform = 'rotate(180deg)'; }
  };

  /* ── Lecteur vidéo (placeholder → lit la vidéo si présente, sinon ouvre la démo) ── */
  (function () {
    document.querySelectorAll('.vfig').forEach(function (fig) {
      var btn = fig.querySelector('.vplay-btn'); if (!btn) return;
      btn.addEventListener('click', function () {
        var v = fig.querySelector('video');
        if (v && v.querySelector('source[src]')) { fig.classList.add('playing'); v.setAttribute('controls', ''); v.play(); }
        else if (window.openLeadForm) { window.openLeadForm(); }
      });
    });
  })();

  /* ── Autoplay des vidéos quand elles entrent dans l'écran (léger : preload=none) ── */
  (function () {
    var vids = document.querySelectorAll('video[data-inview]');
    if (!vids.length) return;
    if (!('IntersectionObserver' in window)) { vids.forEach(function (v) { v.play().catch(function () {}); }); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.play().catch(function () {}); }
        else { e.target.pause(); }
      });
    }, { threshold: 0.25 });
    vids.forEach(function (v) { io.observe(v); });
  })();

  /* ── Compte à rebours offre de lancement ── */
  (function () {
    var L = PRICING.launch; if (!L || !L.until) return;
    var els = document.querySelectorAll('.lc[data-countdown]'); if (!els.length) return;
    var end = new Date(L.until + 'T23:59:59').getTime();
    function tick() {
      var d = Math.max(0, end - Date.now());
      var days = Math.floor(d / 864e5), h = Math.floor(d % 864e5 / 36e5), m = Math.floor(d % 36e5 / 6e4), s = Math.floor(d % 6e4 / 1e3);
      els.forEach(function (el) {
        el.innerHTML =
          unit(days, 'jours') + unit(h, 'h') + unit(m, 'min') + unit(s, 'sec');
      });
    }
    function unit(n, lbl) { return '<span class="lc-unit"><span class="lc-num">' + String(n).padStart(2, '0') + '</span><span class="lc-lbl">' + lbl + '</span></span>'; }
    tick(); setInterval(tick, 1000);
  })();

  /* ── Simulateur v2 (base + Live + rétention + 1re année + récurrent) ── */
  (function () {
    var veh = $('sim-veh'); if (!veh || !PRICING.plans) return;
    var state = { plan: 'pro', eng: 'annual', live: false, ret: '90j' };

    function setActive(sel, on) { document.querySelectorAll(sel).forEach(function (b) { b.classList.remove('act'); }); if (on) on.classList.add('act'); }

    window.simPlan = function (p) { state.plan = p; setActive('[data-simplan]', $('simplan-' + p)); render(); };
    window.simEng = function (e) { state.eng = e; setActive('[data-simeng]', $('simeng-' + e)); render(); };
    window.simRet = function (r, btn) { state.ret = r; setActive('[data-simret]', btn); render(); };

    var liveSw = $('sim-live');
    if (liveSw) liveSw.addEventListener('change', function () { state.live = liveSw.checked; render(); });
    veh.addEventListener('input', render);

    function retObj(key) { return (PRICING.addons.retention || []).find(function (r) { return r.key === key; }) || { perVehMonth: 0 }; }

    function render() {
      var v = +veh.value;
      var plan = PRICING.plans[state.plan];
      var base = state.eng === 'annual' ? plan.annual : plan.monthly;
      var liveAdd = state.live ? PRICING.addons.live.perVehMonth : 0;
      var retAdd = retObj(state.ret).perVehMonth;
      var perVeh = base + liveAdd + retAdd;
      var monthly = perVeh * v;
      var hw = (plan.hardware || 0) * v;
      var inst = PRICING.install;
      var insPer = v >= inst.freeFrom ? 0 : v >= 5 ? inst.from5 : inst.base;
      var insTot = insPer * v;
      var year1 = hw + insTot + monthly * 12;
      var recurring = monthly * 12;
      var perDay = year1 / v / 365;
      var sLo = v * PRICING.savingsPerVehYear.low, sHi = v * PRICING.savingsPerVehYear.high;

      set('sim-veh-val', v);
      set('sim-perday', euro2(perDay));
      set('sim-month', euro(monthly) + ' €');
      set('sim-ppv', 'soit ' + euro2(perVeh) + '/véh');
      set('sim-year1', euro(year1) + ' €');
      set('sim-recurring', euro(recurring) + ' €/an');
      set('sim-roi', euro(sLo) + ' – ' + euro(sHi) + ' €/an');
      var bar = $('sim-roibar'); if (bar) bar.style.width = Math.min(100, Math.round(sLo / year1 * 100)) + '%';

      var det = $('sim-detail');
      if (det) {
        var lines = [];
        lines.push(line('Abonnement ' + plan.name + ' (' + (state.eng === 'annual' ? 'annuel' : 'mensuel') + ')', euro2(base) + '/véh'));
        if (liveAdd) lines.push(line('+ Option Live temps réel', euro2(liveAdd) + '/véh'));
        if (retAdd) lines.push(line('+ Rétention ' + retObj(state.ret).label, euro2(retAdd) + '/véh'));
        lines.push(line('Boîtier ' + (state.plan === 'pro' ? 'Pro' : 'Lite') + ' × ' + v, euro(hw) + ' €'));
        lines.push(line('Installation' + (insPer === 0 ? ' (offerte)' : ' (' + euro2(insPer).replace(' €', ' €/véh') + ')'), euro(insTot) + ' €'));
        lines.push('<div class="sim-line tot"><span>Total 1re année</span><strong>' + euro(year1) + ' €</strong></div>');
        det.innerHTML = lines.join('');
      }

      var note = $('sim-install');
      if (note) {
        if (v >= inst.freeFrom) { note.className = 'ins-note free'; setText(note, '✓ Installation offerte pour ' + v + ' véhicules'); }
        else if (v >= 5) { note.className = 'ins-note'; setText(note, 'Installation : ' + inst.from5 + ' €/véhicule — offerte dès ' + inst.freeFrom); }
        else { note.className = 'ins-note'; setText(note, 'Installation : ' + inst.base + ' €/véh — ' + inst.from5 + ' € dès 5, offerte dès ' + inst.freeFrom); }
      }

      var cta = $('sim-cta');
      if (cta) {
        var msg = 'Bonjour, je souhaite un devis Vizyo Tracky : ' + v + ' véhicule(s), ' + plan.name +
          ' (' + (state.eng === 'annual' ? 'annuel' : 'mensuel') + ')' + (state.live ? ' + Live temps réel' : '') +
          ', rétention ' + retObj(state.ret).label + '. Budget estimé : ' + euro(monthly) + ' €/mois.';
        cta.href = 'https://wa.me/' + (SITE.whatsapp || '') + '?text=' + encodeURIComponent(msg);
      }
    }
    function line(l, r) { return '<div class="sim-line"><span>' + l + '</span><strong>' + r + '</strong></div>'; }
    function set(id, val) { var e = $(id); if (e) e.textContent = val; }
    function setText(note, txt) { var s = note.querySelector('span'); if (s) s.textContent = txt; else note.textContent = txt; }

    render();
  })();

  /* ── FAB WhatsApp : apparaît à 4s, label à 30% de scroll ── */
  (function () {
    var fab = $('wa-fab'); if (!fab) return;
    var lblShown = false;
    setTimeout(function () { fab.classList.add('show'); }, 4000);
    window.addEventListener('scroll', function () {
      if (lblShown) return;
      var p = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
      if (p >= 0.3) { lblShown = true; fab.classList.add('lbl-show'); }
    }, { passive: true });
  })();

  /* ── FAB Espace Pro ── */
  (function () {
    var fab = $('app-fab'); if (!fab) return;
    var label = $('app-fab-label'), shown = false, labelShown = false;
    try { if (sessionStorage.getItem('vt-fab-label')) labelShown = true; } catch (e) {}
    function chk() {
      if (shown) return;
      if (window.scrollY > 300) {
        shown = true; fab.classList.add('show');
        if (!labelShown && label) {
          labelShown = true; try { sessionStorage.setItem('vt-fab-label', '1'); } catch (ex) {}
          setTimeout(function () { label.classList.add('show'); }, 400);
          setTimeout(function () { label.classList.remove('show'); }, 5000);
        }
      }
    }
    window.addEventListener('scroll', chk, { passive: true });
    setTimeout(chk, 100);
  })();
  window.openAppCard = function () { var ov = $('app-card-overlay'); if (ov) { ov.classList.add('show'); document.body.style.overflow = 'hidden'; } };
  window.closeAppCard = function () { var ov = $('app-card-overlay'); if (ov) { ov.classList.remove('show'); document.body.style.overflow = ''; } };

  /* ── Modale lead / exit-intent ── */
  window.openLeadForm = function () { var ov = $('eim-overlay'); if (ov) { ov.classList.add('show'); document.body.style.overflow = 'hidden'; } };
  window.closeEim = function () { var ov = $('eim-overlay'); if (ov) { ov.classList.remove('show'); document.body.style.overflow = ''; } };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { window.closeAppCard(); window.closeEim(); } });
  (function () {
    if (!$('eim-overlay')) return;
    var fired = false;
    try { if (localStorage.getItem('vt-eim-shown')) fired = true; } catch (e) {}
    if (fired) return;
    document.addEventListener('mouseleave', function (e) {
      if (fired || e.clientY > 10) return;
      var p = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
      if (p < 0.8 || window.innerWidth < 1024) return;
      fired = true; try { localStorage.setItem('vt-eim-shown', '1'); } catch (ex) {}
      window.openLeadForm();
    });
  })();

  /* ── Barre collante mobile ── */
  (function () {
    var sbb = $('sbb'); if (!sbb) return;
    var fabStack = $('fab-stack'), shown = false, dismissed = false;
    window.addEventListener('scroll', function () {
      if (dismissed) return;
      var y = window.scrollY;
      if (y > 450 && !shown) { shown = true; sbb.classList.add('show'); if (fabStack) fabStack.classList.add('shifted'); }
      else if (y <= 450 && shown) { shown = false; sbb.classList.remove('show'); if (fabStack) fabStack.classList.remove('shifted'); }
    }, { passive: true });
    window.dismissSbb = function () { dismissed = true; sbb.classList.remove('show'); sbb.style.display = 'none'; if (fabStack) fabStack.classList.remove('shifted'); };
  })();

  /* ── Bouton « retour en haut » (bas-gauche, jamais sur les CTA) ── */
  (function () {
    var btn = $('to-top'); if (!btn) return;
    window.addEventListener('scroll', function () { btn.classList.toggle('show', window.scrollY > 600); }, { passive: true });
    btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  })();

  /* ── Soumission formulaire lead ── */
  window.submitLeadForm = function (e) {
    e.preventDefault();
    var form = $('lead-form'), btn = $('lead-submit'), msg = $('lead-msg');
    var data = {
      name: form.name.value.trim(), email: form.email.value.trim(),
      phone: form.phone.value.trim() || undefined, company: form.company.value.trim() || undefined,
      fleetSize: form.fleetSize.value || undefined, message: form.message.value.trim() || undefined
    };
    if (!data.name || !data.email) return false;
    btn.disabled = true; btn.textContent = 'Envoi en cours...'; msg.style.display = 'none';
    fetch(SITE.leadApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          msg.style.display = 'block'; msg.style.color = 'var(--v5)';
          msg.textContent = res.isResubmission ? 'Demande mise à jour ! Nous revenons vers vous rapidement.' : 'Demande envoyée ! Nous revenons vers vous en moins de 2h.';
          form.reset(); setTimeout(window.closeEim, 3000);
        } else { msg.style.display = 'block'; msg.style.color = '#ef4444'; msg.textContent = 'Erreur lors de l\'envoi. Réessayez ou contactez-nous via WhatsApp.'; }
      })
      .catch(function () { msg.style.display = 'block'; msg.style.color = '#ef4444'; msg.textContent = 'Erreur réseau. Vérifiez votre connexion.'; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Envoyer ma demande'; });
    return false;
  };
})();
