/* vizyo-scenes.jsx — Cinematic scenes for "Vizyo Tracky × Maestroo".
   Mounted via <x-import from="./animations-v2.jsx ./vizyo-scenes.jsx"
   component-from-global-scope="VizyoTrackyVideo">. */
(function () {
  const R = window.React;
  const { useScene, interpolate, Easing, clamp, SceneStage } = window;
  const h = R.createElement;

  /* ── Palettes ─────────────────────────────────────────────── */
  const T = {
    bg: '#080B0A', bg2: '#0B0F0E', surface: '#101514', surface2: '#161D1B',
    border: 'rgba(255,255,255,.09)', border2: 'rgba(255,255,255,.16)',
    tx: '#EAEFED', tx2: '#9BA5A1', tx3: '#69736E',
    ac: '#10E0A0', ac2: '#0FBE88', acDeep: '#047857',
    acSoft: 'rgba(16,224,160,.12)', ink: '#04130D',
    red: '#F2706B', amber: '#F5B33D', map: '#0d1413', map2: '#11201c',
  };
  const M = { ac: '#4d75ff', ac2: '#2e5bff', acLight: '#90b0ff', soft: 'rgba(77,117,255,.14)' };
  const sans = "Manrope, system-ui, -apple-system, sans-serif";
  const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";

  const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── Building blocks ──────────────────────────────────────── */
  function Bg({ progress, tint, camScale = 0.05 }) {
    const s = 1 + camScale * progress;
    const glow = tint === 'blue' ? M.soft : T.acSoft;
    return h('div', { style: { position: 'absolute', inset: 0, background: T.bg, overflow: 'hidden' } },
      h('div', { style: {
        position: 'absolute', inset: '-4%', transform: `scale(${s})`, transformOrigin: '60% 40%',
        backgroundImage: `linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px)`,
        backgroundSize: '64px 64px',
        maskImage: 'radial-gradient(ellipse 85% 70% at 62% 34%,#000 35%,transparent 100%)',
        WebkitMaskImage: 'radial-gradient(ellipse 85% 70% at 62% 34%,#000 35%,transparent 100%)',
      } }),
      h('div', { style: { position: 'absolute', top: '-22%', right: '-12%', width: 900, height: 900,
        background: `radial-gradient(circle, ${glow}, transparent 66%)`, filter: 'blur(6px)' } }),
      h('div', { style: { position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse 120% 90% at 50% 50%, transparent 52%, rgba(0,0,0,.55) 100%)' } }),
    );
  }

  function Eyebrow({ text, color = T.ac, style }) {
    return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 16, ...style } },
      h('span', { style: { width: 46, height: 3, borderRadius: 3, background: color } }),
      h('span', { style: { fontFamily: mono, fontSize: 20, fontWeight: 600, letterSpacing: '.28em',
        whiteSpace: 'nowrap', textTransform: 'uppercase', color: T.tx2 } }, text),
    );
  }

  function TrackyLogo({ size = 120, glow = true }) {
    return h('svg', { width: size, height: size * (290 / 283), viewBox: '0 0 283 290', fill: 'none',
      style: glow ? { filter: `drop-shadow(0 0 26px ${T.acSoft})` } : null },
      h('path', { d: 'M180 11.6296C182 10.6295 193 -1.37044 224 0.129555C248.8 1.32956 267.333 22.2962 273.5 32.6296C289 59.6295 278 88.1296 277.5 90.1296C277.5 92 192 245.13 185 260.13C175.5 277.129 163.404 283.129 156 284.5C154 284.87 145.5 286.5 135 284.5C119.5 280.5 109 271 101.5 251L2 33.1296H37C55.8 33.9296 67.8333 48.1296 71.5 55.1296L137 192.63C146.6 215.429 161 220.13 166.5 220.13H166.672C171.787 220.131 182.708 220.135 189 214.63C197 207.63 202 201 203.5 188C205 175 190 148.63 185 141.63C163 105.13 158 97.6293 154.5 82.6296C151 67.6299 152.5 59.1296 153 53.6296C153.5 48.1296 156.5 40.6295 159.5 34.6296C162.5 28.6296 170.5 19.1295 180 11.6296ZM190.5 171.13C191.5 173.13 194 178.3 194 183.5C194 188.7 194 190 191.5 196C188.5 202 185.8 204.23 181 206.63C176.2 209.029 169.209 209.025 164.5 207.63C159 206 155.8 203.029 153 198.63L179 149.13L190.5 171.13ZM217 32.1296C198.775 32.1296 184 46.9042 184 65.1296C184 83.3548 198.775 98.1296 217 98.1296C235.225 98.1296 250 83.3548 250 65.1296C250 46.9042 235.225 32.1296 217 32.1296Z',
        fill: 'url(#vtg)' }),
      h('defs', null, h('linearGradient', { id: 'vtg', x1: 28, y1: 280, x2: 230, y2: 79, gradientUnits: 'userSpaceOnUse' },
        h('stop', { stopColor: T.ac }), h('stop', { offset: 1, stopColor: T.acDeep }))),
    );
  }

  function MaestrooLogo({ size = 120, glow = true, id = 'm' }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 1024 1024', fill: 'none',
      style: glow ? { filter: `drop-shadow(0 0 26px ${M.soft})` } : null },
      h('defs', null,
        h('linearGradient', { id: id + 'bg', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 1024, y2: 1024 },
          h('stop', { offset: 0, stopColor: '#2E6EFF' }), h('stop', { offset: 0.5, stopColor: '#0B2495' }), h('stop', { offset: 1, stopColor: '#010730' })),
        h('linearGradient', { id: id + 'w', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 1024, y2: 1024 },
          h('stop', { offset: 0, stopColor: '#FFFFFF' }), h('stop', { offset: 1, stopColor: '#DDE7FF' })),
        h('radialGradient', { id: id + 'hl', cx: 0.18, cy: 0.14, r: 0.75 },
          h('stop', { offset: 0, stopColor: '#6C9BFF', stopOpacity: 0.45 }), h('stop', { offset: 1, stopColor: '#6C9BFF', stopOpacity: 0 }))),
      h('rect', { width: 1024, height: 1024, rx: 224, fill: `url(#${id}bg)` }),
      h('rect', { width: 1024, height: 1024, rx: 224, fill: `url(#${id}hl)` }),
      h('g', { transform: 'translate(194.52 220.97) scale(0.8819) translate(90 90)' },
        h('path', { d: 'M-90 480L-90 0A90 90 0 0 1 59.79 -67.27L270 119.58L480.21 -67.27A90 90 0 0 1 630 0L630 480A90 90 0 1 1 450 480L450 200.42L329.79 307.27A90 90 0 0 1 210.21 307.27L90 200.42L90 480A90 90 0 1 1 -90 480Z', fill: `url(#${id}w)` }),
        h('path', { d: 'M162 466A26 26 0 0 1 214 466L214 544A26 26 0 0 1 162 544Z M244 381A26 26 0 0 1 296 381L296 544A26 26 0 0 1 244 544Z M326 431A26 26 0 0 1 378 431L378 544A26 26 0 0 1 326 544Z', fill: '#4E76FF' })),
    );
  }

  // generic stroke icon
  function Ic({ d, size = 26, color = T.ac, sw = 1.8, fill = 'none', vb = '0 0 24 24' }) {
    return h('svg', { width: size, height: size, viewBox: vb, fill, stroke: color, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' },
      Array.isArray(d) ? d.map((p, i) => h('path', { key: i, d: p })) : h('path', { d }));
  }
  const ICON = {
    pin: 'M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z',
    pin2: 'M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    engine: ['M2 6h20v12H2z', 'M6 12h.01M12 12h.01', 'M17 9l-3 3 3 3'],
    bell: ['M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
    bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
    battery: ['M3 11h14v6H3z', 'M20 12v4M6 14h.01'],
    tow: ['M5 17h14M5 17l1.5-5h11L19 17M7 12V8h10v4', 'M7.5 17.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0', 'M16.5 17.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'],
    speed: ['M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 13l4-4'],
    shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
    users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M23 21v-2a4 4 0 0 0-3-3.87'],
    check: 'M20 6 9 17l-5-5',
    fuel: ['M3 22h12V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z', 'M15 8h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2', 'M6 8h6'],
    chart: ['M3 3v18h18', 'm7 14 4-4 3 3 5-6'],
    calendar: ['M3 4h18v18H3z', 'M16 2v4M8 2v4M3 10h18'],
    spark: 'M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6z',
  };

  /* ── Scene wrapper: global fade + camera drift ────────────── */
  function Frame({ progress, tint, camScale = 0.05, children }) {
    const io = interpolate([0, 0.07, 0.93, 1], [0, 1, 1, 0], Easing.easeOutCubic)(progress);
    return h('div', { style: { position: 'absolute', inset: 0, opacity: io, background: T.bg } },
      h(Bg, { progress, tint, camScale }),
      children);
  }
  const WRAP = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 140px' };

  /* ══════════════ SCENE 1 — INTRO ══════════════ */
  function SceneIntro({ progress }) {
    const logoS = Easing.easeOutBack(seg(progress, 0.05, 0.4));
    const ring = seg(progress, 0.1, 0.9);
    const word = seg(progress, 0.32, 0.55);
    const tag = seg(progress, 0.5, 0.72);
    return h(Frame, { progress, camScale: 0.08 },
      h('div', { style: WRAP },
        h('div', { style: { position: 'relative', marginBottom: 44 } },
          // pulse rings
          [0, 1, 2].map(i => {
            const rp = (ring + i * 0.33) % 1;
            return h('div', { key: i, style: { position: 'absolute', left: '50%', top: '50%',
              width: 200, height: 200, marginLeft: -100, marginTop: -100, borderRadius: '50%',
              border: `1px solid ${T.ac}`, opacity: (1 - rp) * 0.5,
              transform: `translate(-0%,-0%) scale(${0.6 + rp * 2.4})` } });
          }),
          h('div', { style: { transform: `scale(${logoS})`, opacity: clamp(logoS, 0, 1) } },
            h(TrackyLogo, { size: 150 })),
        ),
        h('div', { style: { overflow: 'hidden', height: 112, padding: '0 8px' } },
          h('div', { style: { fontFamily: sans, fontSize: 82, fontWeight: 800, letterSpacing: '-.03em',
            whiteSpace: 'nowrap', color: T.tx, transform: `translateY(${lerp(112, 0, Easing.easeOutCubic(word))}px)`, opacity: word } },
            'Vizyo', h('span', { style: { color: T.ac } }, ' Tracky'))),
        h('div', { style: { marginTop: 26, opacity: tag, transform: `translateY(${lerp(18, 0, tag)}px)` } },
          h(Eyebrow, { text: 'GPS & gestion de flotte' })),
      ));
  }

  /* ══════════════ SCENE 2 — GPS TEMPS RÉEL ══════════════ */
  function SceneGPS({ progress }) {
    const pts = [[240, 760], [520, 640], [700, 700], [980, 470], [1240, 520], [1500, 300], [1690, 360]];
    const draw = seg(progress, 0.12, 0.72);
    const n = pts.length - 1;
    const f = draw * n, i = Math.min(Math.floor(f), n - 1), lt = f - i;
    const mk = { x: lerp(pts[i][0], pts[i + 1][0], lt), y: lerp(pts[i][1], pts[i + 1][1], lt) };
    const polyDrawn = pts.slice(0, i + 1).concat([[mk.x, mk.y]]);
    const title = seg(progress, 0.62, 0.82);
    const coordN = Math.floor(lerp(0, 999, seg(progress, 0.15, 0.9)));
    const speed = Math.round(lerp(0, 64, seg(progress, 0.15, 0.7)));
    return h(Frame, { progress, camScale: 0.06 },
      // map
      h('div', { style: { position: 'absolute', inset: 0, background: `radial-gradient(ellipse 90% 80% at 55% 55%, ${T.map2}, ${T.map} 70%)` } }),
      h('svg', { viewBox: '0 0 1920 1080', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } },
        // faint road network
        ['M0 820 L560 660 L900 720 L1300 500 L1920 560', 'M300 1080 L520 640 L640 420 L980 260', 'M1920 820 L1420 560 L1240 320', 'M120 300 L520 400 L900 360 L1400 460']
          .map((d, k) => h('path', { key: k, d, fill: 'none', stroke: 'rgba(255,255,255,.06)', strokeWidth: 8 })),
        // route glow + line
        h('polyline', { points: polyDrawn.map(p => p.join(',')).join(' '), fill: 'none', stroke: T.ac, strokeWidth: 6, strokeLinecap: 'round', strokeLinejoin: 'round', style: { filter: `drop-shadow(0 0 10px ${T.ac})` } }),
        pts.slice(0, i + 1).map((p, k) => h('circle', { key: k, cx: p[0], cy: p[1], r: 7, fill: T.bg, stroke: T.ac, strokeWidth: 3 })),
      ),
      // moving marker
      h('div', { style: { position: 'absolute', left: `${mk.x / 1920 * 100}%`, top: `${mk.y / 1080 * 100}%`, transform: 'translate(-50%,-100%)' } },
        h('div', { style: { position: 'relative' } },
          h('div', { style: { position: 'absolute', left: '50%', bottom: -6, width: 60, height: 60, marginLeft: -30, borderRadius: '50%', background: T.ac, opacity: 0.35 * (0.5 + 0.5 * Math.sin(progress * 40)), transform: `scale(${1 + 0.6 * (0.5 + 0.5 * Math.sin(progress * 40))})` } }),
          h('div', { style: { width: 48, height: 48, borderRadius: '50% 50% 50% 0', background: T.ac, transform: 'rotate(-45deg)', boxShadow: `0 0 24px ${T.ac}`, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            h('div', { style: { transform: 'rotate(45deg)', color: T.ink } }, h(Ic, { d: ICON.pin2, size: 22, color: T.ink, sw: 2.4 }))),
        )),
      // live badge
      h('div', { style: { position: 'absolute', top: 60, left: 70, display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(6,10,9,.7)', backdropFilter: 'blur(8px)', border: `1px solid ${T.border2}`, borderRadius: 999, padding: '12px 22px', opacity: seg(progress, 0.08, 0.2) } },
        h('span', { style: { width: 12, height: 12, borderRadius: '50%', background: T.ac, boxShadow: `0 0 0 6px ${T.acSoft}`, opacity: 0.5 + 0.5 * Math.sin(progress * 26) } }),
        h('span', { style: { fontFamily: sans, fontWeight: 700, fontSize: 22, color: '#fff' } }, 'EN DIRECT'),
        h('span', { style: { fontFamily: mono, fontSize: 18, color: T.tx2 } }, `43.60${coordN}, 1.44${coordN}`)),
      // speed chip near marker bottom-right
      h('div', { style: { position: 'absolute', right: 80, top: 60, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 14, opacity: seg(progress, 0.2, 0.35) } },
        h('div', { style: { color: T.ac } }, h(Ic, { d: ICON.speed, size: 26 })),
        h('div', { style: { textAlign: 'left' } },
          h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 30, color: T.tx, lineHeight: 1 } }, `${speed} km/h`),
          h('div', { style: { fontFamily: mono, fontSize: 15, color: T.tx3 } }, 'Kangoo 04'))),
      // title
      h('div', { style: { position: 'absolute', left: 70, bottom: 80, textAlign: 'left', opacity: title, transform: `translateY(${lerp(24, 0, title)}px)` } },
        h(Eyebrow, { text: 'Géolocalisation temps réel', style: { marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 60, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.02 } },
          'Chaque véhicule. ', h('span', { style: { color: T.ac } }, 'À la seconde.'))),
    );
  }

  /* ══════════════ SCENE 3 — COUPE-CIRCUIT ══════════════ */
  function SceneCut({ progress }) {
    const card = Easing.easeOutCubic(seg(progress, 0.08, 0.3));
    const flip = Easing.easeInOutCubic(seg(progress, 0.4, 0.62));
    const stamp = Easing.easeOutBack(seg(progress, 0.6, 0.78));
    const knobX = lerp(6, 66, flip);
    const swBg = `color-mix(in srgb, ${T.red} ${flip * 100}%, ${T.ac})`;
    const title = seg(progress, 0.2, 0.4);
    return h(Frame, { progress, camScale: 0.05 },
      h('div', { style: WRAP },
        h('div', { style: { opacity: title, transform: `translateY(${lerp(20, 0, title)}px)`, marginBottom: 64 } },
          h(Eyebrow, { text: 'Coupe-circuit moteur', color: T.red, style: { marginBottom: 20, justifyContent: 'center' } }),
          h('div', { style: { fontFamily: sans, fontSize: 54, fontWeight: 800, letterSpacing: '-.03em', whiteSpace: 'nowrap', color: T.tx } },
            'Immobilisez ', h('span', { style: { color: T.red } }, 'à distance.'))),
        h('div', { style: { position: 'relative', width: 620, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 26, padding: 40, transform: `translateY(${lerp(40, 0, card)}px) scale(${lerp(0.95, 1, card)})`, opacity: card, boxShadow: '0 40px 90px -30px rgba(0,0,0,.7)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 18, marginBottom: 30 } },
            h('div', { style: { width: 58, height: 58, borderRadius: 15, background: T.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.tx } }, h(Ic, { d: ICON.engine, size: 30, color: T.tx })),
            h('div', { style: { textAlign: 'left' } },
              h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 23, whiteSpace: 'nowrap', color: T.tx } }, 'Renault Kangoo · GK-042-AB'),
              h('div', { style: { fontFamily: mono, fontSize: 17, color: T.tx3 } }, 'Statut moteur'))),
          // switch
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 16, padding: '20px 24px' } },
            h('span', { style: { fontFamily: sans, fontWeight: 700, fontSize: 24, color: flip > 0.5 ? T.red : T.ac } }, flip > 0.5 ? 'MOTEUR COUPÉ' : 'Moteur actif'),
            h('div', { style: { width: 126, height: 56, borderRadius: 999, background: swBg, position: 'relative', boxShadow: `0 0 24px ${flip > 0.5 ? 'rgba(242,112,107,.5)' : T.acSoft}` } },
              h('div', { style: { position: 'absolute', top: 6, left: `${knobX}px`, width: 44, height: 44, borderRadius: '50%', background: '#fff' } }))),
          // safety note
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 26, padding: 16, background: T.acSoft, borderRadius: 14 } },
            h('div', { style: { color: T.ac } }, h(Ic, { d: ICON.shield, size: 24 })),
            h('div', { style: { fontFamily: sans, fontSize: 20, color: T.tx2, textAlign: 'left', lineHeight: 1.4 } },
              'Sécurité : la coupure agit ', h('b', { style: { color: T.tx } }, 'uniquement à l’arrêt'), ' (< 20 km/h). Jamais en roulant.')),
          // stamp
          h('div', { style: { position: 'absolute', right: -34, top: -34, transform: `rotate(-12deg) scale(${stamp})`, opacity: clamp(stamp, 0, 1), border: `4px solid ${T.red}`, color: T.red, fontFamily: mono, fontWeight: 700, fontSize: 26, letterSpacing: '.1em', padding: '10px 20px', borderRadius: 14, background: 'rgba(242,112,107,.08)' } }, 'ANTIVOL'),
        ),
      ));
  }

  /* ══════════════ SCENE 4 — ANALYSE IA ══════════════ */
  function SceneIA({ progress }) {
    const W = 1180, H = 340, X0 = 370, Y0 = 620;
    // speed curve points (x fraction, speed value)
    const spd = [18, 32, 44, 30, 52, 68, 40, 34, 30, 46];
    const limit = 50; const maxV = 80;
    const drawP = seg(progress, 0.16, 0.7);
    const cnt = Math.max(1, Math.round(drawP * spd.length));
    const toXY = (v, k) => [X0 + (k / (spd.length - 1)) * W, Y0 - (v / maxV) * H];
    const linePts = spd.slice(0, cnt).map((v, k) => toXY(v, k));
    const scan = lerp(X0, X0 + W, drawP);
    const title = seg(progress, 0.08, 0.28);
    const flag = Easing.easeOutBack(seg(progress, 0.62, 0.8));
    const zone = Easing.easeOutBack(seg(progress, 0.72, 0.9));
    const scoreN = Math.round(lerp(0, 78, seg(progress, 0.5, 0.92)));
    return h(Frame, { progress, camScale: 0.05 },
      h('div', { style: { position: 'absolute', top: 90, left: 70, textAlign: 'left', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)` } },
        h(Eyebrow, { text: 'Analyse des trajets par IA', style: { marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 58, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.02 } },
          'L’IA relit chaque trajet — ', h('span', { style: { color: T.ac } }, 'même les excès en zone 30.'))),
      // graph panel
      h('div', { style: { position: 'absolute', left: 70, right: 70, top: 300, bottom: 90, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 24, overflow: 'hidden' } },
        h('svg', { viewBox: '0 0 1920 1080', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } },
          // limit line
          h('line', { x1: X0, y1: Y0 - (limit / maxV) * H, x2: X0 + W, y2: Y0 - (limit / maxV) * H, stroke: T.amber, strokeWidth: 3, strokeDasharray: '10 10', opacity: 0.7 }),
          // baseline
          h('line', { x1: X0, y1: Y0, x2: X0 + W, y2: Y0, stroke: T.border, strokeWidth: 2 }),
          // area + curve
          linePts.length > 1 && h('polyline', { points: linePts.map(p => p.join(',')).join(' '), fill: 'none', stroke: T.ac, strokeWidth: 5, strokeLinecap: 'round', strokeLinejoin: 'round', style: { filter: `drop-shadow(0 0 8px ${T.ac})` } }),
          // over-limit dots
          spd.slice(0, cnt).map((v, k) => v > limit ? h('circle', { key: k, cx: toXY(v, k)[0], cy: toXY(v, k)[1], r: 11, fill: T.red, stroke: T.bg, strokeWidth: 4 }) : null),
          // scan line
          h('line', { x1: scan, y1: Y0 - H - 40, x2: scan, y2: Y0 + 20, stroke: T.ac, strokeWidth: 3, opacity: drawP < 1 ? 0.8 : 0 }),
        ),
        h('div', { style: { position: 'absolute', left: 40, top: 30, fontFamily: mono, fontSize: 18, color: T.amber } }, `Limite ${limit} km/h`),
      ),
      // excès flag
      h('div', { style: { position: 'absolute', left: '58%', top: 360, transform: `scale(${flag})`, opacity: clamp(flag, 0, 1), transformOrigin: 'left top' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, background: T.red, color: '#fff', fontFamily: sans, fontWeight: 800, fontSize: 22, padding: '12px 20px', borderRadius: 14, boxShadow: '0 14px 40px -14px rgba(242,112,107,.7)' } },
          h(Ic, { d: ICON.speed, size: 24, color: '#fff', sw: 2.2 }), 'Excès · 68 km/h')),
      // zone 30 flag
      h('div', { style: { position: 'absolute', left: '30%', top: 560, transform: `scale(${zone})`, opacity: clamp(zone, 0, 1), transformOrigin: 'left top' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, background: T.surface2, border: `2px solid ${T.amber}`, borderRadius: 14, padding: '10px 18px' } },
          h('div', { style: { width: 42, height: 42, borderRadius: '50%', background: '#fff', border: `4px solid ${T.red}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: sans, fontWeight: 900, fontSize: 20, color: '#111' } }, '30'),
          h('div', { style: { fontFamily: sans, fontWeight: 700, fontSize: 20, color: T.tx } }, 'Zone 30 · 38 km/h détecté'))),
      // IA score ring
      h('div', { style: { position: 'absolute', right: 110, top: 360, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: seg(progress, 0.48, 0.62) } },
        h('div', { style: { position: 'relative', width: 150, height: 150 } },
          h('svg', { width: 150, height: 150, viewBox: '0 0 120 120' },
            h('circle', { cx: 60, cy: 60, r: 50, fill: 'none', stroke: T.border, strokeWidth: 12 }),
            h('circle', { cx: 60, cy: 60, r: 50, fill: 'none', stroke: T.ac, strokeWidth: 12, strokeLinecap: 'round', strokeDasharray: 314, strokeDashoffset: 314 * (1 - scoreN / 100), transform: 'rotate(-90 60 60)', style: { filter: `drop-shadow(0 0 6px ${T.ac})` } })),
          h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: sans, fontWeight: 800, fontSize: 42, color: T.tx } }, scoreN)),
        h('div', { style: { fontFamily: mono, fontSize: 16, color: T.tx2, marginTop: 16 } }, 'SCORE CONDUITE')),
    );
  }

  /* ══════════════ SCENE 5 — ALERTES ══════════════ */
  function SceneAlerts({ progress }) {
    const items = [
      { ic: ICON.speed, c: T.red, t: 'Excès de vitesse', s: 'Kangoo 04 · 68 km/h en zone 50' },
      { ic: ICON.pin, c: T.amber, t: 'Sortie de zone', s: 'Master 12 a quitté « Chantier Nord »' },
      { ic: ICON.battery, c: T.amber, t: 'Batterie faible', s: 'Boîtier Trafic 07 · 11 %' },
      { ic: ICON.tow, c: T.red, t: 'Remorquage détecté', s: 'Mouvement moteur éteint · Partner 03' },
    ];
    const title = seg(progress, 0.06, 0.24);
    return h(Frame, { progress, camScale: 0.05 },
      h('div', { style: { position: 'absolute', top: 120, left: 70, textAlign: 'left', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)` } },
        h(Eyebrow, { text: 'Alertes intelligentes', color: T.amber, style: { marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 62, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.03 } },
          'Prévenu ', h('span', { style: { color: T.amber } }, 'à l’instant.'))),
      h('div', { style: { position: 'absolute', right: 90, top: 150, width: 720, display: 'flex', flexDirection: 'column', gap: 20 } },
        items.map((it, k) => {
          const a = 0.24 + k * 0.13;
          const e = Easing.easeOutCubic(seg(progress, a, a + 0.22));
          const pulse = k === 0 ? (0.5 + 0.5 * Math.sin(progress * 30)) : 1;
          return h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 20, background: T.surface, border: `1px solid ${T.border}`, borderLeft: `4px solid ${it.c}`, borderRadius: 18, padding: '22px 26px', transform: `translateX(${lerp(120, 0, e)}px)`, opacity: e, boxShadow: '0 20px 50px -26px rgba(0,0,0,.7)' } },
            h('div', { style: { flex: 'none', width: 56, height: 56, borderRadius: 14, background: `color-mix(in srgb, ${it.c} 16%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: it.c, transform: `scale(${pulse * 0.15 + 0.85})` } }, h(Ic, { d: it.ic, size: 30, color: it.c })),
            h('div', { style: { textAlign: 'left' } },
              h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 26, color: T.tx } }, it.t),
              h('div', { style: { fontFamily: sans, fontSize: 20, color: T.tx2, marginTop: 4 } }, it.s)),
            h('div', { style: { marginLeft: 'auto', fontFamily: mono, fontSize: 15, color: T.tx3 } }, 'now'));
        })),
    );
  }

  /* ══════════════ SCENE 6 — OPTIMISATION ══════════════ */
  function SceneOptim({ progress }) {
    const title = seg(progress, 0.06, 0.24);
    const barP = Easing.easeOutCubic(seg(progress, 0.24, 0.55));
    const vansP = Easing.easeInOutCubic(seg(progress, 0.5, 0.82));
    return h(Frame, { progress, camScale: 0.05 },
      h('div', { style: { position: 'absolute', top: 100, left: 70, textAlign: 'left', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)` } },
        h(Eyebrow, { text: 'Coupure programmée · Agent IA', style: { marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 58, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.02 } },
          'Programmez. ', h('span', { style: { color: T.ac } }, 'L’IA optimise.'))),
      // left: schedule bar
      h('div', { style: { position: 'absolute', left: 70, top: 340, width: 820, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 22, padding: 34 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, color: T.ac } }, h(Ic, { d: ICON.calendar, size: 26 }),
          h('span', { style: { fontFamily: sans, fontWeight: 800, fontSize: 26, color: T.tx } }, 'Plage de service · Lun–Ven')),
        h('div', { style: { position: 'relative', height: 66, borderRadius: 14, overflow: 'hidden', display: 'flex', border: `1px solid ${T.border}` } },
          h('div', { style: { width: `${lerp(0, 58, barP)}%`, background: T.acSoft, color: T.ac, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: sans, fontWeight: 700, fontSize: 20, whiteSpace: 'nowrap', overflow: 'hidden' } }, '06h — 18h · service'),
          h('div', { style: { flex: 1, background: 'repeating-linear-gradient(45deg,rgba(242,112,107,.18),rgba(242,112,107,.18) 10px,transparent 10px,transparent 20px)', color: T.red, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: sans, fontWeight: 700, fontSize: 20, opacity: barP } }, h(Ic, { d: ICON.engine, size: 22, color: T.red, sw: 2 }), 'moteur coupé')),
        h('div', { style: { marginTop: 18, fontFamily: sans, fontSize: 20, color: T.tx2 } }, 'Hors plage, chaque véhicule s’immobilise automatiquement.')),
      // right: fleet reduction
      h('div', { style: { position: 'absolute', right: 70, top: 340, width: 820, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 22, padding: 34 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28, color: T.ac } }, h(Ic, { d: ICON.spark, size: 24, color: T.ac, fill: T.ac }),
          h('span', { style: { fontFamily: sans, fontWeight: 800, fontSize: 26, color: T.tx } }, 'Tournées réorganisées')),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', { style: { display: 'flex', gap: 14 } }, [0, 1, 2, 3].map(k => {
            const off = k >= 2 ? vansP : 0;
            return h('div', { key: k, style: { width: 78, height: 78, borderRadius: 16, background: k >= 2 ? T.surface2 : T.acSoft, border: `1px solid ${k >= 2 ? T.border : 'transparent'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: k >= 2 ? T.tx3 : T.ac, opacity: 1 - off * 0.75, transform: `scale(${1 - off * 0.2}) translateY(${off * 20}px)` } }, h(Ic, { d: ICON.tow, size: 40, color: k >= 2 ? T.tx3 : T.ac, sw: 1.6 }));
          })),
          h('div', { style: { color: T.tx3 } }, h(Ic, { d: 'M5 12h14M13 6l6 6-6 6', size: 40, color: T.tx3, sw: 2 })),
          h('div', { style: { textAlign: 'center' } },
            h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 64, color: T.ac, lineHeight: 1 } }, `${Math.round(lerp(4, 2, vansP))}`),
            h('div', { style: { fontFamily: mono, fontSize: 16, color: T.tx2, marginTop: 6 } }, 'VÉHICULES SUFFISENT'))),
        h('div', { style: { marginTop: 22, fontFamily: sans, fontSize: 20, color: T.tx2 } }, 'Moins de km à vide, moins d’entretien, moins de CO₂.')),
    );
  }

  /* ══════════════ SCENE 7 — ROI ══════════════ */
  function SceneROI({ progress }) {
    const title = seg(progress, 0.06, 0.24);
    const rows = [
      { t: 'Éco-conduite & vitesse maîtrisée', v: 22 },
      { t: 'Usage hors service supprimé', v: 18 },
      { t: 'Optimisation des tournées (IA)', v: 20 },
    ];
    const total = Math.round(lerp(0, 60, Easing.easeOutCubic(seg(progress, 0.3, 0.75))));
    const net = Math.round(lerp(0, 30, Easing.easeOutCubic(seg(progress, 0.45, 0.85))));
    const barP = Easing.easeOutCubic(seg(progress, 0.55, 0.9));
    return h(Frame, { progress, camScale: 0.05 },
      h('div', { style: { ...WRAP, justifyContent: 'flex-start', paddingTop: 100 } },
        h('div', { style: { opacity: title, transform: `translateY(${lerp(20, 0, title)}px)`, marginBottom: 40 } },
          h(Eyebrow, { text: 'Retour sur investissement', style: { marginBottom: 18, justifyContent: 'center' } }),
          h('div', { style: { fontFamily: sans, fontSize: 62, fontWeight: 800, letterSpacing: '-.03em', color: T.tx } },
            'Tracky se ', h('span', { style: { color: T.ac } }, 'rembourse tout seul.'))),
        h('div', { style: { width: 1120, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 26, padding: 40 } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 18, marginBottom: 30 } },
            rows.map((r, k) => {
              const e = Easing.easeOutCubic(seg(progress, 0.28 + k * 0.08, 0.28 + k * 0.08 + 0.24));
              return h('div', { key: k, style: { background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 16, padding: 24, textAlign: 'left', opacity: e, transform: `translateY(${lerp(20, 0, e)}px)` } },
                h('div', { style: { fontFamily: sans, fontWeight: 700, fontSize: 20, color: T.tx, lineHeight: 1.25, minHeight: 52 } }, r.t),
                h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 44, color: T.ac, marginTop: 10 } }, `+${Math.round(r.v * Easing.easeOutCubic(seg(progress, 0.3, 0.7)))} €`));
            })),
          h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24 } },
            h('span', { style: { fontFamily: sans, fontSize: 24, color: T.tx2 } }, 'Économies estimées'),
            h('span', { style: { fontFamily: sans, fontWeight: 800, fontSize: 40, whiteSpace: 'nowrap', color: T.tx } }, `${total} €`, h('span', { style: { fontSize: 22, color: T.tx3, fontWeight: 600 } }, ' / véh / mois'))),
          h('div', { style: { display: 'flex', height: 66, borderRadius: 16, overflow: 'hidden', boxShadow: `inset 0 0 0 1px ${T.border}` } },
            h('div', { style: { width: '50%', background: T.tx3, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: sans, fontWeight: 700, fontSize: 22 } }, 'Abonnement 29,90 €'),
            h('div', { style: { width: `${lerp(0, 50, barP)}%`, background: T.ac, color: T.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontFamily: sans, fontWeight: 800, fontSize: 22, whiteSpace: 'nowrap', overflow: 'hidden' } }, h(Ic, { d: 'M12 19V5M5 12l7-7 7 7', size: 22, color: T.ink, sw: 2.6 }), `Gain net +${net},10 €`)))));
  }

  /* ══════════════ SCENE 8 — PIVOT ══════════════ */
  function ScenePivot({ progress }) {
    const l1 = seg(progress, 0.1, 0.35);
    const l2 = seg(progress, 0.42, 0.7);
    const logo = Easing.easeOutBack(seg(progress, 0.55, 0.85));
    const tintP = seg(progress, 0.5, 1);
    return h(Frame, { progress, tint: tintP > 0.4 ? 'blue' : null, camScale: 0.1 },
      h('div', { style: WRAP },
        h('div', { style: { fontFamily: sans, fontSize: 44, fontWeight: 700, whiteSpace: 'nowrap', color: T.tx2, opacity: l1, transform: `translateY(${lerp(20, 0, l1)}px)` } },
          'Tout ça, c’est Vizyo Tracky.'),
        h('div', { style: { marginTop: 44, maxWidth: 1500, fontFamily: sans, fontSize: 80, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, opacity: l2, transform: `scale(${lerp(0.9, 1, Easing.easeOutCubic(l2))})`, lineHeight: 1.08 } },
          'Et maintenant, imaginez-le ',
          h('span', { style: { background: `linear-gradient(90deg, ${T.ac}, ${M.ac})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' } }, 'couplé à Maestroo.')),
        h('div', { style: { marginTop: 54, transform: `scale(${logo})`, opacity: clamp(logo, 0, 1) } },
          h(MaestrooLogo, { size: 130, id: 'mp' })),
      ));
  }

  /* ══════════════ SCENE 9 — PARTENARIAT ══════════════ */
  function ScenePartner({ progress }) {
    const title = seg(progress, 0.05, 0.22);
    const panels = Easing.easeOutCubic(seg(progress, 0.16, 0.4));
    const flowP = seg(progress, 0.4, 1);
    const leftFeed = ['Carburant', 'Scores conducteur', 'Km & trajets', 'Télémétrie live'];
    const cy = 560;
    return h(Frame, { progress, tint: 'blue', camScale: 0.04 },
      h('div', { style: { position: 'absolute', top: 90, left: 0, right: 0, textAlign: 'center', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)` } },
        h(Eyebrow, { text: 'Le partenariat', style: { justifyContent: 'center', marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 52, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.06 } },
          'Les données ', h('span', { style: { color: T.ac } }, 'Tracky'), ' nourrissent ', h('span', { style: { color: M.ac } }, 'Maestroo.'))),
      // connection layer
      h('svg', { viewBox: '0 0 1920 1080', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } },
        h('line', { x1: 620, y1: cy, x2: 1300, y2: cy, stroke: T.border, strokeWidth: 3 }),
        // green particles L->R (data)
        [0, 1, 2, 3, 4].map(k => {
          const ph = (flowP * 1.4 + k * 0.2) % 1;
          return h('circle', { key: 'g' + k, cx: lerp(620, 1300, ph), cy: cy, r: 8, fill: T.ac, opacity: (1 - Math.abs(ph - 0.5) * 1.2) * (flowP > 0 ? 1 : 0), style: { filter: `drop-shadow(0 0 6px ${T.ac})` } });
        }),
        // blue particle R->L (clients) slightly below
        [0, 1].map(k => {
          const ph = (flowP * 0.9 + k * 0.5) % 1;
          return h('circle', { key: 'b' + k, cx: lerp(1300, 620, ph), cy: cy + 40, r: 8, fill: M.ac, opacity: (1 - Math.abs(ph - 0.5) * 1.2) * seg(progress, 0.55, 1), style: { filter: `drop-shadow(0 0 6px ${M.ac})` } });
        }),
      ),
      // left panel — Tracky
      h('div', { style: { position: 'absolute', left: 140, top: 330, width: 460, opacity: panels, transform: `translateX(${lerp(-60, 0, panels)}px)` } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22 } }, h(TrackyLogo, { size: 58 }),
          h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 30, whiteSpace: 'nowrap', color: T.tx } }, 'Vizyo', h('span', { style: { color: T.ac } }, ' Tracky'))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          leftFeed.map((f, k) => {
            const e = seg(progress, 0.34 + k * 0.06, 0.34 + k * 0.06 + 0.2);
            return h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 14, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: '16px 20px', opacity: e, transform: `translateY(${lerp(14, 0, e)}px)` } },
              h('div', { style: { color: T.ac } }, h(Ic, { d: k === 0 ? ICON.fuel : k === 1 ? ICON.users : k === 2 ? ICON.chart : ICON.speed, size: 26 })),
              h('span', { style: { fontFamily: sans, fontWeight: 700, fontSize: 22, color: T.tx } }, f),
              h('div', { style: { marginLeft: 'auto', color: T.ac } }, h(Ic, { d: 'M5 12h14M13 6l6 6-6 6', size: 20, color: T.ac, sw: 2.4 })));
          })),
      ),
      // right panel — Maestroo dashboard
      h('div', { style: { position: 'absolute', right: 140, top: 330, width: 460, opacity: panels, transform: `translateX(${lerp(60, 0, panels)}px)` } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22, justifyContent: 'flex-end' } },
          h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 30, color: T.tx } }, 'Maestroo'), h(MaestrooLogo, { size: 58, id: 'mpa' })),
        h('div', { style: { background: T.surface, border: `1px solid ${M.soft}`, borderRadius: 18, padding: 26 } },
          h('div', { style: { fontFamily: mono, fontSize: 15, color: M.acLight, letterSpacing: '.1em', marginBottom: 16 } }, 'GESTION TRANSPORT · ENRICHIE'),
          [['Coût carburant / mission', '−14 %', T.ac], ['Score flotte moyen', '78/100', M.ac], ['Facturation au km', 'auto', M.ac]].map((r, k) => {
            const e = seg(progress, 0.5 + k * 0.08, 0.5 + k * 0.08 + 0.2);
            return h('div', { key: k, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', borderBottom: k < 2 ? `1px solid ${T.border}` : 'none', opacity: e } },
              h('span', { style: { fontFamily: sans, fontSize: 21, color: T.tx2 } }, r[0]),
              h('span', { style: { fontFamily: sans, fontWeight: 800, fontSize: 24, whiteSpace: 'nowrap', color: r[2] } }, r[1]));
          })),
      ),
      // bottom line: clients back
      h('div', { style: { position: 'absolute', left: 0, right: 0, bottom: 90, textAlign: 'center', opacity: seg(progress, 0.6, 0.82) } },
        h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 14, background: T.surface, border: `1px solid ${M.soft}`, borderRadius: 999, padding: '16px 30px' } },
          h('div', { style: { color: M.ac } }, h(Ic, { d: ICON.users, size: 26, color: M.ac })),
          h('span', { style: { fontFamily: sans, fontWeight: 700, fontSize: 24, color: T.tx } }, 'Et Maestroo amène de ', h('span', { style: { color: M.ac } }, 'nouveaux clients'), ' à Tracky.'))),
    );
  }

  /* ══════════════ SCENE 10 — CLOSING ══════════════ */
  function SceneClosing({ progress }) {
    const logos = Easing.easeOutBack(seg(progress, 0.08, 0.4));
    const x = seg(progress, 0.3, 0.5);
    const word = seg(progress, 0.4, 0.62);
    const tag = seg(progress, 0.58, 0.8);
    const foot = seg(progress, 0.7, 0.9);
    return h(Frame, { progress, tint: 'blue', camScale: 0.06 },
      h('div', { style: WRAP },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 48, marginBottom: 34 } },
          h('div', { style: { transform: `scale(${logos})`, opacity: clamp(logos, 0, 1) } }, h(TrackyLogo, { size: 120 })),
          h('div', { style: { fontFamily: sans, fontWeight: 300, fontSize: 70, color: T.tx3, opacity: x, transform: `scale(${lerp(0.5, 1, x)})` } }, '×'),
          h('div', { style: { transform: `scale(${logos})`, opacity: clamp(logos, 0, 1) } }, h(MaestrooLogo, { size: 120, id: 'mc' })),
        ),
        h('div', { style: { fontFamily: sans, fontSize: 74, fontWeight: 800, letterSpacing: '-.03em', whiteSpace: 'nowrap', color: T.tx, opacity: word, transform: `translateY(${lerp(24, 0, word)}px)` } },
          h('span', { style: { color: T.ac } }, 'Tracky'), ' × ', h('span', { style: { color: M.ac } }, 'Maestroo')),
        h('div', { style: { marginTop: 20, fontFamily: sans, fontSize: 34, fontWeight: 600, whiteSpace: 'nowrap', color: T.tx2, opacity: tag, transform: `translateY(${lerp(16, 0, tag)}px)` } },
          'Le duo des flottes de transport.'),
        h('a', { href: 'https://tracky.vizyoagency.com', style: { marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: mono, fontSize: 24, fontWeight: 600, color: T.ac, opacity: tag } },
          h(Ic, { d: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M2 12h20', 'M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20z'], size: 22, color: T.ac, sw: 1.6 }), 'tracky.vizyoagency.com'),
        h('div', { style: { marginTop: 28, opacity: tag } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 10, border: `1px solid ${T.border2}`, borderRadius: 999, padding: '10px 18px' } },
            h('span', { style: { width: 9, height: 9, borderRadius: '50%', background: T.amber } }),
            h('span', { style: { fontFamily: mono, fontSize: 18, color: T.tx2, letterSpacing: '.16em', textTransform: 'uppercase' } }, 'En cours de mise en place'))),
        h('a', { href: 'https://vizyoagency.com', style: { marginTop: 44, display: 'inline-flex', alignItems: 'center', gap: 14, opacity: foot, transform: `translateY(${lerp(14, 0, foot)}px)` } },
          h('span', { style: { fontFamily: mono, fontSize: 17, letterSpacing: '.14em', textTransform: 'uppercase', color: T.tx3 } }, 'Propulsé par'),
          h('img', { src: './vizyo-agency-icon.png', width: 34, height: 43, style: { display: 'block' } }),
          h('span', { style: { fontFamily: sans, fontWeight: 800, fontSize: 24, whiteSpace: 'nowrap', color: T.tx } }, 'Vizyo Agency'),
          h('span', { style: { fontFamily: mono, fontSize: 16, color: T.tx3 } }, '· vizyoagency.com')),
      ));
  }

  /* ══════════════ SCENE — RÔLES / DÉLÉGATION ══════════════ */
  function SceneRoles({ progress }) {
    const title = seg(progress, 0.06, 0.24);
    const panel = Easing.easeOutCubic(seg(progress, 0.2, 0.42));
    const promote = Easing.easeInOutCubic(seg(progress, 0.5, 0.72));
    const note = seg(progress, 0.66, 0.84);
    const people = [
      { n: 'Karim B.', r: 'Admin', c: T.ac, fixed: true },
      { n: 'Julie M.', r: 'Chef d’équipe', promoted: true },
      { n: 'Thomas R.', r: 'Agent', c: T.tx2 },
      { n: 'Lecture seule', r: 'Invité', c: T.tx3 },
    ];
    return h(Frame, { progress, camScale: 0.05 },
      h('div', { style: { position: 'absolute', top: 100, left: 70, textAlign: 'left', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)` } },
        h(Eyebrow, { text: 'Comptes, utilisateurs & rôles', style: { marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 56, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.03 } },
          'Déléguez la gestion à vos ', h('span', { style: { color: T.ac } }, 'chefs d’équipe.'))),
      h('div', { style: { position: 'absolute', left: 70, right: 70, top: 320, bottom: 90, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 24, padding: 34, opacity: panel, transform: `translateY(${lerp(30, 0, panel)}px)` } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22, paddingBottom: 20, borderBottom: `1px solid ${T.border}` } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: sans, fontWeight: 800, fontSize: 26, color: T.tx } }, h('span', { style: { color: T.ac } }, h(Ic, { d: ICON.users, size: 28 })), 'Gestion des accès'),
          h('span', { style: { fontFamily: mono, fontSize: 16, color: T.tx3, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px' } }, '4 rôles · accès par site')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          people.map((p, k) => {
            const e = seg(progress, 0.3 + k * 0.05, 0.3 + k * 0.05 + 0.2);
            const hot = p.promoted;
            const roleTxt = hot ? (promote > 0.5 ? 'Gestionnaire' : 'Agent') : p.r;
            const roleCol = hot ? (promote > 0.5 ? T.ac : T.tx2) : (p.c || T.tx2);
            return h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 18, background: hot ? T.acSoft : T.surface2, border: `1px solid ${hot && promote > 0.3 ? 'rgba(16,224,160,.4)' : T.border}`, borderRadius: 14, padding: '16px 20px', opacity: e, transform: `translateX(${lerp(30, 0, e)}px)` } },
              h('div', { style: { flex: 'none', width: 50, height: 50, borderRadius: '50%', background: `color-mix(in srgb, ${roleCol} 22%, ${T.bg})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: sans, fontWeight: 800, fontSize: 20, color: roleCol } }, p.n[0]),
              h('div', { style: { textAlign: 'left', flex: 1 } },
                h('div', { style: { fontFamily: sans, fontWeight: 700, fontSize: 23, color: T.tx } }, p.n),
                hot && h('div', { style: { fontFamily: sans, fontSize: 16, color: T.tx3, marginTop: 2 } }, 'Pilote sa flotte · site Toulouse')),
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: sans, fontWeight: 700, fontSize: 19, color: roleCol, background: `color-mix(in srgb, ${roleCol} 14%, transparent)`, borderRadius: 10, padding: '9px 16px', transform: hot ? `scale(${1 + 0.06 * Math.sin(progress * 20) * (promote > 0.5 ? 1 : 0)})` : 'none' } },
                hot && promote > 0.5 && h(Ic, { d: ICON.check, size: 18, color: roleCol, sw: 2.6 }), roleTxt));
          })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 22, padding: 16, background: T.acSoft, borderRadius: 14, opacity: note } },
          h('div', { style: { color: T.ac } }, h(Ic, { d: ICON.shield, size: 24 })),
          h('div', { style: { fontFamily: sans, fontSize: 20, color: T.tx2, textAlign: 'left' } }, 'Le chef d’équipe ', h('b', { style: { color: T.tx } }, 'gère son équipe et ses véhicules'), ' — vous gardez le contrôle global et la traçabilité.'))),
    );
  }

  /* ══════════════ SCENE — MODULES × ÉCONOMIES ══════════════ */
  function SceneModulesEco({ progress }) {
    const title = seg(progress, 0.04, 0.2);
    const world = Easing.easeOutCubic(seg(progress, 0.14, 0.32));
    const simHour = seg(progress, 0.16, 0.92) * 24;         // 0h → 24h sweep
    const service = simHour >= 5 && simHour < 21;
    const serviceFrac = clamp((simHour - 5) / 16, 0, 1);
    const nightAmt = simHour < 5 ? (5 - simHour) / 5 : (simHour >= 21 ? clamp((simHour - 21) / 3, 0, 1) : 0);
    const hh = String(Math.floor(simHour) % 24).padStart(2, '0');
    const roadL = 90, roadR = 1830;
    const sunX = lerp(roadL, roadR, simHour / 24);
    const sunY = 250 - Math.sin(clamp((simHour - 5) / 16, 0, 1) * Math.PI) * 150;
    const sky = service
      ? `linear-gradient(180deg, #0e2e33 ${nightAmt * 100}%, #123b3a, #0b1614)`
      : `linear-gradient(180deg, #05080a, #081011)`;
    const fuelSaved = Math.round(nightAmt * 18);
    const dash = -(simHour * 60) % 120;
    return h(Frame, { progress, camScale: 0.04 },
      // sky
      h('div', { style: { position: 'absolute', left: 70, right: 70, top: 290, bottom: 90, borderRadius: 24, overflow: 'hidden', border: `1px solid ${T.border}`, background: sky, opacity: world, transform: `translateY(${lerp(24, 0, world)}px)` } },
        // stars at night
        h('div', { style: { position: 'absolute', inset: 0, opacity: nightAmt, backgroundImage: 'radial-gradient(1.5px 1.5px at 20% 22%,#cfe,transparent),radial-gradient(1.5px 1.5px at 62% 15%,#bdf,transparent),radial-gradient(1.5px 1.5px at 82% 30%,#cff,transparent),radial-gradient(1.5px 1.5px at 42% 12%,#dff,transparent)' } }),
        // sun / moon
        h('div', { style: { position: 'absolute', left: sunX - 70, top: sunY, width: 54, height: 54, borderRadius: '50%', background: nightAmt > 0.5 ? '#cdd6e6' : T.amber, boxShadow: `0 0 60px 10px ${nightAmt > 0.5 ? 'rgba(205,214,230,.4)' : 'rgba(245,179,61,.55)'}` } }),
        // road
        h('div', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 150, background: '#0a0f0e', borderTop: `2px solid ${T.border2}` } },
          h('div', { style: { position: 'absolute', top: 72, left: 0, right: 0, height: 5, backgroundImage: `repeating-linear-gradient(90deg, ${T.tx3} 0 46px, transparent 46px 120px)`, backgroundPositionX: `${dash}px`, opacity: 0.6 } })),
        // vans
        [{ c: T.ac, lane: 30, off: 0 }, { c: '#7fe9c8', lane: 78, off: 120 }, { c: T.ac2, lane: 30, off: 260 }].map((v, k) => {
          const x = lerp(roadL, roadR - 360, serviceFrac) + v.off - (v.off > 0 && !service ? 0 : 0);
          const bob = service ? Math.sin(simHour * 6 + k) * 2.5 : 0;
          return h('div', { key: k, style: { position: 'absolute', left: `${x}px`, bottom: `${v.lane}px`, transform: `translateY(${bob}px)`, color: v.c, opacity: service ? 1 : 0.45, transition: 'none' } },
            h(Ic, { d: ICON.tow, size: 76, color: v.c, sw: 1.5 }),
            !service && h('div', { style: { position: 'absolute', top: -14, left: 24, background: T.red, color: '#fff', borderRadius: 7, padding: '3px 8px', fontFamily: mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' } }, 'coupé'));
        }),
        // status chip
        h('div', { style: { position: 'absolute', top: 22, left: 26, display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(6,10,9,.6)', backdropFilter: 'blur(6px)', border: `1px solid ${service ? 'rgba(16,224,160,.4)' : 'rgba(242,112,107,.4)'}`, borderRadius: 12, padding: '12px 18px' } },
          h('span', { style: { fontFamily: sans, fontWeight: 800, fontSize: 40, color: T.tx, letterSpacing: '-.02em' } }, `${hh}:00`),
          h('span', { style: { fontFamily: sans, fontWeight: 700, fontSize: 18, color: service ? T.ac : T.red } }, service ? 'EN SERVICE' : 'HORS SERVICE · coupé')),
        // fuel saved
        h('div', { style: { position: 'absolute', top: 22, right: 26, display: 'flex', alignItems: 'center', gap: 12, background: T.acSoft, border: `1px solid rgba(16,224,160,.35)`, borderRadius: 12, padding: '12px 18px', opacity: nightAmt > 0 ? 1 : 0.25 } },
          h('div', { style: { color: T.ac } }, h(Ic, { d: ICON.fuel, size: 24 })),
          h('div', { style: { textAlign: 'right' } },
            h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 26, color: T.ac, lineHeight: 1 } }, `−${fuelSaved} €`),
            h('div', { style: { fontFamily: mono, fontSize: 13, color: T.tx3, marginTop: 3 } }, 'trajets perso évités'))),
        // 24h timeline
        h('div', { style: { position: 'absolute', left: 26, right: 26, bottom: 20, height: 26, borderRadius: 8, overflow: 'hidden', display: 'flex', boxShadow: `inset 0 0 0 1px ${T.border}` } },
          h('div', { style: { width: `${5 / 24 * 100}%`, background: 'repeating-linear-gradient(45deg,rgba(242,112,107,.2),rgba(242,112,107,.2) 7px,transparent 7px,transparent 14px)' } }),
          h('div', { style: { width: `${16 / 24 * 100}%`, background: T.acSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.ac } }, '05h — 21h · service'),
          h('div', { style: { flex: 1, background: 'repeating-linear-gradient(45deg,rgba(242,112,107,.2),rgba(242,112,107,.2) 7px,transparent 7px,transparent 14px)' } })),
        h('div', { style: { position: 'absolute', bottom: 20, left: `calc(26px + ${simHour / 24 * 100}% - ${simHour / 24 * 52}px)`, width: 3, height: 26, background: '#fff', boxShadow: '0 0 8px #fff' } }),
      ),
      // title
      h('div', { style: { position: 'absolute', top: 90, left: 70, textAlign: 'left', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)` } },
        h(Eyebrow, { text: 'Mode horaire de flotte', style: { marginBottom: 16 } }),
        h('div', { style: { fontFamily: sans, fontSize: 52, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.04 } },
          'Votre flotte roule ', h('span', { style: { color: T.ac } }, '05h–21h'), ' — plus la nuit.')),
    );
  }

  /* ══════════════ SCENE — MULTI-PLATEFORME (PC / MOBILE) ══════════════ */
  function SceneMultiPlatform({ progress }) {
    const title = seg(progress, 0.05, 0.22);
    const pc = Easing.easeOutCubic(seg(progress, 0.2, 0.44));
    const mob = Easing.easeOutCubic(seg(progress, 0.34, 0.58));
    const bob = Math.sin(progress * 6) * 5;
    return h(Frame, { progress, tint: 'blue', camScale: 0.05 },
      h('div', { style: { position: 'absolute', top: 96, left: 0, right: 0, textAlign: 'center', opacity: title, transform: `translateY(${lerp(20, 0, title)}px)`, padding: '0 120px' } },
        h(Eyebrow, { text: 'Web & mobile', style: { justifyContent: 'center', marginBottom: 18 } }),
        h('div', { style: { fontFamily: sans, fontSize: 54, fontWeight: 800, letterSpacing: '-.03em', color: T.tx, lineHeight: 1.05 } },
          'Sur PC pour ', h('span', { style: { color: T.ac } }, 'superviser'), ', sur mobile pour ', h('span', { style: { color: T.ac } }, 'agir vite.'))),
      // desktop
      h('div', { style: { position: 'absolute', left: 150, top: 350, width: 880, opacity: pc, transform: `translateX(${lerp(-70, 0, pc)}px) translateY(${bob * 0.4}px)` } },
        h('div', { style: { background: '#0d1211', border: `1px solid ${T.border2}`, borderRadius: '16px 16px 6px 6px', overflow: 'hidden', boxShadow: '0 40px 90px -30px rgba(0,0,0,.7)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, padding: '11px 15px', borderBottom: `1px solid ${T.border}` } },
            h('span', { style: { width: 10, height: 10, borderRadius: '50%', background: '#F2706B' } }), h('span', { style: { width: 10, height: 10, borderRadius: '50%', background: '#F5B33D' } }), h('span', { style: { width: 10, height: 10, borderRadius: '50%', background: T.ac } }),
            h('span', { style: { marginLeft: 10, fontFamily: mono, fontSize: 13, color: T.tx3 } }, 'supervision — 14 véhicules')),
          h('div', { style: { display: 'flex', height: 360 } },
            h('div', { style: { width: 210, borderRight: `1px solid ${T.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 } },
              [0, 1, 2, 3].map(i => h('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 10, background: i === 0 ? T.acSoft : 'transparent', borderRadius: 9, padding: '10px 12px' } },
                h('span', { style: { width: 20, height: 20, borderRadius: 6, background: i === 0 ? T.ac : T.surface2 } }),
                h('span', { style: { height: 9, borderRadius: 5, width: i === 0 ? 90 : 70 + i * 6, background: i === 0 ? 'rgba(16,224,160,.5)' : T.border2 } })))),
            h('div', { style: { flex: 1, position: 'relative', background: `radial-gradient(ellipse 90% 80% at 55% 50%, ${T.map2}, ${T.map})` } },
              h('svg', { viewBox: '0 0 600 360', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } },
                ['M0 250 L180 190 L320 220 L520 120 L600 150', 'M120 360 L200 200 L260 90', 'M600 300 L440 200 L360 110'].map((d, k) => h('path', { key: k, d, fill: 'none', stroke: 'rgba(255,255,255,.07)', strokeWidth: 5 })),
                h('polyline', { points: '60,300 180,250 300,270 430,190 520,210', fill: 'none', stroke: T.ac, strokeWidth: 4, style: { filter: `drop-shadow(0 0 6px ${T.ac})` } })),
              [[180, 250], [300, 270], [430, 190]].map((p, k) => h('div', { key: k, style: { position: 'absolute', left: `${p[0] / 600 * 100}%`, top: `${p[1] / 360 * 100}%`, width: 16, height: 16, marginLeft: -8, marginTop: -8, borderRadius: '50% 50% 50% 0', background: T.ac, transform: 'rotate(-45deg)', boxShadow: `0 0 12px ${T.ac}` } }))))),
        h('div', { style: { marginTop: 16, textAlign: 'center', fontFamily: sans, fontWeight: 700, fontSize: 22, color: T.tx } }, 'PC · ', h('span', { style: { color: T.tx2, fontWeight: 500 } }, 'supervision complète')),
      ),
      // phone
      h('div', { style: { position: 'absolute', right: 200, top: 330, width: 300, opacity: mob, transform: `translateX(${lerp(70, 0, mob)}px) translateY(${bob}px)` } },
        h('div', { style: { background: '#0d1211', border: `2px solid ${T.border2}`, borderRadius: 34, padding: 12, boxShadow: '0 40px 90px -24px rgba(0,0,0,.8)' } },
          h('div', { style: { background: T.bg, borderRadius: 24, overflow: 'hidden', height: 470, position: 'relative' } },
            h('div', { style: { height: 26, display: 'flex', justifyContent: 'center' } }, h('div', { style: { width: 110, height: 20, background: '#0d1211', borderRadius: '0 0 14px 14px' } })),
            h('div', { style: { padding: '6px 18px' } },
              h('div', { style: { fontFamily: sans, fontWeight: 800, fontSize: 20, color: T.tx, marginBottom: 4 } }, 'Kangoo 04'),
              h('div', { style: { fontFamily: mono, fontSize: 12, color: T.ac, marginBottom: 16 } }, '● en direct · Toulouse'),
              [['Couper le moteur', T.red, ICON.engine], ['Localiser', T.ac, ICON.pin], ['Voir les alertes', T.amber, ICON.bell]].map((b, k) => {
                const e = seg(progress, 0.5 + k * 0.06, 0.5 + k * 0.06 + 0.2);
                return h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 12, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 13, padding: '14px 15px', marginBottom: 11, opacity: e, transform: `translateY(${lerp(12, 0, e)}px)` } },
                  h('div', { style: { width: 34, height: 34, borderRadius: 9, background: `color-mix(in srgb, ${b[1]} 16%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: b[1] } }, h(Ic, { d: b[2], size: 19, color: b[1] })),
                  h('span', { style: { fontFamily: sans, fontWeight: 700, fontSize: 16, color: T.tx } }, b[0]));
              })))),
        h('div', { style: { marginTop: 16, textAlign: 'center', fontFamily: sans, fontWeight: 700, fontSize: 22, color: T.tx } }, 'Mobile · ', h('span', { style: { color: T.tx2, fontWeight: 500 } }, 'actions rapides')),
      ),
    );
  }

  /* ── Root ─────────────────────────────────────────────────── */
  const MAP = {
    Intro: SceneIntro, GPS: SceneGPS, CoupeCircuit: SceneCut, AnalyseIA: SceneIA,
    Alertes: SceneAlerts, Optimisation: SceneOptim, Roles: SceneRoles, ROI: SceneROI,
    ModulesEco: SceneModulesEco, MultiPlateforme: SceneMultiPlatform, Pivot: ScenePivot, Partenariat: ScenePartner, Closing: SceneClosing,
  };

  function VizyoTrackyVideo(props) {
    const w = props.width || 1920, ht = props.height || 1080;
    return h(SceneStage, { width: w, height: ht, bg: T.bg,
      scenes: window.OM_SCENES, playback: window.OM_PLAYBACK }, MAP);
  }

  window.VizyoTrackyVideo = VizyoTrackyVideo;
})();
