/* Tracky video engine — transpiled from design handoff, do not edit */

;(function(){
const Easing = {
  linear: (t) => t,
  // Quad
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  // Cubic
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => --t * t * t + 1,
  easeInOutCubic: (t) => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  // Quart
  easeInQuart: (t) => t * t * t * t,
  easeOutQuart: (t) => 1 - --t * t * t * t,
  easeInOutQuart: (t) => t < 0.5 ? 8 * t * t * t * t : 1 - 8 * --t * t * t * t,
  // Expo
  easeInExpo: (t) => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
  easeOutExpo: (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  easeInOutExpo: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    if (t < 0.5) return 0.5 * Math.pow(2, 20 * t - 10);
    return 1 - 0.5 * Math.pow(2, -20 * t + 10);
  },
  // Sine
  easeInSine: (t) => 1 - Math.cos(t * Math.PI / 2),
  easeOutSine: (t) => Math.sin(t * Math.PI / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  // Back (overshoot)
  easeOutBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeInBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
  easeInOutBack: (t) => {
    const c1 = 1.70158, c2 = c1 * 1.525;
    return t < 0.5 ? Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  },
  // Elastic
  easeOutElastic: (t) => {
    const c4 = 2 * Math.PI / 3;
    if (t === 0) return 0;
    if (t === 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  }
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
function interpolate(input, output, ease = Easing.linear) {
  return (t) => {
    if (t <= input[0]) return output[0];
    if (t >= input[input.length - 1]) return output[output.length - 1];
    for (let i = 0; i < input.length - 1; i++) {
      if (t >= input[i] && t <= input[i + 1]) {
        const span = input[i + 1] - input[i];
        const local = span === 0 ? 0 : (t - input[i]) / span;
        const easeFn = Array.isArray(ease) ? ease[i] || Easing.linear : ease;
        const eased = easeFn(local);
        return output[i] + (output[i + 1] - output[i]) * eased;
      }
    }
    return output[output.length - 1];
  };
}
function animate({ from = 0, to = 1, start = 0, end = 1, ease = Easing.easeInOutCubic }) {
  return (t) => {
    if (t <= start) return from;
    if (t >= end) return to;
    const local = (t - start) / (end - start);
    return from + (to - from) * ease(local);
  };
}
const TimelineContext = React.createContext({ time: 0, duration: 10, playing: false });
const useTime = () => React.useContext(TimelineContext).time;
const useTimeline = () => React.useContext(TimelineContext);
const SpriteContext = React.createContext({ localTime: 0, progress: 0, duration: 0 });
const useSprite = () => React.useContext(SpriteContext);
function Sprite({ start = 0, end = Infinity, children, keepMounted = false }) {
  const { time } = useTimeline();
  const visible = time >= start && time <= end;
  if (!visible && !keepMounted) return null;
  const duration = end - start;
  const localTime = Math.max(0, time - start);
  const progress = duration > 0 && isFinite(duration) ? clamp(localTime / duration, 0, 1) : 0;
  const value = { localTime, progress, duration, visible };
  return /* @__PURE__ */ React.createElement(SpriteContext.Provider, { value }, typeof children === "function" ? children(value) : children);
}
function TextSprite({
  text,
  x = 0,
  y = 0,
  size = 48,
  color = "#111",
  font = "Inter, system-ui, sans-serif",
  weight = 600,
  entryDur = 0.45,
  exitDur = 0.35,
  entryEase = Easing.easeOutBack,
  exitEase = Easing.easeInCubic,
  align = "left",
  letterSpacing = "-0.01em"
}) {
  const { localTime, duration } = useSprite();
  const exitStart = Math.max(0, duration - exitDur);
  let opacity = 1;
  let ty = 0;
  if (localTime < entryDur) {
    const t = entryEase(clamp(localTime / entryDur, 0, 1));
    opacity = t;
    ty = (1 - t) * 16;
  } else if (localTime > exitStart) {
    const t = exitEase(clamp((localTime - exitStart) / exitDur, 0, 1));
    opacity = 1 - t;
    ty = -t * 8;
  }
  const translateX = align === "center" ? "-50%" : align === "right" ? "-100%" : "0";
  return /* @__PURE__ */ React.createElement("div", { style: {
    position: "absolute",
    left: x,
    top: y,
    transform: `translate(${translateX}, ${ty}px)`,
    opacity,
    fontFamily: font,
    fontSize: size,
    fontWeight: weight,
    color,
    letterSpacing,
    whiteSpace: "pre",
    lineHeight: 1.1,
    willChange: "transform, opacity"
  } }, text);
}
function ImageSprite({
  src,
  x = 0,
  y = 0,
  width = 400,
  height = 300,
  entryDur = 0.6,
  exitDur = 0.4,
  kenBurns = false,
  kenBurnsScale = 1.08,
  radius = 12,
  fit = "cover",
  placeholder = null
  // {label: string} for striped placeholder
}) {
  const { localTime, duration } = useSprite();
  const exitStart = Math.max(0, duration - exitDur);
  let opacity = 1;
  let scale = 1;
  if (localTime < entryDur) {
    const t = Easing.easeOutCubic(clamp(localTime / entryDur, 0, 1));
    opacity = t;
    scale = 0.96 + 0.04 * t;
  } else if (localTime > exitStart) {
    const t = Easing.easeInCubic(clamp((localTime - exitStart) / exitDur, 0, 1));
    opacity = 1 - t;
    scale = (kenBurns ? kenBurnsScale : 1) + 0.02 * t;
  } else if (kenBurns) {
    const holdSpan = exitStart - entryDur;
    const holdT = holdSpan > 0 ? (localTime - entryDur) / holdSpan : 0;
    scale = 1 + (kenBurnsScale - 1) * holdT;
  }
  const content = placeholder ? /* @__PURE__ */ React.createElement("div", { style: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "repeating-linear-gradient(135deg, #e9e6df 0 10px, #dcd8cf 10px 20px)",
    color: "#6b6458",
    fontFamily: "JetBrains Mono, ui-monospace, monospace",
    fontSize: 13,
    letterSpacing: "0.04em",
    textTransform: "uppercase"
  } }, placeholder.label || "image") : /* @__PURE__ */ React.createElement("img", { src, alt: "", style: { width: "100%", height: "100%", objectFit: fit, display: "block" } });
  return /* @__PURE__ */ React.createElement("div", { style: {
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
    opacity,
    transform: `scale(${scale})`,
    transformOrigin: "center",
    borderRadius: radius,
    overflow: "hidden",
    willChange: "transform, opacity"
  } }, content);
}
function RectSprite({
  x = 0,
  y = 0,
  width = 100,
  height = 100,
  color = "#111",
  radius = 8,
  entryDur = 0.4,
  exitDur = 0.3,
  render
  // optional: (ctx) => style overrides
}) {
  const spriteCtx = useSprite();
  const { localTime, duration } = spriteCtx;
  const exitStart = Math.max(0, duration - exitDur);
  let opacity = 1;
  let scale = 1;
  if (localTime < entryDur) {
    const t = Easing.easeOutBack(clamp(localTime / entryDur, 0, 1));
    opacity = clamp(localTime / entryDur, 0, 1);
    scale = 0.4 + 0.6 * t;
  } else if (localTime > exitStart) {
    const t = Easing.easeInQuad(clamp((localTime - exitStart) / exitDur, 0, 1));
    opacity = 1 - t;
    scale = 1 - 0.15 * t;
  }
  const overrides = render ? render(spriteCtx) : {};
  return /* @__PURE__ */ React.createElement("div", { style: {
    position: "absolute",
    left: x,
    top: y,
    width,
    height,
    background: color,
    borderRadius: radius,
    opacity,
    transform: `scale(${scale})`,
    transformOrigin: "center",
    willChange: "transform, opacity",
    ...overrides
  } });
}
function useInlineFontsInto(svgRef) {
  React.useEffect(() => {
    const svg = svgRef.current;
    const host = svg && svg.querySelector("foreignObject > div");
    if (!svg || !host) return;
    let cancelled = false;
    (async () => {
      const rules = [];
      for (const ss of document.styleSheets) {
        let cssRules;
        try {
          cssRules = ss.cssRules;
        } catch {
          if (ss.href) {
            try {
              const txt = await fetch(ss.href).then((r) => {
                if (!r.ok) throw 0;
                return r.text();
              });
              for (const ff of txt.match(/@font-face\s*{[^}]*}/g) || [])
                rules.push({ css: ff, base: ss.href });
            } catch {
            }
          }
          continue;
        }
        if (!cssRules) continue;
        for (const r of cssRules) {
          if (r.type === CSSRule.FONT_FACE_RULE) {
            rules.push({ css: r.cssText, base: ss.href || location.href });
          }
        }
      }
      const toDataURL = (url) => fetch(url).then((r) => {
        if (!r.ok) throw 0;
        return r.blob();
      }).then((b) => new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res(url);
        fr.readAsDataURL(b);
      })).catch(() => url);
      const parts = await Promise.all(rules.map(async ({ css, base }) => {
        const re = /url\((['"]?)([^'")]+)\1\)/g;
        let out = css, m;
        while (m = re.exec(css)) {
          const u = m[2];
          if (u.startsWith("data:")) continue;
          let abs;
          try {
            abs = new URL(u, base).href;
          } catch {
            continue;
          }
          out = out.split(m[0]).join(`url("${await toDataURL(abs)}")`);
        }
        return out;
      }));
      if (cancelled || !parts.length) {
        svg.setAttribute("data-om-fonts-inlined", "true");
        return;
      }
      const style = document.createElement("style");
      style.textContent = parts.join("\n");
      host.insertBefore(style, host.firstChild);
      svg.setAttribute("data-om-fonts-inlined", "true");
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
function Stage({
  width = 1280,
  height = 720,
  duration = 10,
  background = "#f6f4ef",
  fps = 60,
  loop = true,
  autoplay = true,
  // Parsed playback object ({mode:'loop'} | {mode:'times',count:N}) or
  // null. When present it overrides the legacy loop prop — SceneStage
  // passes the validated value from the OM_PLAYBACK authoring contract.
  playback = null,
  persistKey = "animstage",
  children
}) {
  width = +width || 1280;
  height = +height || 720;
  duration = +duration || 10;
  fps = +fps || 60;
  if (typeof loop === "string") loop = loop !== "false";
  if (typeof autoplay === "string") autoplay = autoplay !== "false";
  const playTimes = playback && playback.mode === "times" ? playback.count : null;
  const loopEff = playback ? playback.mode === "loop" : loop;
  const [time, setTime] = React.useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(persistKey + ":t") || "0");
      return isFinite(v) ? clamp(v, 0, duration) : 0;
    } catch {
      return 0;
    }
  });
  const [playing, setPlaying] = React.useState(autoplay);
  const [extPlay, setExtPlay] = React.useState(false);
  const extPlayTimerRef = React.useRef(null);
  const [hoverTime, setHoverTime] = React.useState(null);
  const [scale, setScale] = React.useState(1);
  const stageRef = React.useRef(null);
  const canvasRef = React.useRef(null);
  const rafRef = React.useRef(null);
  const lastTsRef = React.useRef(null);
  React.useEffect(() => {
    try {
      localStorage.setItem(persistKey + ":t", String(time));
    } catch {
    }
  }, [time, persistKey]);
  React.useEffect(() => {
    if (!stageRef.current) return;
    const el = stageRef.current;
    const measure = () => {
      const barH = 44;
      const s = Math.min(
        el.clientWidth / width,
        (el.clientHeight - barH) / height
      );
      setScale(Math.max(0.05, s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [width, height]);
  const passesRef = React.useRef(0);
  React.useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }
    passesRef.current = 0;
    const step = (ts) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1e3;
      lastTsRef.current = ts;
      setTime((t) => {
        let next = t + dt;
        if (next >= duration) {
          if (playTimes !== null) {
            passesRef.current += 1;
            if (passesRef.current >= playTimes) {
              next = duration;
              setPlaying(false);
            } else {
              next = next % duration;
            }
          } else if (loopEff) {
            next = next % duration;
          } else {
            next = duration;
            setPlaying(false);
          }
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [playing, duration, loopEff, playTimes]);
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === "ArrowLeft") {
        setTime((t) => clamp(t - (e.shiftKey ? 1 : 0.1), 0, duration));
      } else if (e.code === "ArrowRight") {
        setTime((t) => clamp(t + (e.shiftKey ? 1 : 0.1), 0, duration));
      } else if (e.key === "0" || e.code === "Home") {
        setTime(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration]);
  React.useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const canSyncSeek = typeof ReactDOM !== "undefined" && typeof ReactDOM.flushSync === "function";
    const onSeek = (e) => {
      const apply = () => {
        setPlaying(false);
        const hostPlay = !!(e.detail && e.detail.playing === true);
        if (extPlayTimerRef.current) {
          clearTimeout(extPlayTimerRef.current);
          extPlayTimerRef.current = null;
        }
        if (hostPlay) {
          extPlayTimerRef.current = setTimeout(() => {
            extPlayTimerRef.current = null;
            setExtPlay(false);
          }, SS_EXT_PLAY_MS);
        }
        setExtPlay(hostPlay);
        setTime(clamp(e.detail.time, 0, duration));
      };
      if (canSyncSeek && e.detail && e.detail.sync === true) {
        ReactDOM.flushSync(apply);
      } else {
        apply();
      }
    };
    el.addEventListener("data-om-seek-to-time-frame", onSeek);
    if (canSyncSeek) el.setAttribute("data-om-sync-seek", "true");
    return () => {
      el.removeEventListener("data-om-seek-to-time-frame", onSeek);
      el.removeAttribute("data-om-sync-seek");
      if (extPlayTimerRef.current) {
        clearTimeout(extPlayTimerRef.current);
        extPlayTimerRef.current = null;
      }
      setExtPlay(false);
    };
  }, [duration]);
  useInlineFontsInto(canvasRef);
  const displayTime = hoverTime != null ? hoverTime : time;
  const ctxValue = React.useMemo(
    // extPlaying is ADDITIVE: "time is advancing under an external
    // driver's continuous playback". `playing` keeps meaning the
    // engine's OWN clock — the hidden PlaybackBar glyph (and through it
    // the host's clock-reporter/adoption channel) reads that — and
    // SceneSwitch is the one consumer that widens to either.
    () => ({
      time: displayTime,
      duration,
      playing,
      extPlaying: extPlay,
      setTime,
      setPlaying
    }),
    [displayTime, duration, playing, extPlay]
  );
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      ref: stageRef,
      style: {
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "#0a0a0a",
        fontFamily: "Inter, system-ui, sans-serif"
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: {
      flex: 1,
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      minHeight: 0
    } }, /* @__PURE__ */ React.createElement(
      "svg",
      {
        ref: canvasRef,
        width,
        height,
        "data-om-exportable-video-with-duration-secs": duration,
        style: {
          transform: `scale(${scale})`,
          transformOrigin: "center",
          flexShrink: 0,
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          display: "block"
        }
      },
      /* @__PURE__ */ React.createElement("foreignObject", { x: "0", y: "0", width: "100%", height: "100%" }, /* @__PURE__ */ React.createElement(
        "div",
        {
          xmlns: "http://www.w3.org/1999/xhtml",
          style: {
            width,
            height,
            background,
            position: "relative",
            overflow: "hidden"
          }
        },
        /* @__PURE__ */ React.createElement(TimelineContext.Provider, { value: ctxValue }, children)
      ))
    )),
    /* @__PURE__ */ React.createElement(
      PlaybackBar,
      {
        time: displayTime,
        actualTime: time,
        duration,
        playing,
        onPlayPause: () => setPlaying((p) => !p),
        onReset: () => {
          setTime(0);
        },
        onSeek: (t) => setTime(t),
        onHover: (t) => setHoverTime(t)
      }
    )
  );
}
function PlaybackBar({ time, duration, playing, onPlayPause, onReset, onSeek, onHover }) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  const timeFromEvent = React.useCallback((e) => {
    const rect = trackRef.current.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    return x * duration;
  }, [duration]);
  const onTrackMove = (e) => {
    if (!trackRef.current) return;
    const t = timeFromEvent(e);
    if (dragging) {
      onSeek(t);
    } else {
      onHover(t);
    }
  };
  const onTrackLeave = () => {
    if (!dragging) onHover(null);
  };
  const onTrackDown = (e) => {
    setDragging(true);
    const t = timeFromEvent(e);
    onSeek(t);
    onHover(null);
  };
  React.useEffect(() => {
    if (!dragging) return;
    const onUp = () => setDragging(false);
    const onMove = (e) => {
      if (!trackRef.current) return;
      const t = timeFromEvent(e);
      onSeek(t);
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
    };
  }, [dragging, timeFromEvent, onSeek]);
  const pct = duration > 0 ? time / duration * 100 : 0;
  const fmt = (t) => {
    const total = Math.max(0, t);
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    const cs = Math.floor(total * 100 % 100);
    return `${String(m).padStart(1, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  };
  const mono = "JetBrains Mono, ui-monospace, SFMono-Regular, monospace";
  return /* @__PURE__ */ React.createElement("div", { "data-omelette-chrome": true, style: {
    // Slimmed to visually match the host editor bar's basic row (the
    // single-scrubber look): transport first, tighter metrics, quieter
    // chrome. Shown only outside the app — the host bar suppresses this
    // whenever it is present.
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 12px",
    background: "rgba(20,20,20,0.92)",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    borderRadius: 6,
    color: "#f6f4ef",
    fontFamily: "Inter, system-ui, sans-serif",
    userSelect: "none",
    flexShrink: 0
  } }, /* @__PURE__ */ React.createElement(IconButton, { onClick: onPlayPause, title: "Play/pause (space)" }, playing ? /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "2", width: "3", height: "10", fill: "currentColor" }), /* @__PURE__ */ React.createElement("rect", { x: "8", y: "2", width: "3", height: "10", fill: "currentColor" })) : /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none" }, /* @__PURE__ */ React.createElement("path", { d: "M3 2l9 5-9 5V2z", fill: "currentColor" }))), /* @__PURE__ */ React.createElement(IconButton, { onClick: onReset, title: "Return to start (0)" }, /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none" }, /* @__PURE__ */ React.createElement("path", { d: "M3 2v10M12 2L5 7l7 5V2z", stroke: "currentColor", strokeWidth: "1.5", strokeLinejoin: "round", strokeLinecap: "round" }))), /* @__PURE__ */ React.createElement("div", { style: {
    fontFamily: mono,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    width: 64,
    textAlign: "right",
    color: "#f6f4ef"
  } }, fmt(time)), /* @__PURE__ */ React.createElement(
    "div",
    {
      ref: trackRef,
      onMouseMove: onTrackMove,
      onMouseLeave: onTrackLeave,
      onMouseDown: onTrackDown,
      style: {
        flex: 1,
        height: 22,
        position: "relative",
        cursor: "pointer",
        display: "flex",
        alignItems: "center"
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: {
      position: "absolute",
      left: 0,
      right: 0,
      height: 4,
      background: "rgba(255,255,255,0.12)",
      borderRadius: 2
    } }),
    /* @__PURE__ */ React.createElement("div", { style: {
      position: "absolute",
      left: 0,
      width: `${pct}%`,
      height: 4,
      background: "oklch(72% 0.12 250)",
      borderRadius: 2
    } }),
    /* @__PURE__ */ React.createElement("div", { style: {
      position: "absolute",
      left: `${pct}%`,
      top: "50%",
      width: 12,
      height: 12,
      marginLeft: -6,
      marginTop: -6,
      background: "#fff",
      borderRadius: 6,
      boxShadow: "0 2px 4px rgba(0,0,0,0.4)"
    } })
  ), /* @__PURE__ */ React.createElement("div", { style: {
    fontFamily: mono,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    width: 64,
    textAlign: "left",
    color: "rgba(246,244,239,0.55)"
  } }, fmt(duration)), typeof VideoEncoder !== "undefined" && /* @__PURE__ */ React.createElement(
    IconButton,
    {
      title: "Export video",
      onClick: () => window.parent.postMessage({ type: "omelette:request-video-export" }, "*")
    },
    /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none" }, /* @__PURE__ */ React.createElement("path", { d: "M7 2v7m0 0L4 6m3 3l3-3M2 12h10", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }))
  ));
}
function IconButton({ children, onClick, title }) {
  const [hover, setHover] = React.useState(false);
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick,
      title,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 5,
        color: "#f6f4ef",
        cursor: "pointer",
        padding: 0,
        transition: "background 120ms"
      }
    },
    children
  );
}
function VideoSprite({ src, start = 0, end, speed = 1, style, ...rest }) {
  start = +start || 0;
  speed = +speed || 1;
  if (end != null) end = +end || void 0;
  const t = useTime();
  const ref = React.useRef(null);
  const span = Math.max(1e-3, (end ?? start + 1) - start);
  React.useEffect(() => {
    const v = ref.current;
    if (!v || v.readyState < 1) return;
    const target = start + t * speed % span;
    if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
  }, [t, start, span, speed]);
  return /* @__PURE__ */ React.createElement(
    "video",
    {
      ref,
      src,
      muted: true,
      playsInline: true,
      preload: "auto",
      "data-om-exportable-video-play-start": start,
      "data-om-exportable-video-play-end": end ?? start + span,
      "data-om-exportable-video-play-speed": speed,
      style: { display: "block", objectFit: "cover", ...style },
      ...rest
    }
  );
}
Object.assign(window, {
  Easing,
  interpolate,
  animate,
  clamp,
  TimelineContext,
  useTime,
  useTimeline,
  Sprite,
  SpriteContext,
  useSprite,
  TextSprite,
  ImageSprite,
  RectSprite,
  VideoSprite,
  Stage,
  PlaybackBar
});
function ssParse(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 16 * 1024) return null;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) return null;
  for (var i = 0; i < parsed.length; i++) {
    var s = parsed[i];
    if (typeof s !== "object" || s === null) return null;
    if (typeof s.name !== "string" || typeof s.dur !== "number") return null;
    if (!isFinite(s.dur) || s.dur <= 0 || s.dur > 300) return null;
  }
  return parsed;
}
function ppParse(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 256) return null;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  var keys = Object.keys(parsed);
  if (parsed.mode === "loop") return keys.length === 1 ? { mode: "loop" } : null;
  if (parsed.mode === "times") {
    if (keys.length !== 2) return null;
    var c = parsed.count;
    if (typeof c !== "number" || c !== Math.floor(c) || c < 1 || c > 99) return null;
    return { mode: "times", count: c };
  }
  return null;
}
function PlaybackSync(props) {
  var ref = React.useRef(null);
  var raw = props.raw;
  var onUpdate = props.onUpdate;
  React.useEffect(function() {
    var el = ref.current;
    if (!el) return;
    var root = el.closest("[data-om-exportable-video-with-duration-secs]");
    if (!root) return;
    root.setAttribute("data-om-timeline-playback", raw);
    var onEvent = function(e) {
      var next = e && e.detail;
      if (ppParse(next)) onUpdate(next);
    };
    root.addEventListener("data-om-timeline-playback-update", onEvent);
    return function() {
      root.removeEventListener("data-om-timeline-playback-update", onEvent);
      root.removeAttribute("data-om-timeline-playback");
    };
  }, [raw, onUpdate]);
  return /* @__PURE__ */ React.createElement("div", { ref, style: { display: "none" } });
}
var SceneContext = React.createContext(null);
function useScene() {
  return React.useContext(SceneContext);
}
function SceneSync(props) {
  var ref = React.useRef(null);
  var raw = props.raw;
  var onUpdate = props.onUpdate;
  React.useEffect(function() {
    var el = ref.current;
    if (!el) return;
    var root = el.closest("[data-om-exportable-video-with-duration-secs]");
    if (!root) return;
    root.setAttribute("data-om-timeline-scenes", raw);
    var onEvent = function(e) {
      var next = e && e.detail;
      if (ssParse(next)) onUpdate(next);
    };
    root.addEventListener("data-om-timeline-scenes-update", onEvent);
    return function() {
      root.removeEventListener("data-om-timeline-scenes-update", onEvent);
      root.removeAttribute("data-om-timeline-scenes");
    };
  }, [raw, onUpdate]);
  return /* @__PURE__ */ React.createElement("div", { ref, style: { display: "none" } });
}
var SS_MAX_TICK = 0.5;
var SS_OVERLAP_TICKS = 2;
var SS_OVERLAP_MAX_MS = 500;
var SS_EXT_PLAY_MS = 400;
function ssNaturalAdvance(last, idx, t, count, total, playing, loopOn) {
  if (!playing || count < 2) return false;
  if (idx === last.idx + 1) {
    var dt = t - last.t;
    return dt > 0 && dt <= SS_MAX_TICK;
  }
  if (last.idx === count - 1 && idx === 0 && loopOn && t > 0) {
    var dtWrap = t + total - last.t;
    return dtWrap > 0 && dtWrap <= SS_MAX_TICK && t <= SS_MAX_TICK;
  }
  return false;
}
function ssSceneInner(scenes, idx, wallTime, total, map, timelineValue) {
  var scene = scenes[idx];
  var nat = typeof scene.nat === "number" && isFinite(scene.nat) && scene.nat > 0 ? scene.nat : scene.dur;
  var stretch = scene.dur > 0 ? nat / scene.dur : 1;
  var localTime = wallTime * stretch;
  var ctx = {
    scene,
    localTime,
    progress: nat > 0 ? localTime / nat : 0,
    dur: nat,
    index: idx,
    count: scenes.length,
    total
  };
  var Comp = Object.prototype.hasOwnProperty.call(map, scene.name) ? map[scene.name] : null;
  return /* @__PURE__ */ React.createElement(TimelineContext.Provider, { value: timelineValue }, /* @__PURE__ */ React.createElement(SceneContext.Provider, { value: ctx }, Comp ? /* @__PURE__ */ React.createElement(Comp, { ...ctx }) : (
    // An unmapped name renders a quiet diagnostic instead of a dead
    // frame — the mismatch is an authoring bug worth seeing.
    /* @__PURE__ */ React.createElement("div", { style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "rgba(255,255,255,0.25)",
      font: "500 18px Inter, system-ui, sans-serif"
    } }, "unmapped scene: ", scene.name)
  )));
}
function ssSceneLayer(idx, z, frozen, inner) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      key: idx,
      "data-om-scene-layer": idx,
      style: {
        position: "absolute",
        inset: 0,
        zIndex: z,
        pointerEvents: frozen ? "none" : void 0
      }
    },
    inner
  );
}
function SceneSwitch(props) {
  var scenes = props.scenes;
  var map = props.map || {};
  var overlapMode = props.transition === "overlap";
  var timeline = useTimeline();
  var t = timeline.time;
  var playing = timeline.playing || timeline.extPlaying === true;
  var starts = [0];
  for (var i = 0; i < scenes.length; i++) starts.push(starts[i] + scenes[i].dur);
  var total = starts[starts.length - 1];
  var idx = scenes.length - 1;
  for (var j = 0; j < scenes.length; j++) {
    if (t < starts[j + 1]) {
      idx = j;
      break;
    }
  }
  var wallTime = Math.min(Math.max(t - starts[idx], 0), scenes[idx].dur);
  var inner = ssSceneInner(scenes, idx, wallTime, total, map, timeline);
  var lastRef = React.useRef(null);
  var overlayRef = React.useRef(null);
  if (overlapMode && lastRef.current) {
    var last = lastRef.current;
    if (last.idx !== idx) {
      overlayRef.current = ssNaturalAdvance(last, idx, t, scenes.length, total, playing, props.loop === true) ? {
        fromIdx: last.idx,
        toIdx: idx,
        scenes,
        ticks: 0,
        bornAt: Date.now(),
        inner: last.inner
      } : null;
    } else if (overlayRef.current && last.t !== t) {
      overlayRef.current.ticks += 1;
    }
  }
  var ov = overlayRef.current;
  if (ov && (!overlapMode || !playing || idx !== ov.toIdx || scenes !== ov.scenes || ov.ticks >= SS_OVERLAP_TICKS || Date.now() - ov.bornAt > SS_OVERLAP_MAX_MS)) {
    overlayRef.current = ov = null;
  }
  lastRef.current = { idx, t, inner };
  var nudgeState = React.useState(0);
  var setNudge = nudgeState[1];
  React.useEffect(function() {
    if (!overlayRef.current) return void 0;
    var id = setTimeout(function() {
      setNudge(function(n) {
        return n + 1;
      });
    }, SS_OVERLAP_MAX_MS + 17);
    return function() {
      clearTimeout(id);
    };
  });
  if (!ov) return [ssSceneLayer(idx, void 0, false, inner)];
  return [
    ssSceneLayer(ov.fromIdx, 0, true, ov.inner),
    ssSceneLayer(idx, 1, false, inner)
  ];
}
function SceneStage(props) {
  var width = +props.width || 1280;
  var height = +props.height || 720;
  var bg = props.bg || "#0b0b0e";
  var autoplay = props.autoplay == null ? true : String(props.autoplay) !== "false";
  var loop = props.loop == null ? true : String(props.loop) !== "false";
  var transition = props.transition === "overlap" ? "overlap" : "cut";
  var state = React.useState(props.scenes);
  var raw = state[0];
  var setRaw = state[1];
  var scenes = React.useMemo(function() {
    return ssParse(raw);
  }, [raw]);
  var pstate = React.useState(props.playback);
  var praw = pstate[0];
  var setPraw = pstate[1];
  var pb = React.useMemo(function() {
    return ppParse(praw);
  }, [praw]);
  if (!scenes) {
    return /* @__PURE__ */ React.createElement("div", { style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#0b0b0e",
      color: "#c96442",
      font: "500 16px Inter, system-ui, sans-serif",
      textAlign: "center"
    } }, "animations-v2: the scenes prop isn't a valid JSON scene list", /* @__PURE__ */ React.createElement("br", null), "(expected '[", "{", '"name":"…","dur":N', "}", ", …]')");
  }
  var total = 0;
  for (var i = 0; i < scenes.length; i++) total += scenes[i].dur;
  total = Math.round(total * 1e3) / 1e3;
  var loopEff = pb ? pb.mode !== "times" || pb.count > 1 : loop;
  var inner = /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SceneSync, { raw, onUpdate: setRaw }), typeof praw === "string" && praw !== "" && /* @__PURE__ */ React.createElement(PlaybackSync, { raw: praw, onUpdate: setPraw }), /* @__PURE__ */ React.createElement(
    SceneSwitch,
    {
      scenes,
      map: props.children,
      transition,
      loop: loopEff
    }
  ));
  return /* @__PURE__ */ React.createElement(
    Stage,
    {
      width,
      height,
      duration: total,
      background: bg,
      autoplay,
      loop,
      playback: pb
    },
    inner
  );
}
Object.assign(window, { SceneStage, useScene });

})();

;(function(){
const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === "object" && keyOrEdits !== null ? keyOrEdits : { [keyOrEdits]: val };
    setValues((prev) => ({ ...prev, ...edits }));
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*");
    window.dispatchEvent(new CustomEvent("tweakchange", { detail: edits }));
  }, []);
  return [values, setTweak];
}
function TweaksPanel({ title = "Tweaks", children }) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({ x: 16, y: 16 });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + "px";
    panel.style.bottom = offsetRef.current.y + "px";
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", clampToViewport);
      return () => window.removeEventListener("resize", clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = (e) => {
      const t = e?.data?.type;
      if (t === "__activate_edit_mode") setOpen(true);
      else if (t === "__deactivate_edit_mode") setOpen(false);
    };
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({ type: "__edit_mode_dismissed" }, "*");
  };
  const onDragStart = (e) => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev) => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  if (!open) return null;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("style", null, __TWEAKS_STYLE), /* @__PURE__ */ React.createElement(
    "div",
    {
      ref: dragRef,
      className: "twk-panel",
      "data-omelette-chrome": "",
      style: { right: offsetRef.current.x, bottom: offsetRef.current.y }
    },
    /* @__PURE__ */ React.createElement("div", { className: "twk-hd", onMouseDown: onDragStart }, /* @__PURE__ */ React.createElement("b", null, title), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "twk-x",
        "aria-label": "Close tweaks",
        onMouseDown: (e) => e.stopPropagation(),
        onClick: dismiss
      },
      "✕"
    )),
    /* @__PURE__ */ React.createElement("div", { className: "twk-body" }, children)
  ));
}
function TweakSection({ label, children }) {
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "twk-sect" }, label), children);
}
function TweakRow({ label, value, children, inline = false }) {
  return /* @__PURE__ */ React.createElement("div", { className: inline ? "twk-row twk-row-h" : "twk-row" }, /* @__PURE__ */ React.createElement("div", { className: "twk-lbl" }, /* @__PURE__ */ React.createElement("span", null, label), value != null && /* @__PURE__ */ React.createElement("span", { className: "twk-val" }, value)), children);
}
function TweakSlider({ label, value, min = 0, max = 100, step = 1, unit = "", onChange }) {
  return /* @__PURE__ */ React.createElement(TweakRow, { label, value: `${value}${unit}` }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "range",
      className: "twk-slider",
      min,
      max,
      step,
      value,
      onChange: (e) => onChange(Number(e.target.value))
    }
  ));
}
function TweakToggle({ label, value, onChange }) {
  return /* @__PURE__ */ React.createElement("div", { className: "twk-row twk-row-h" }, /* @__PURE__ */ React.createElement("div", { className: "twk-lbl" }, /* @__PURE__ */ React.createElement("span", null, label)), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "twk-toggle",
      "data-on": value ? "1" : "0",
      role: "switch",
      "aria-checked": !!value,
      onClick: () => onChange(!value)
    },
    /* @__PURE__ */ React.createElement("i", null)
  ));
}
function TweakRadio({ label, value, options, onChange }) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const labelLen = (o) => String(typeof o === "object" ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({ 2: 16, 3: 10 }[options.length] ?? 0);
  if (!fitsAsSegments) {
    const resolve = (s) => {
      const m = options.find((o) => String(typeof o === "object" ? o.value : o) === s);
      return m === void 0 ? s : typeof m === "object" ? m.value : m;
    };
    return /* @__PURE__ */ React.createElement(
      TweakSelect,
      {
        label,
        value,
        options,
        onChange: (s) => onChange(resolve(s))
      }
    );
  }
  const opts = options.map((o) => typeof o === "object" ? o : { value: o, label: o });
  const idx = Math.max(0, opts.findIndex((o) => o.value === value));
  const n = opts.length;
  const segAt = (clientX) => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = (e) => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = (ev) => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return /* @__PURE__ */ React.createElement(TweakRow, { label }, /* @__PURE__ */ React.createElement(
    "div",
    {
      ref: trackRef,
      role: "radiogroup",
      onPointerDown,
      className: dragging ? "twk-seg dragging" : "twk-seg"
    },
    /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "twk-seg-thumb",
        style: {
          left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
          width: `calc((100% - 4px) / ${n})`
        }
      }
    ),
    opts.map((o) => /* @__PURE__ */ React.createElement("button", { key: o.value, type: "button", role: "radio", "aria-checked": o.value === value }, o.label))
  ));
}
function TweakSelect({ label, value, options, onChange }) {
  return /* @__PURE__ */ React.createElement(TweakRow, { label }, /* @__PURE__ */ React.createElement("select", { className: "twk-field", value, onChange: (e) => onChange(e.target.value) }, options.map((o) => {
    const v = typeof o === "object" ? o.value : o;
    const l = typeof o === "object" ? o.label : o;
    return /* @__PURE__ */ React.createElement("option", { key: v, value: v }, l);
  })));
}
function TweakText({ label, value, placeholder, onChange }) {
  return /* @__PURE__ */ React.createElement(TweakRow, { label }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "twk-field",
      type: "text",
      value,
      placeholder,
      onChange: (e) => onChange(e.target.value)
    }
  ));
}
function TweakNumber({ label, value, min, max, step = 1, unit = "", onChange }) {
  const clamp = (n) => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({ x: 0, val: 0 });
  const onScrubStart = (e) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, val: value };
    const decimals = (String(step).split(".")[1] || "").length;
    const move = (ev) => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return /* @__PURE__ */ React.createElement("div", { className: "twk-num" }, /* @__PURE__ */ React.createElement("span", { className: "twk-num-lbl", onPointerDown: onScrubStart }, label), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      value,
      min,
      max,
      step,
      onChange: (e) => onChange(clamp(Number(e.target.value)))
    }
  ), unit && /* @__PURE__ */ React.createElement("span", { className: "twk-num-unit" }, unit));
}
function __twkIsLight(hex) {
  const h = String(hex).replace("#", "");
  const x = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, "0");
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148e3;
}
const __TwkCheck = ({ light }) => /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 14 14", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement(
  "path",
  {
    d: "M3 7.2 5.8 10 11 4.2",
    fill: "none",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    stroke: light ? "rgba(0,0,0,.78)" : "#fff"
  }
));
function TweakColor({ label, value, options, onChange }) {
  if (!options || !options.length) {
    return /* @__PURE__ */ React.createElement("div", { className: "twk-row twk-row-h" }, /* @__PURE__ */ React.createElement("div", { className: "twk-lbl" }, /* @__PURE__ */ React.createElement("span", null, label)), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "color",
        className: "twk-swatch",
        value,
        onChange: (e) => onChange(e.target.value)
      }
    ));
  }
  const key = (o) => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /* @__PURE__ */ React.createElement(TweakRow, { label }, /* @__PURE__ */ React.createElement("div", { className: "twk-chips", role: "radiogroup" }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /* @__PURE__ */ React.createElement(
      "button",
      {
        key: i,
        type: "button",
        className: "twk-chip",
        role: "radio",
        "aria-checked": on,
        "data-on": on ? "1" : "0",
        "aria-label": colors.join(", "),
        title: colors.join(" · "),
        style: { background: hero },
        onClick: () => onChange(o)
      },
      sup.length > 0 && /* @__PURE__ */ React.createElement("span", null, sup.map((c, j) => /* @__PURE__ */ React.createElement("i", { key: j, style: { background: c } }))),
      on && /* @__PURE__ */ React.createElement(__TwkCheck, { light: __twkIsLight(hero) })
    );
  })));
}
function TweakButton({ label, onClick, secondary = false }) {
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: secondary ? "twk-btn secondary" : "twk-btn",
      onClick
    },
    label
  );
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});

})();

;(function(){
const { useRef, useState, useEffect } = React;
const { interpolate, Easing, useScene } = window;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
function seg(p, a, b, ease = Easing.easeInOutCubic) {
  return ease(clamp01((p - a) / (b - a)));
}
const TOKENS = {
  bg: "#080B0A",
  bg2: "#0B0F0E",
  surface: "#101514",
  surface2: "#161D1B",
  border: "rgba(255,255,255,.08)",
  border2: "rgba(255,255,255,.14)",
  tx: "#EAEFED",
  tx2: "#9BA5A1",
  tx3: "#69736E",
  accent: "#10E0A0",
  accent2: "#0FBE88",
  accentSoft: "rgba(16,224,160,.12)",
  accentInk: "#04130D",
  danger: "#F2706B",
  warning: "#F5B33D",
  red: "#FF4D4D",
  sans: "'Manrope',system-ui,-apple-system,sans-serif",
  mono: "'JetBrains Mono',monospace"
};
const T = TOKENS;
function Logo({ size = 40 }) {
  return /* @__PURE__ */ React.createElement("svg", { width: size, height: size * 290 / 283, viewBox: "0 0 283 290", fill: "none" }, /* @__PURE__ */ React.createElement("path", { d: "M180 11.6296C182 10.6295 193 -1.37044 224 0.129555C248.8 1.32956 267.333 22.2962 273.5 32.6296C289 59.6295 278 88.1296 277.5 90.1296C277.5 92 192 245.13 185 260.13C175.5 277.129 163.404 283.129 156 284.5C154 284.87 145.5 286.5 135 284.5C119.5 280.5 109 271 101.5 251L2 33.1296H37C55.8 33.9296 67.8333 48.1296 71.5 55.1296L137 192.63C146.6 215.429 161 220.13 166.5 220.13H166.672C171.787 220.131 182.708 220.135 189 214.63C197 207.63 202 201 203.5 188C205 175 190 148.63 185 141.63C163 105.13 158 97.6293 154.5 82.6296C151 67.6299 152.5 59.1296 153 53.6296C153.5 48.1296 156.5 40.6295 159.5 34.6296C162.5 28.6296 170.5 19.1295 180 11.6296ZM217 32.1296C198.775 32.1296 184 46.9042 184 65.1296C184 83.3548 198.775 98.1296 217 98.1296C235.225 98.1296 250 83.3548 250 65.1296C250 46.9042 235.225 32.1296 217 32.1296Z", fill: "url(#vg)" }), /* @__PURE__ */ React.createElement("defs", null, /* @__PURE__ */ React.createElement("linearGradient", { id: "vg", x1: "28", y1: "280", x2: "230", y2: "79", gradientUnits: "userSpaceOnUse" }, /* @__PURE__ */ React.createElement("stop", { stopColor: "#10E0A0" }), /* @__PURE__ */ React.createElement("stop", { offset: "1", stopColor: "#047857" }))));
}
const PATHS = {
  dashboard: ["rect:3,3,7,9,1", "rect:14,3,7,5,1", "rect:14,12,7,9,1", "rect:3,16,7,5,1"],
  map: ["M14.1 5.55a2 2 0 0 0 1.8 0l3.65-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.55 2.27a2 2 0 0 1-1.8 0l-4.2-2.1a2 2 0 0 0-1.8 0L4.4 20.4A1 1 0 0 1 3 19.4V6.6a1 1 0 0 1 .55-.9L8.1 3.44a2 2 0 0 1 1.8 0z", "M15 5.76v15", "M9 3.24v15"],
  truck: ["M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2", "M15 18H9", "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.5 8H14", "circle:17,18,2", "circle:7,18,2"],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  alarm: ["circle:12,13,8", "M12 9v4l2 2", "M5 3 2 6", "m22 6-3-3", "M6.38 18.7 4 21", "M17.64 18.67 20 21"],
  report: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M8 18v-2", "M12 18v-5", "M16 18v-8"],
  gauge: ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"],
  calendar: ["M8 2v4", "M16 2v4", "rect:3,4,18,18,2", "M3 10h18"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "circle:9,7,4", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  sim: ["rect:2,5,20,14,2", "M2 10h20"],
  clipboard: ["rect:8,2,8,4,1", "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M12 11h4", "M12 16h4", "M8 11h.01", "M8 16h.01"],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  navigation: ["polygon:3,11 22,2 13,21 11,13 3,11"],
  alert: ["M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z", "M12 9v4", "M12 17h.01"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  plus: ["M5 12h14", "M12 5v14"],
  chevron: ["m9 18 6-6-6-6"],
  search: ["circle:11,11,8", "m21 21-4.3-4.3"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  power: ["M12 2v10", "M18.4 6.6a9 9 0 1 1-12.77.04"],
  clock: ["circle:12,12,10", "polyline:12,6 12,12 16,14"],
  route: ["circle:6,19,3", "M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15", "circle:18,5,3"],
  fuel: ["M3 22h12", "M4 9h10", "M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18", "M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.42L18 5"],
  sparkles: ["M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"],
  lock: ["rect:3,11,18,11,2", "M7 11V7a5 5 0 0 1 10 0v4"],
  eye: ["M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z", "circle:12,12,3"],
  settings: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "circle:12,12,3"],
  film: ["rect:3,3,18,18,2", "M7 3v18", "M3 7.5h4", "M3 12h18", "M3 16.5h4", "M17 3v18", "M17 7.5h4", "M17 16.5h4"],
  filter: ["polygon:22,3 2,3 10,12.46 10,19 14,21 14,12.46 22,3"],
  incident: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z", "M12 9v4", "M12 17h.01"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "polyline:7,10 12,15 17,10", "M12 15V3"],
  pin: ["M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z", "circle:12,10,3"],
  play: ["polygon:6,3 20,12 6,21 6,3"],
  arrow: ["M5 12h14", "m12 5 7 7-7 7"],
  chat: ["M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"],
  globe: ["circle:12,12,10", "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
  mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 19v3"],
  hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"],
  euro: ["M4 10h12", "M4 14h9", "M19 6.5A7 7 0 1 0 19 17.5"],
  layers: ["polygon:12,2 2,7 12,12 22,7 12,2", "polyline:2,17 12,22 22,17", "polyline:2,12 12,17 22,12"],
  trendDown: ["M22 17 13.5 8.5 8.5 13.5 2 7", "polyline:16,17 22,17 22,11"],
  mail: ["rect:2,4,20,16,2", "m22 6-10 7L2 6"]
};
function Icon({ name, size = 20, color = "currentColor", sw = 1.9 }) {
  const items = PATHS[name] || [];
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: sw,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      style: { display: "block", flex: "none" }
    },
    items.map((d, i) => {
      if (d.startsWith("rect:")) {
        const [x, y, w, h, r] = d.slice(5).split(",").map(Number);
        return /* @__PURE__ */ React.createElement("rect", { key: i, x, y, width: w, height: h, rx: r || 0 });
      }
      if (d.startsWith("circle:")) {
        const [cx, cy, r] = d.slice(7).split(",").map(Number);
        return /* @__PURE__ */ React.createElement("circle", { key: i, cx, cy, r });
      }
      if (d.startsWith("polygon:")) return /* @__PURE__ */ React.createElement("polygon", { key: i, points: d.slice(8) });
      if (d.startsWith("polyline:")) return /* @__PURE__ */ React.createElement("polyline", { key: i, points: d.slice(9) });
      return /* @__PURE__ */ React.createElement("path", { key: i, d });
    })
  );
}
function Eyebrow({ children, color = T.accent }) {
  return /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, fontSize: 15, fontWeight: 600, letterSpacing: ".18em", textTransform: "uppercase", color } }, children);
}
const NAV = {
  Supervision: [
    { label: "Tableau de bord", icon: "dashboard" },
    { label: "Carte", icon: "map" },
    { label: "Véhicules", icon: "truck" },
    { label: "Géofences", icon: "pin" },
    { label: "Alertes", icon: "bell" },
    { label: "Surveillance audio", icon: "mic" },
    { label: "Horaires flotte", icon: "alarm" }
  ],
  Analyse: [
    { label: "Rapports", icon: "report" },
    { label: "Scores de conduite", icon: "gauge" },
    { label: "Économies", icon: "euro" },
    { label: "Agenda", icon: "calendar" }
  ],
  Administration: [
    { label: "Utilisateurs", icon: "users" },
    { label: "Groupes", icon: "layers" },
    { label: "Conducteurs", icon: "hash" },
    { label: "Cartes SIM", icon: "sim" },
    { label: "Installation", icon: "clipboard" },
    { label: "Activité flotte", icon: "activity" }
  ]
};
function Sidebar({ active, w = 300 }) {
  return /* @__PURE__ */ React.createElement("div", { style: { width: w, flex: "none", height: "100%", background: T.bg2, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", fontFamily: T.sans } }, /* @__PURE__ */ React.createElement("div", { style: { height: 84, display: "flex", alignItems: "center", gap: 12, padding: "0 24px", borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement(Logo, { size: 30 }), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 22, color: T.tx, letterSpacing: "-.01em" } }, "Tracky"), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", flexDirection: "column", gap: 4 } }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("span", { key: i, style: { width: 18, height: 2, background: T.tx3, borderRadius: 2 } })))), /* @__PURE__ */ React.createElement("div", { style: { padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" } }, Object.entries(NAV).map(([section, items]) => /* @__PURE__ */ React.createElement("div", { key: section, style: { marginTop: section === "Supervision" ? 4 : 18 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, fontSize: 12, fontWeight: 600, letterSpacing: ".16em", textTransform: "uppercase", color: T.tx3, padding: "0 12px 10px" } }, section), items.map((it) => {
    const on = it.label === active;
    return /* @__PURE__ */ React.createElement("div", { key: it.label, style: { display: "flex", alignItems: "center", gap: 14, padding: "11px 12px", borderRadius: 11, marginBottom: 2, background: on ? T.accentSoft : "transparent", color: on ? T.accent : T.tx2, fontWeight: on ? 700 : 500, fontSize: 16.5 } }, /* @__PURE__ */ React.createElement(Icon, { name: it.icon, size: 21, sw: 1.8 }), /* @__PURE__ */ React.createElement("span", { style: { whiteSpace: "nowrap" } }, it.label));
  })))));
}
function TopBar({ title }) {
  return /* @__PURE__ */ React.createElement("div", { style: { height: 72, flex: "none", background: T.bg2, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", padding: "0 28px", gap: 18, fontFamily: T.sans } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 20, fontWeight: 700, color: T.tx } }, title), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 } }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, color: T.tx2, fontWeight: 600 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 8, height: 8, borderRadius: 99, background: T.accent, boxShadow: `0 0 0 3px ${T.accentSoft}` } }), " Connecté"), /* @__PURE__ */ React.createElement("div", { style: { width: 40, height: 40, borderRadius: 12, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.tx2 } }, /* @__PURE__ */ React.createElement(Icon, { name: "bell", size: 19 })), /* @__PURE__ */ React.createElement("div", { style: { width: 42, height: 42, borderRadius: 99, background: "linear-gradient(135deg,#10e0a0,#047857)", display: "flex", alignItems: "center", justifyContent: "center", color: T.accentInk, fontWeight: 800, fontSize: 15 } }, "JD")));
}
function AppFrame({ active, title, children, w = 1920, h = 1080 }) {
  return /* @__PURE__ */ React.createElement("div", { style: { width: w, height: h, background: T.bg, display: "flex", overflow: "hidden", fontFamily: T.sans, color: T.tx } }, /* @__PURE__ */ React.createElement(Sidebar, { active }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } }, /* @__PURE__ */ React.createElement(TopBar, { title }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden" } }, children)));
}
function Card({ children, style }) {
  return /* @__PURE__ */ React.createElement("div", { style: { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, ...style } }, children);
}
function Chip({ icon, children, on }) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 9, padding: "11px 18px", borderRadius: 12, border: `1px solid ${on ? "rgba(16,224,160,.35)" : T.border}`, background: on ? T.accentSoft : T.surface, color: on ? T.accent : T.tx2, fontWeight: 600, fontSize: 16 } }, icon && /* @__PURE__ */ React.createElement(Icon, { name: icon, size: 18 }), children);
}
function KPI({ icon, value, label, tone }) {
  const c = tone === "danger" ? T.danger : tone === "muted" ? T.tx2 : T.accent;
  return /* @__PURE__ */ React.createElement(Card, { style: { padding: "22px 24px", display: "flex", alignItems: "center", gap: 18 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 52, height: 52, borderRadius: 14, background: tone === "danger" ? "rgba(242,112,107,.12)" : T.accentSoft, color: c, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: icon, size: 26 })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3 } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 34, fontWeight: 800, letterSpacing: "-.02em", color: tone === "danger" ? T.danger : T.tx, whiteSpace: "nowrap" } }, value), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 15, color: T.tx2, fontWeight: 500 } }, label)));
}
function Toggle({ on }) {
  return /* @__PURE__ */ React.createElement("div", { style: { width: 46, height: 26, borderRadius: 99, padding: 3, background: on ? T.accentSoft : "rgba(242,112,107,.15)", border: `1.5px solid ${on ? "rgba(16,224,160,.3)" : "rgba(242,112,107,.25)"}`, display: "flex", justifyContent: on ? "flex-end" : "flex-start", alignItems: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 18, height: 18, borderRadius: 99, background: on ? T.accent : T.danger, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10, fontWeight: 800 } }, on ? "✓" : "✕"));
}
function Badge({ children, tone = "accent" }) {
  const map = { accent: [T.accentSoft, T.accent], danger: ["rgba(242,112,107,.14)", T.danger], warning: ["rgba(245,179,61,.14)", T.warning], muted: ["rgba(155,165,161,.14)", T.tx2] };
  const [bg, c] = map[tone];
  return /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 99, fontSize: 13, fontWeight: 700, background: bg, color: c } }, children);
}
function Marker({ x, y, color = T.accent, plate, active, heading = 0, drift = [0, 0], pulse = 0 }) {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: x, top: y, transform: `translate(-50%,-50%) translate(${drift[0]}px, ${drift[1]}px)`, width: 52, height: 52 } }, active && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 6, borderRadius: 99, background: color, opacity: 0.18 + 0.22 * pulse, transform: `scale(${1 + pulse * 0.6})` } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 4, borderRadius: 99, border: "2px solid rgba(255,255,255,.4)", transform: `rotate(${heading}deg)` } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: -7, left: "50%", transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderBottom: `9px solid ${color}` } })), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 12, borderRadius: 99, background: color, border: "2px solid #fff", boxShadow: "0 2px 8px rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", color: "#04130D" } }, /* @__PURE__ */ React.createElement(Icon, { name: "truck", size: 14, sw: 2.2 })), plate && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: 5, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "2px 8px", fontFamily: T.mono, fontSize: 11, fontWeight: 600, color: T.tx, whiteSpace: "nowrap" } }, plate));
}
function MapView({ children, style }) {
  const roads = "rgba(255,255,255,.06)";
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: "radial-gradient(circle at 40% 30%, #0e1614, #080B0A 80%)", overflow: "hidden", ...style } }, /* @__PURE__ */ React.createElement("svg", { width: "100%", height: "100%", style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement("g", { stroke: roads, strokeWidth: "14", fill: "none", strokeLinecap: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M-50 260 L700 300 L1100 180 L1700 240" }), /* @__PURE__ */ React.createElement("path", { d: "M120 -50 L200 400 L160 900 L260 1200" }), /* @__PURE__ */ React.createElement("path", { d: "M-50 620 L500 660 L900 560 L1600 640" }), /* @__PURE__ */ React.createElement("path", { d: "M700 -50 L760 500 L680 1100" }), /* @__PURE__ */ React.createElement("path", { d: "M1200 -50 L1180 500 L1320 1100" }), /* @__PURE__ */ React.createElement("path", { d: "M-50 960 L600 1000 L1200 900 L1700 980" })), /* @__PURE__ */ React.createElement("g", { stroke: "rgba(255,255,255,.03)", strokeWidth: "6", fill: "none" }, /* @__PURE__ */ React.createElement("path", { d: "M-50 430 L1700 470" }), /* @__PURE__ */ React.createElement("path", { d: "M-50 800 L1700 820" }), /* @__PURE__ */ React.createElement("path", { d: "M420 -50 L440 1100" }), /* @__PURE__ */ React.createElement("path", { d: "M980 -50 L960 1100" }))), children);
}
function Cursor({ x, y, click = 0 }) {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: x, top: y, zIndex: 50, transform: `scale(${1 - click * 0.15})`, transition: "none", pointerEvents: "none" } }, click > 0 && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 0, top: 0, width: 44, height: 44, marginLeft: -14, marginTop: -12, borderRadius: 99, border: `2px solid ${T.accent}`, opacity: click, transform: `scale(${0.4 + click})` } }), /* @__PURE__ */ React.createElement("svg", { width: "30", height: "30", viewBox: "0 0 24 24", style: { filter: "drop-shadow(0 2px 4px rgba(0,0,0,.5))" } }, /* @__PURE__ */ React.createElement("path", { d: "M4 2 L4 20 L9 15 L12.5 22 L15 21 L11.5 14 L18 14 Z", fill: "#fff", stroke: "#0A1311", strokeWidth: "1.3", strokeLinejoin: "round" })));
}
function RedBox({ x, y, w, h, progress = 1, label, labelPos = "right" }) {
  const draw = clamp01(progress);
  const per = 2 * (w + h);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: x, top: y, width: w, height: h, pointerEvents: "none", zIndex: 40 } }, /* @__PURE__ */ React.createElement("svg", { width: w, height: h, style: { position: "absolute", inset: 0, overflow: "visible" } }, /* @__PURE__ */ React.createElement(
    "rect",
    {
      x: "2",
      y: "2",
      width: w - 4,
      height: h - 4,
      rx: "12",
      fill: "rgba(255,77,77,.06)",
      stroke: T.red,
      strokeWidth: "3.5",
      strokeDasharray: per,
      strokeDashoffset: per * (1 - draw),
      style: { filter: "drop-shadow(0 0 10px rgba(255,77,77,.5))" }
    }
  )), label && draw > 0.9 && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", ...labelPos === "right" ? { left: w + 16, top: h / 2, transform: "translateY(-50%)" } : { left: "50%", top: -46, transform: "translateX(-50%)" }, background: T.red, color: "#fff", fontWeight: 800, fontSize: 15, padding: "7px 14px", borderRadius: 9, whiteSpace: "nowrap", boxShadow: "0 6px 18px rgba(255,77,77,.4)" } }, label));
}
function Callout({ index, total, icon, title, desc, p, corner = "bl" }) {
  const inn = clamp01(seg(p, 0.02, 0.16, Easing.easeOutBack));
  const out = 1 - seg(p, 0.9, 1, Easing.easeInCubic);
  const o = inn * out;
  const POS = {
    bl: { left: 56, bottom: 56 },
    br: { right: 56, bottom: 56 },
    tl: { left: 56, top: 56 },
    tr: { right: 56, top: 56 },
    bc: { left: "50%", bottom: 56, marginLeft: -320 }
  };
  const pos = POS[corner] || POS.bl;
  const top = corner === "tl" || corner === "tr";
  const right = corner === "br" || corner === "tr";
  const dx = (right ? 1 : -1) * (1 - inn) * (corner === "bc" ? 0 : 46);
  const dy = (top ? -1 : 1) * (1 - inn) * (corner === "bc" ? 70 : 40);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", ...pos, maxWidth: 640, zIndex: 45, opacity: o, transform: `translate(${dx}px, ${dy}px)` } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: "26px 30px", background: "rgba(16,21,20,.92)", backdropFilter: "blur(10px)", boxShadow: "0 24px 60px rgba(0,0,0,.5)", borderColor: "rgba(16,224,160,.22)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 52, height: 52, borderRadius: 14, background: T.accentSoft, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${0.7 + inn * 0.3})` } }, /* @__PURE__ */ React.createElement(Icon, { name: icon, size: 27 })), total && /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, fontSize: 14, color: T.tx3, fontWeight: 600 } }, String(index).padStart(2, "0"), " / ", String(total).padStart(2, "0")), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", height: 3, width: 54, borderRadius: 3, background: "rgba(255,255,255,.08)", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { height: "100%", width: `${clamp01((p - 0.05) / 0.85) * 100}%`, background: T.accent } }))), /* @__PURE__ */ React.createElement("h3", { style: { margin: 0, fontSize: 34, fontWeight: 800, letterSpacing: "-.02em", color: T.tx, lineHeight: 1.1 } }, title), /* @__PURE__ */ React.createElement("p", { style: { margin: "12px 0 0", fontSize: 20, lineHeight: 1.5, color: T.tx2, textWrap: "pretty" } }, desc)));
}
function Camera({ scale = 1, ox = 50, oy = 50, children }) {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, transform: `scale(${scale})`, transformOrigin: `${ox}% ${oy}%`, willChange: "transform" } }, children);
}
window.TK = {
  T,
  TOKENS,
  clamp01,
  lerp,
  seg,
  Logo,
  Icon,
  Eyebrow,
  Sidebar,
  TopBar,
  AppFrame,
  NAV,
  Card,
  Chip,
  KPI,
  Toggle,
  Badge,
  Marker,
  MapView,
  Cursor,
  RedBox,
  Callout,
  Camera
};

})();

;(function(){
const { useRef, useState, useLayoutEffect } = React;
const { interpolate, Easing, useScene, SceneStage } = window;
const { useTweaks, TweaksPanel, TweakToggle, TweakSection } = window;
const TK = window.TK;
const { T, seg, lerp, clamp01, Logo, Icon, Eyebrow, AppFrame, Sidebar, NAV, Card, Chip, KPI, Toggle, Badge, Marker, MapView, Cursor, RedBox, Callout, Camera } = TK;
const W = 1920, H = 1080;
const PAD = { padding: 40, height: "100%", overflow: "hidden", boxSizing: "border-box" };
function DashboardScreen() {
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Vue d'ensemble"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "10px 0 4px", fontSize: 40, fontWeight: 800, letterSpacing: "-.02em", color: T.tx } }, "Votre flotte est active."), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, color: T.tx2, fontSize: 18 } }, "Suivi en temps réel de votre flotte"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 18, marginTop: 28 } }, /* @__PURE__ */ React.createElement(KPI, { icon: "truck", value: "24", label: "Véhicules" }), /* @__PURE__ */ React.createElement(KPI, { icon: "navigation", value: "11", label: "En mouvement" }), /* @__PURE__ */ React.createElement(KPI, { icon: "activity", value: "13", label: "À l'arrêt", tone: "muted" }), /* @__PURE__ */ React.createElement(KPI, { icon: "alert", value: "2", label: "Alertes critiques", tone: "danger" })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 12, marginTop: 20 } }, /* @__PURE__ */ React.createElement(Chip, { icon: "map" }, "Carte"), /* @__PURE__ */ React.createElement(Chip, { icon: "truck" }, "Véhicules"), /* @__PURE__ */ React.createElement(Chip, { icon: "report" }, "Rapports"), /* @__PURE__ */ React.createElement(Chip, { icon: "shield" }, "Géofences")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18, marginTop: 20, height: 420 } }, /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden", position: "relative" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 18, left: 20, zIndex: 2, display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 17, color: T.tx } }, /* @__PURE__ */ React.createElement(Icon, { name: "map", size: 18, color: T.accent }), "Carte temps réel"), /* @__PURE__ */ React.createElement(MapView, null, /* @__PURE__ */ React.createElement(Marker, { x: "30%", y: "45%", plate: "AB-123-CD", active: true, heading: 40 }), /* @__PURE__ */ React.createElement(Marker, { x: "62%", y: "60%", plate: "EF-456-GH", heading: 200 }), /* @__PURE__ */ React.createElement(Marker, { x: "48%", y: "30%", plate: "IJ-789-KL", color: T.warning, heading: 120 })), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", bottom: 18, left: 20, background: "rgba(8,11,10,.7)", border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 14px", fontSize: 14, color: T.tx } }, /* @__PURE__ */ React.createElement("strong", { style: { color: T.accent } }, "11"), " actifs")), /* @__PURE__ */ React.createElement(Card, { style: { padding: 20 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 16, color: T.tx, marginBottom: 14 } }, /* @__PURE__ */ React.createElement(Icon, { name: "gauge", size: 17, color: T.accent }), "Activité en direct"), [["AB-123-CD", "68 km/h", "moving"], ["EF-456-GH", "0 km/h", "idle"], ["IJ-789-KL", "42 km/h", "moving"], ["MN-012-OP", "0 km/h", "idle"]].map(([p, s, st], i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: i < 3 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 9, height: 9, borderRadius: 99, background: st === "moving" ? T.accent : T.tx3 } }), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, fontSize: 15, color: T.tx, fontWeight: 600 } }, p), /* @__PURE__ */ React.createElement("span", { style: { marginLeft: "auto", color: st === "moving" ? T.accent : T.tx2, fontWeight: 700, fontSize: 15 } }, s))))));
}
function CarteScreen({ cine, filter, sync = 0, p = 0 }) {
  const markers = [
    { x: "28%", y: "40%", plate: "AB-123-CD", active: true, heading: 40 },
    { x: "58%", y: "58%", plate: "EF-456-GH", heading: 190 },
    { x: "44%", y: "26%", plate: "IJ-789-KL", color: T.warning, heading: 120 },
    { x: "72%", y: "38%", plate: "MN-012-OP", heading: 300 },
    { x: "36%", y: "70%", plate: "QR-345-ST", heading: 20 }
  ];
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement(MapView, null, markers.map((m, i) => {
    const rad = (m.heading - 90) * Math.PI / 180;
    const dist = (m.color ? 0 : 1) * (18 + i * 6) * p;
    return /* @__PURE__ */ React.createElement(Marker, { key: i, ...m, drift: [Math.cos(rad) * dist, Math.sin(rad) * dist], pulse: m.active ? Math.abs(Math.sin(p * Math.PI * 3)) : 0 });
  })), filter && /* @__PURE__ */ React.createElement(Card, { style: { position: "absolute", top: 24, left: 24, padding: 18, width: 260, background: "rgba(16,21,20,.94)", backdropFilter: "blur(8px)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15, color: T.tx, marginBottom: 14 } }, /* @__PURE__ */ React.createElement(Icon, { name: "filter", size: 16, color: T.accent }), "Filtres"), [["Groupe Livraison", true], ["Groupe Commercial", true], ["En mouvement", false], ["À l'arrêt", false]].map(([l, on], i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 14, color: T.tx2 } }, l), /* @__PURE__ */ React.createElement(Toggle, { on })))), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 24, right: 24, display: "flex", flexDirection: "column", gap: 10 } }, [cine ? "film" : "pin", "navigation", "plus"].map((ic, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { width: 48, height: 48, borderRadius: 12, background: i === 0 && cine ? T.accent : "rgba(16,21,20,.9)", border: `1px solid ${T.border}`, color: i === 0 && cine ? T.accentInk : T.tx2, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: ic, size: 20 })))), sync > 0 && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 24, left: "50%", transform: "translateX(-50%)", background: "rgba(16,21,20,.94)", border: `1px solid rgba(16,224,160,.3)`, borderRadius: 99, padding: "9px 18px", display: "flex", alignItems: "center", gap: 10, color: T.accent, fontWeight: 700, fontSize: 14, opacity: sync } }, /* @__PURE__ */ React.createElement("span", { style: { width: 9, height: 9, borderRadius: 99, background: T.accent } }), "GPS · synchro toutes les 20 s"), cine && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, boxShadow: "inset 0 0 0 4px rgba(16,224,160,.5)", pointerEvents: "none" } }));
}
function VehiculesScreen() {
  const rows = [["AB-123-CD", "Renault Master", "En route", "68 km/h", "accent"], ["EF-456-GH", "Peugeot Boxer", "À l'arrêt", "0 km/h", "muted"], ["IJ-789-KL", "Citroën Jumpy", "En route", "42 km/h", "accent"], ["MN-012-OP", "Ford Transit", "À l'arrêt", "0 km/h", "muted"], ["QR-345-ST", "Iveco Daily", "En route", "55 km/h", "accent"], ["UV-678-WX", "VW Crafter", "Hors ligne", ",", "danger"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", marginBottom: 22 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Eyebrow, null, "Parc"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Véhicules")), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", gap: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", border: `1px solid ${T.border}`, borderRadius: 12, color: T.tx3, width: 240 } }, /* @__PURE__ */ React.createElement(Icon, { name: "search", size: 17 }), "Rechercher…"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderRadius: 12, background: T.accent, color: T.accentInk, fontWeight: 700 } }, /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 17 }), "Ajouter"))), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr .5fr", padding: "16px 24px", fontSize: 13, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: T.tx3, borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement("span", null, "Plaque"), /* @__PURE__ */ React.createElement("span", null, "Modèle"), /* @__PURE__ */ React.createElement("span", null, "Statut"), /* @__PURE__ */ React.createElement("span", null, "Vitesse"), /* @__PURE__ */ React.createElement("span", null)), rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr .5fr", alignItems: "center", padding: "18px 24px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, fontWeight: 600, color: T.tx, fontSize: 16 } }, r[0]), /* @__PURE__ */ React.createElement("span", { style: { color: T.tx2, fontSize: 16 } }, r[1]), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Badge, { tone: r[4] }, r[2])), /* @__PURE__ */ React.createElement("span", { style: { color: r[4] === "accent" ? T.accent : T.tx2, fontWeight: 700, fontSize: 16 } }, r[3]), /* @__PURE__ */ React.createElement("span", { style: { color: T.tx3 } }, /* @__PURE__ */ React.createElement(Icon, { name: "chevron", size: 18 }))))));
}
function AlertesScreen({ p = 1 }) {
  const groups = [
    ["Critique", T.danger, "rgba(242,112,107,.14)", ["SOS", "Coupure alimentation", "Accident", "Collision", "Remorquage", "Retrait tracker", "Démarrage non autorisé"]],
    ["Vigilance", T.warning, "rgba(245,179,61,.14)", ["Batterie faible", "Excès de vitesse", "Entrée géofence", "Sortie géofence", "Mouvement à l'arrêt", "Capot ouvert", "Porte ouverte", "Fatigue conducteur"]],
    ["Info", T.accent, T.accentSoft, ["Freinage brutal", "Accélération brutale", "Virage brutal", "Vibration", "Perte signal GPS", "Arrêt prolongé"]]
  ];
  const feed = [
    ["SOS", "AB-123-CD · appel détresse", "danger", "incident"],
    ["Excès de vitesse", "QR-345-ST · 104 km/h · zone 30", "warning", "gauge"],
    ["Sortie géofence", "IJ-789-KL · Dépôt Nord", "warning", "pin"],
    ["Freinage brutal", "MN-012-OP · −0,7 g", "accent", "trendDown"]
  ];
  let chipIdx = 0;
  const totalChips = groups.reduce((n, g) => n + g[3].length, 0);
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", marginBottom: 20 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Eyebrow, null, "Surveillance"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Alertes"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 16.5 } }, "21 types d'alertes · seuils sur mesure · notifiées en temps réel")), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", gap: 10 } }, [["bell", "Push"], ["mail", "E-mail"], ["chat", "WhatsApp"]].map(([ic, l], i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 11, border: "1px solid rgba(16,224,160,.3)", background: T.accentSoft, color: T.accent, fontWeight: 700, fontSize: 15, opacity: seg(p, 0.5 + i * 0.06, 0.62 + i * 0.06) } }, /* @__PURE__ */ React.createElement(Icon, { name: ic, size: 17 }), l)))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.45fr 1fr", gap: 18 } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 24 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 17, color: T.tx, marginBottom: 4 } }, "Catalogue d'alertes"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13.5, color: T.tx3, marginBottom: 16 } }, "Activez ce qui compte, par véhicule ou par groupe"), groups.map((g, gi) => /* @__PURE__ */ React.createElement("div", { key: gi, style: { marginBottom: gi < 2 ? 16 : 0 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 9, height: 9, borderRadius: 3, background: g[1] } }), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: g[1] } }, g[0])), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } }, g[3].map((a, ai) => {
    const idx = chipIdx++;
    const o = seg(p, 0.08 + idx / totalChips * 0.34, 0.2 + idx / totalChips * 0.34, Easing.easeOutCubic);
    return /* @__PURE__ */ React.createElement("span", { key: ai, style: { display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 13px", borderRadius: 9, background: g[2], color: g[1], fontWeight: 600, fontSize: 14.5, opacity: o, transform: `translateY(${(1 - o) * 8}px)` } }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 13, sw: 2.6 }), a);
  }))))), /* @__PURE__ */ React.createElement(Card, { style: { padding: 24 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 16 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 9, height: 9, borderRadius: 99, background: T.danger, boxShadow: `0 0 0 4px rgba(242,112,107,${0.15 + 0.15 * Math.sin(p * Math.PI * 6)})` } }), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 700, fontSize: 17, color: T.tx } }, "En direct")), feed.map((r, i) => {
    const o = seg(p, 0.32 + i * 0.12, 0.46 + i * 0.12, Easing.easeOutCubic);
    const c = r[2] === "danger" ? T.danger : r[2] === "warning" ? T.warning : T.accent;
    const bg = r[2] === "danger" ? "rgba(242,112,107,.14)" : r[2] === "warning" ? "rgba(245,179,61,.14)" : T.accentSoft;
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 14, padding: "14px 0", borderTop: i > 0 ? `1px solid ${T.border}` : "none", opacity: o, transform: `translateX(${(1 - o) * 24}px)` } }, /* @__PURE__ */ React.createElement("div", { style: { width: 42, height: 42, borderRadius: 12, background: bg, color: c, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" } }, /* @__PURE__ */ React.createElement(Icon, { name: r[3], size: 20 })), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { color: T.tx, fontWeight: 600, fontSize: 16 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx3, fontSize: 13, marginTop: 2, fontFamily: T.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, r[1])), /* @__PURE__ */ React.createElement("span", { style: { color: c, fontSize: 12.5, fontWeight: 700, flex: "none" } }, i === 0 ? "à l'instant" : `il y a ${i} min`));
  }))));
}
function CoupeCircuitScreen() {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement(MapView, null, /* @__PURE__ */ React.createElement(Marker, { x: "46%", y: "42%", plate: "EF-456-GH", active: true, heading: 0, color: T.danger })), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: "rgba(8,11,10,.55)" } }), /* @__PURE__ */ React.createElement(Card, { style: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 520, padding: 34, boxShadow: "0 40px 90px rgba(0,0,0,.6)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 54, height: 54, borderRadius: 14, background: "rgba(242,112,107,.14)", color: T.danger, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "power", size: 28 })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 24, fontWeight: 800, color: T.tx } }, "Couper le moteur"), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, fontSize: 15, color: T.tx2 } }, "EF-456-GH · Peugeot Boxer"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 12, background: T.accentSoft, border: `1px solid rgba(16,224,160,.28)`, color: T.accent, fontSize: 15, fontWeight: 600, marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 20 }), "Véhicule à l'arrêt (0 km/h), coupure autorisée"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, textAlign: "center", padding: "14px", borderRadius: 12, border: `1px solid ${T.border}`, color: T.tx2, fontWeight: 700 } }, "Annuler"), /* @__PURE__ */ React.createElement("div", { style: { flex: 1.4, textAlign: "center", padding: "14px", borderRadius: 12, background: T.danger, color: "#fff", fontWeight: 800 } }, "Confirmer la coupure"))));
}
function HorairesScreen() {
  const rows = [["Groupe Livraison", "12 véhicules", "08:00", "22:00", true], ["Groupe Commercial", "6 véhicules", "07:30", "20:00", true], ["Groupe Chantier", "4 véhicules", "06:00", "18:00", true], ["Véhicules de nuit", "2 véhicules", "20:00", "06:00", false]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Automatisation"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Horaires flotte"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Coupure & reprise automatiques du démarrage, par plage horaire")), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr .6fr", padding: "16px 24px", fontSize: 13, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: T.tx3, borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement("span", null, "Groupe"), /* @__PURE__ */ React.createElement("span", null, "Parc"), /* @__PURE__ */ React.createElement("span", null, "Démarrage autorisé"), /* @__PURE__ */ React.createElement("span", null, "Coupure auto"), /* @__PURE__ */ React.createElement("span", null, "Actif")), rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr .6fr", alignItems: "center", padding: "20px 24px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("span", { style: { color: T.tx, fontWeight: 700, fontSize: 17 } }, r[0]), /* @__PURE__ */ React.createElement("span", { style: { color: T.tx2, fontSize: 15 } }, r[1]), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: T.accent, fontWeight: 700, fontSize: 17 } }, r[2]), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: T.danger, fontWeight: 700, fontSize: 17 } }, r[3]), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Toggle, { on: r[4] }))))));
}
function ActionsScreen() {
  const rows = [["J. Durand", "Coupure moteur", "EF-456-GH", "power", "danger", "il y a 4 min"], ["M. Léon", "Rallumage moteur", "AB-123-CD", "power", "accent", "il y a 22 min"], ["J. Durand", "Déverrouillage", "IJ-789-KL", "lock", "muted", "il y a 1 h"], ["A. Petit", "Coupure moteur", "QR-345-ST", "power", "danger", "il y a 2 h"], ["M. Léon", "Création alerte", "Toute la flotte", "bell", "muted", "hier"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Traçabilité, Fleet Admin"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Activité de la flotte"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Qui a fait quoi : coupures, rallumages, actions sensibles, horodatées")), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 16, padding: "20px 24px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 44, height: 44, borderRadius: 12, background: r[4] === "danger" ? "rgba(242,112,107,.14)" : r[4] === "accent" ? T.accentSoft : "rgba(155,165,161,.12)", color: r[4] === "danger" ? T.danger : r[4] === "accent" ? T.accent : T.tx2, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: r[3], size: 21 })), /* @__PURE__ */ React.createElement("div", { style: { width: 160, fontWeight: 700, color: T.tx, fontSize: 17 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, color: T.tx2, fontSize: 16 } }, r[1], ", ", /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: T.tx } }, r[2])), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx3, fontSize: 14 } }, r[5])))));
}
function RapportsScreen() {
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Analyse"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Rapports")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 20 } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 26 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 17, color: T.tx, marginBottom: 20 } }, "Générer un rapport"), [["Type", "Activité & kilométrage"], ["Période", "01 – 31 juillet 2026"], ["Véhicules", "Toute la flotte (24)"], ["Format", "PDF"]].map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: T.tx3, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { padding: "13px 16px", border: `1px solid ${T.border}`, borderRadius: 11, color: T.tx, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "space-between" } }, r[1], /* @__PURE__ */ React.createElement(Icon, { name: "chevron", size: 16, color: T.tx3 })))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 22, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "15px", borderRadius: 12, background: T.accent, color: T.accentInk, fontWeight: 800, fontSize: 17 } }, /* @__PURE__ */ React.createElement(Icon, { name: "download", size: 19, sw: 2.2 }), "Générer le PDF"), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 16, padding: 18, borderRadius: 12, border: `1px solid ${T.border}`, background: T.surface2 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 } }, /* @__PURE__ */ React.createElement(Icon, { name: "clock", size: 18, color: T.accent }), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 700, color: T.tx, fontSize: 15 } }, "Envoi automatique"), /* @__PURE__ */ React.createElement(Badge, { tone: "accent" }, "Actif")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 12 } }, /* @__PURE__ */ React.createElement(Chip, { on: true }, "Hebdo"), /* @__PURE__ */ React.createElement(Chip, null, "Mensuel")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, color: T.tx2, fontSize: 14.5 } }, /* @__PURE__ */ React.createElement(Icon, { name: "mail", size: 16, color: T.tx3 }), "compta@entreprise.fr, chaque lundi 8 h"))), /* @__PURE__ */ React.createElement(Card, { style: { padding: 0, overflow: "hidden", background: "#0e1211" } }, /* @__PURE__ */ React.createElement("div", { style: { background: "#fff", margin: 24, borderRadius: 8, padding: 26, color: "#111", boxShadow: "0 20px 50px rgba(0,0,0,.5)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, borderBottom: "2px solid #10b981", paddingBottom: 12, marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 20, height: 20 } }, /* @__PURE__ */ React.createElement(Logo, { size: 20 })), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 16 } }, "Rapport d'activité, Juillet 2026")), [["Distance totale", "18 420 km"], ["Temps de conduite", "412 h"], ["Vitesse moyenne", "44 km/h"], ["Arrêts", "1 284"]].map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid #eee", fontSize: 14 } }, /* @__PURE__ */ React.createElement("span", { style: { color: "#666" } }, r[0]), /* @__PURE__ */ React.createElement("strong", null, r[1]))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 5, alignItems: "flex-end", height: 70, marginTop: 18 } }, [40, 62, 48, 71, 55, 80, 45].map((h, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { flex: 1, height: `${h}%`, background: "#10b981", borderRadius: "3px 3px 0 0", opacity: 0.85 } })))))));
}
function TrajetScreen({ recap = false, p = 1 }) {
  const D = "M300 780 C 500 700, 560 520, 760 480 S 1100 420, 1240 300 S 1400 180, 1520 220";
  const pathRef = useRef(null);
  const [pts, setPts] = useState(null);
  useLayoutEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const L = el.getTotalLength();
    const arr = [];
    for (let i = 0; i <= 60; i++) {
      const pt = el.getPointAtLength(L * i / 60);
      arr.push([pt.x, pt.y]);
    }
    setPts(arr);
  }, []);
  const draw = clamp01(seg(p, 0.05, 0.62, Easing.easeInOutCubic));
  const head = pts ? pts[Math.min(60, Math.round(draw * 60))] : [300, 780];
  const stops = [[760, 480, "clock", "Arrêt · 12 min", T.warning, 0.36], [1240, 300, "fuel", "Plein · station", T.accent, 0.62]];
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement(MapView, null, /* @__PURE__ */ React.createElement("svg", { width: "100%", height: "100%", style: { position: "absolute", inset: 0 }, viewBox: "0 0 1920 1080", preserveAspectRatio: "none" }, /* @__PURE__ */ React.createElement("path", { ref: pathRef, d: D, fill: "none", stroke: "rgba(255,255,255,.08)", strokeWidth: "6", strokeLinecap: "round" }), /* @__PURE__ */ React.createElement("path", { d: D, fill: "none", stroke: T.accent, strokeWidth: "6", strokeLinecap: "round", pathLength: "1", strokeDasharray: "1 1", strokeDashoffset: 1 - draw, style: { filter: "drop-shadow(0 0 8px rgba(16,224,160,.5))" } })), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 300, top: 780, transform: "translate(-50%,-50%)", width: 22, height: 22, borderRadius: 99, background: T.accent, border: "3px solid #fff", boxShadow: "0 2px 8px rgba(0,0,0,.5)" } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 1520, top: 220, transform: "translate(-50%,-50%)", width: 22, height: 22, borderRadius: 99, background: T.danger, border: "3px solid #fff", boxShadow: "0 2px 8px rgba(0,0,0,.5)", opacity: draw > 0.98 ? 1 : 0.35 } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: head[0], top: head[1], transform: "translate(-50%,-50%)", width: 34, height: 34, borderRadius: 99, background: T.accent, border: "3px solid #fff", boxShadow: `0 0 20px ${T.accent}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.accentInk } }, /* @__PURE__ */ React.createElement(Icon, { name: "truck", size: 17, sw: 2.2 })), stops.map(([px, py, ic, lb, cl, at], i) => {
    const o = clamp01((draw - at) / 0.06);
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { position: "absolute", left: px, top: py, transform: `translate(-50%,-120%) scale(${0.6 + o * 0.4})`, opacity: o } }, /* @__PURE__ */ React.createElement("div", { style: { background: "rgba(16,21,20,.95)", border: `1px solid ${T.border}`, borderRadius: 10, padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, color: T.tx, fontWeight: 600, fontSize: 14, whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement(Icon, { name: ic, size: 16, color: cl }), lb), /* @__PURE__ */ React.createElement("div", { style: { width: 14, height: 14, borderRadius: 99, background: cl, border: "3px solid #fff", margin: "4px auto 0" } }));
  })), recap && (() => {
    const cardO = seg(p, 0.5, 0.62, Easing.easeOutCubic);
    const badges = [["danger", "Zone 30 · 41 km/h"], ["danger", "Excès · 104 km/h"], ["warning", "Freinage brusque ×2"]];
    return /* @__PURE__ */ React.createElement(Card, { style: { position: "absolute", top: 24, right: 40, width: 410, padding: 24, background: "rgba(16,21,20,.96)", backdropFilter: "blur(10px)", opacity: cardO, transform: `translateX(${(1 - cardO) * 30}px)`, boxShadow: "0 24px 60px rgba(0,0,0,.5)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 40, height: 40, borderRadius: 11, background: T.accentSoft, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "sparkles", size: 20 })), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 18, color: T.tx } }, "Récit du trajet · IA")), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: 15.5, lineHeight: 1.6, color: T.tx2, textWrap: "pretty" } }, "Départ dépôt Nord à 08:12. Trajet de ", /* @__PURE__ */ React.createElement("strong", { style: { color: T.tx } }, "47 km"), " vers Toulouse Est, arrêt livraison de 12 min, plein carburant à mi-parcours. Arrivée 09:34."), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 } }, badges.map((b, i) => {
      const bo = seg(p, 0.66 + i * 0.07, 0.76 + i * 0.07, Easing.easeOutCubic);
      return /* @__PURE__ */ React.createElement("span", { key: i, style: { opacity: bo, transform: `translateY(${(1 - bo) * 8}px)` } }, /* @__PURE__ */ React.createElement(Badge, { tone: b[0] }, b[1]));
    })));
  })());
}
function ScoresScreen({ p = 1 }) {
  const rows = [["M. Léon", "AB-123-CD", 92, "A", T.accent], ["S. Fabre", "IJ-789-KL", 84, "B", T.accent], ["A. Petit", "QR-345-ST", 71, "C", T.warning], ["J. Roux", "MN-012-OP", 58, "D", T.danger]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Éco-conduite"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Scores de conduite"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Vitesse, freinage, zones 30, noté par conducteur")), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, rows.map((r, i) => {
    const ro = seg(p, 0.08 + i * 0.09, 0.24 + i * 0.09, Easing.easeOutCubic);
    const bar = seg(p, 0.18 + i * 0.09, 0.5 + i * 0.09, Easing.easeOutCubic);
    const shown = Math.round(r[2] * bar);
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 20, padding: "22px 26px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none", opacity: ro, transform: `translateX(${(1 - ro) * 26}px)` } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: T.tx3, fontSize: 16, width: 24 } }, i + 1), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, color: T.tx, fontSize: 18 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, color: T.tx3, fontSize: 14 } }, r[1])), /* @__PURE__ */ React.createElement("div", { style: { flex: 2, maxWidth: 480 } }, /* @__PURE__ */ React.createElement("div", { style: { height: 10, borderRadius: 99, background: "rgba(255,255,255,.06)", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { width: `${r[2] * bar}%`, height: "100%", background: r[4], borderRadius: 99 } }))), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 22, color: T.tx, width: 60, textAlign: "right" } }, shown), /* @__PURE__ */ React.createElement("span", { style: { width: 46, height: 46, borderRadius: 12, background: r[4] === T.accent ? T.accentSoft : r[4] === T.warning ? "rgba(245,179,61,.14)" : "rgba(242,112,107,.14)", color: r[4], display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 22, opacity: bar > 0.9 ? 1 : 0.3 } }, r[3]));
  })));
}
function AgendaScreen({ highlight = -1 }) {
  const days = ["Lun 13", "Mar 14", "Mer 15", "Jeu 16", "Ven 17"];
  const events = [[0, 1, "Révision, AB-123-CD", "accent"], [1, 2, "Réservation, S. Fabre", "warning"], [2, 0, "Incident, pare-brise", "danger"], [2, 3, "Contrôle technique", "accent"], [4, 1, "Optimisation tournée", "accent"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", marginBottom: 20 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Eyebrow, null, "Planification"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Agenda")), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", borderRadius: 12, background: T.accentSoft, border: "1px solid rgba(16,224,160,.28)", color: T.accent, fontWeight: 700, fontSize: 15 } }, /* @__PURE__ */ React.createElement(Icon, { name: "route", size: 18 }), "Optimiser les tournées")), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `repeat(${days.length},1fr)` } }, days.map((d, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { padding: "14px", textAlign: "center", fontWeight: 700, color: T.tx2, fontSize: 15, borderRight: i < days.length - 1 ? `1px solid ${T.border}` : "none", borderBottom: `1px solid ${T.border}` } }, d))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `repeat(${days.length},1fr)`, minHeight: 520, position: "relative" } }, days.map((_, ci) => /* @__PURE__ */ React.createElement("div", { key: ci, style: { borderRight: ci < days.length - 1 ? `1px solid ${T.border}` : "none", padding: 8, display: "flex", flexDirection: "column", gap: 8 } }, events.filter((e) => e[0] === ci).map((e, k) => {
    const tone = e[3];
    const cl = tone === "danger" ? T.danger : tone === "warning" ? T.warning : T.accent;
    const bg = tone === "danger" ? "rgba(242,112,107,.14)" : tone === "warning" ? "rgba(245,179,61,.14)" : T.accentSoft;
    return /* @__PURE__ */ React.createElement("div", { key: k, style: { marginTop: e[1] * 76, background: bg, borderLeft: `3px solid ${cl}`, borderRadius: 8, padding: "11px 12px", color: T.tx, fontSize: 14, fontWeight: 600, lineHeight: 1.3 } }, e[2]);
  }))))));
}
function IncidentScreen() {
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 20 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Auto-gestion"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Déclaration d'incident")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 26 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 46, height: 46, borderRadius: 12, background: "rgba(242,112,107,.14)", color: T.danger, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "incident", size: 22 })), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 700, fontSize: 18, color: T.tx } }, "Nouvel incident")), [["Véhicule", "EF-456-GH, Peugeot Boxer"], ["Type", "Bris de pare-brise"], ["Priorité", "Élevée"], ["Atelier", "Garage Central Toulouse"]].map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: T.tx3, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { padding: "13px 16px", border: `1px solid ${T.border}`, borderRadius: 11, color: T.tx, fontSize: 16 } }, r[1])))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, color: T.accent, fontWeight: 700, fontSize: 17, justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "arrow", size: 22 }), "Placé automatiquement dans l'agenda"), /* @__PURE__ */ React.createElement(Card, { style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: T.tx3, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700, marginBottom: 14 } }, "Mercredi 15 juillet"), /* @__PURE__ */ React.createElement("div", { style: { background: "rgba(242,112,107,.14)", borderLeft: `3px solid ${T.danger}`, borderRadius: 8, padding: "14px 16px", marginBottom: 10 } }, /* @__PURE__ */ React.createElement("div", { style: { color: T.tx, fontWeight: 700, fontSize: 16 } }, "Incident, pare-brise"), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx2, fontSize: 14, marginTop: 3 } }, "EF-456-GH · Garage Central · 14:00")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: T.accentSoft, color: T.accent, fontWeight: 600, fontSize: 14 } }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 18 }), "Réservation atelier confirmée & tournée réajustée")))));
}
function UtilisateursScreen() {
  const rows = [["Jean Durand", "jean.durand@vizyo.fr", "Fleet Admin", "accent"], ["Marie Léon", "marie.leon@vizyo.fr", "Gestionnaire", "muted"], ["Sophie Fabre", "sophie.fabre@vizyo.fr", "Conductrice", "muted"], ["Alex Petit", "alex.petit@vizyo.fr", "Veilleur", "warning"], ["Léa Roux", "lea.roux@vizyo.fr", "Lecture seule", "muted"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", marginBottom: 22 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Eyebrow, null, "Comptes & accès"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Utilisateurs")), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderRadius: 12, background: T.accent, color: T.accentInk, fontWeight: 700 } }, /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 17 }), "Inviter")), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 16, padding: "20px 24px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 46, height: 46, borderRadius: 99, background: "linear-gradient(135deg,#10e0a0,#047857)", color: T.accentInk, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16 } }, r[0].split(" ").map((x) => x[0]).join("")), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, color: T.tx, fontSize: 17 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, color: T.tx3, fontSize: 14 } }, r[1])), /* @__PURE__ */ React.createElement(Badge, { tone: r[3] }, r[2]), /* @__PURE__ */ React.createElement("span", { style: { color: T.tx3 } }, /* @__PURE__ */ React.createElement(Icon, { name: "chevron", size: 18 }))))));
}
function PermissionsScreen() {
  const perms = ["Voir", "Modifier", "Coupe-circuit", "Rapports", "Users"];
  const users = [["Fleet Admin", [1, 1, 1, 1, 1]], ["Gestionnaire", [1, 1, 1, 1, 0]], ["Conductrice", [1, 0, 0, 0, 0]], ["Veilleur", [1, 0, 0, 0, 0]], ["Lecture seule", [1, 0, 0, 1, 0]]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 20 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Contrôle fin"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Permissions"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Droits au véhicule ou au groupe près, sur-mesure, sans compromis")), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `1.4fr repeat(${perms.length},1fr)`, borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement("div", { style: { padding: "16px 24px", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: T.tx3 } }, "Rôle"), perms.map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { padding: "16px 8px", textAlign: "center", fontSize: 13, fontWeight: 700, color: T.tx3 } }, p))), users.map((u, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: `1.4fr repeat(${perms.length},1fr)`, alignItems: "center", borderBottom: i < users.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("div", { style: { padding: "18px 24px", fontWeight: 700, color: T.tx, fontSize: 16 } }, u[0]), u[1].map((v, k) => /* @__PURE__ */ React.createElement("div", { key: k, style: { padding: "18px 8px", display: "flex", justifyContent: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 30, height: 30, borderRadius: 9, background: v ? T.accentSoft : "rgba(255,255,255,.04)", color: v ? T.accent : T.tx3, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${v ? "rgba(16,224,160,.3)" : T.border}` } }, /* @__PURE__ */ React.createElement(Icon, { name: v ? "check" : "x", size: 16, sw: 2.4 }))))))));
}
function SimScreen() {
  const rows = [["893315...0421", "WhereverSIM", "1.2 Go", "Active", "accent"], ["893315...0422", "WhereverSIM", "840 Mo", "Active", "accent"], ["893315...0423", "Orange M2M", "2.1 Go", "Active", "accent"], ["893315...0424", "WhereverSIM", "0 Mo", "Suspendue", "warning"], ["893315...0425", "Orange M2M", ",", "Inactive", "muted"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Connectivité"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Cartes SIM")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 20 } }, /* @__PURE__ */ React.createElement(KPI, { icon: "sim", value: "24", label: "SIM actives" }), /* @__PURE__ */ React.createElement(KPI, { icon: "activity", value: "38 Go", label: "Data ce mois" }), /* @__PURE__ */ React.createElement(KPI, { icon: "alert", value: "1", label: "À surveiller", tone: "muted" })), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", padding: "16px 24px", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: T.tx3, borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement("span", null, "ICCID"), /* @__PURE__ */ React.createElement("span", null, "Opérateur"), /* @__PURE__ */ React.createElement("span", null, "Data"), /* @__PURE__ */ React.createElement("span", null, "Statut")), rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", alignItems: "center", padding: "18px 24px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: T.tx, fontSize: 15 } }, r[0]), /* @__PURE__ */ React.createElement("span", { style: { color: T.tx2, fontSize: 15 } }, r[1]), /* @__PURE__ */ React.createElement("span", { style: { color: T.tx, fontWeight: 600, fontSize: 15 } }, r[2]), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Badge, { tone: r[4] }, r[3]))))));
}
function InstallationScreen() {
  const steps = [["Commande boîtiers", "Terminé", "accent"], ["RDV installation", "Terminé", "accent"], ["Pose sur véhicules", "En cours, 18/24", "warning"], ["Recette & tests GPS", "À venir", "muted"], ["Mise en service", "À venir", "muted"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Déploiement"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Planning d'installation"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Suivi de la pose des boîtiers, étape par étape")), /* @__PURE__ */ React.createElement(Card, { style: { padding: "18px 24px", marginBottom: 16, display: "flex", alignItems: "center", gap: 16, background: T.accentSoft, border: "1px solid rgba(16,224,160,.28)" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 48, height: 48, borderRadius: 12, background: "rgba(16,224,160,.18)", color: T.accent, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" } }, /* @__PURE__ */ React.createElement(Icon, { name: "globe", size: 26 })), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 800, fontSize: 18, color: T.tx } }, "Installation partout en France"), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx2, fontSize: 15, marginTop: 2 } }, "Couverture nationale · SIM & data incluses · pose en Occitanie sous 48 h")), /* @__PURE__ */ React.createElement(Badge, { tone: "accent" }, "France entière")), /* @__PURE__ */ React.createElement(Card, { style: { padding: "10px 30px" } }, steps.map((s, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 20, padding: "22px 0", borderBottom: i < steps.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 40, height: 40, borderRadius: 99, border: `2px solid ${s[2] === "accent" ? T.accent : s[2] === "warning" ? T.warning : T.border2}`, background: s[2] === "accent" ? T.accent : "transparent", color: s[2] === "accent" ? T.accentInk : s[2] === "warning" ? T.warning : T.tx3, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15 } }, s[2] === "accent" ? /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 20, sw: 2.5 }) : i + 1), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, fontWeight: 700, color: T.tx, fontSize: 18 } }, s[0]), /* @__PURE__ */ React.createElement(Badge, { tone: s[2] }, s[1])))));
}
function GeofencesScreen() {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement(MapView, null, /* @__PURE__ */ React.createElement("svg", { width: "100%", height: "100%", style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement("polygon", { points: "240,220 560,180 620,420 300,480", fill: "rgba(16,224,160,.1)", stroke: T.accent, strokeWidth: "3", strokeDasharray: "10 8" }), /* @__PURE__ */ React.createElement("polygon", { points: "1040,300 1360,260 1420,540 1100,600", fill: "rgba(245,179,61,.1)", stroke: T.warning, strokeWidth: "3", strokeDasharray: "10 8" })), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 300, top: 250, background: "rgba(16,21,20,.95)", border: `1px solid ${T.border}`, borderRadius: 9, padding: "7px 13px", color: T.accent, fontWeight: 700, fontSize: 14 } }, "Dépôt Nord"), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 1120, top: 330, background: "rgba(16,21,20,.95)", border: `1px solid ${T.border}`, borderRadius: 9, padding: "7px 13px", color: T.warning, fontWeight: 700, fontSize: 14 } }, "Chantier A61"), /* @__PURE__ */ React.createElement(Marker, { x: "24%", y: "34%", plate: "AB-123-CD", active: true, heading: 70 }), /* @__PURE__ */ React.createElement(Marker, { x: "62%", y: "42%", plate: "IJ-789-KL", color: T.warning, heading: 150 })), /* @__PURE__ */ React.createElement(Card, { style: { position: "absolute", top: 24, right: 24, width: 320, padding: 20, background: "rgba(16,21,20,.95)", backdropFilter: "blur(8px)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 40, height: 40, borderRadius: 11, background: T.accentSoft, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "pin", size: 20 })), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 17, color: T.tx } }, "Géofences illimitées")), [["Dépôt Nord", "Entrée / sortie", "accent"], ["Chantier A61", "Alerte entrée", "warning"], ["Zone interdite", "Alerte immédiate", "danger"]].map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: i > 0 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 10, height: 10, borderRadius: 3, background: r[2] === "danger" ? T.danger : r[2] === "warning" ? T.warning : T.accent } }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { color: T.tx, fontWeight: 600, fontSize: 15 } }, r[0]), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx3, fontSize: 12.5, fontFamily: T.mono } }, r[1]))))));
}
function AudioScreen({ p = 1 }) {
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Sécurité renforcée"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Surveillance audio"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Écoute cabine à distance, encadrée, éligibilité vérifiée")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 30 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "10px 0" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "relative", width: 120, height: 120, borderRadius: 99, background: T.accentSoft, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: -8, borderRadius: 99, border: `2px solid ${T.accent}`, opacity: 0.3 } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: -18, borderRadius: 99, border: `2px solid ${T.accent}`, opacity: 0.15 } }), /* @__PURE__ */ React.createElement(Icon, { name: "mic", size: 48, color: T.accent })), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 20, fontWeight: 800, color: T.tx } }, "Écoute en cours"), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, fontSize: 15, color: T.tx2, marginTop: 4 } }, "EF-456-GH · Peugeot Boxer")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", gap: 5, height: 54 } }, [30, 55, 80, 45, 90, 60, 75, 40, 65, 50, 85, 35].map((h, i) => {
    const v = 20 + (h - 20) * (0.5 + 0.5 * Math.abs(Math.sin(p * Math.PI * 5 + i * 0.7)));
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { width: 7, height: `${v}%`, background: T.accent, borderRadius: 3, opacity: 0.85 } });
  })))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 22, color: T.accent }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { color: T.tx, fontWeight: 700, fontSize: 16 } }, "Boîtier éligible"), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx3, fontSize: 13 } }, "Micro certifié détecté")))), /* @__PURE__ */ React.createElement(Card, { style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } }, /* @__PURE__ */ React.createElement(Icon, { name: "lock", size: 22, color: T.accent }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { color: T.tx, fontWeight: 700, fontSize: 16 } }, "Accès restreint & journalisé"), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx3, fontSize: 13 } }, "Chaque écoute est horodatée et tracée")))), /* @__PURE__ */ React.createElement(Card, { style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } }, /* @__PURE__ */ React.createElement(Icon, { name: "shield", size: 22, color: T.accent }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { color: T.tx, fontWeight: 700, fontSize: 16 } }, "Cadre légal respecté"), /* @__PURE__ */ React.createElement("div", { style: { color: T.tx3, fontSize: 13 } }, "Fonction activée selon vos obligations")))))));
}
function EconomiesScreen({ p = 1 }) {
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Retour sur investissement"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Économies"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "L'abonnement se rembourse, carburant maîtrisé, primes réduites")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, marginBottom: 20 } }, /* @__PURE__ */ React.createElement(KPI, { icon: "fuel", value: "−14 %", label: "Carburant" }), /* @__PURE__ */ React.createElement(KPI, { icon: "trendDown", value: "−22 %", label: "Km inutiles" }), /* @__PURE__ */ React.createElement(KPI, { icon: "euro", value: "Remboursé", label: "Abonnement / mois" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 28, position: "relative", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 52, height: 52, borderRadius: 14, background: T.accentSoft, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "shield", size: 27 })), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 22, color: T.tx } }, "Assurance réduite")), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: 18, lineHeight: 1.55, color: T.tx2, textWrap: "pretty" } }, "Une flotte équipée d'un système de traçage rassure les assureurs. Antivol, coupe-circuit et historique des trajets font ", /* @__PURE__ */ React.createElement("strong", { style: { color: T.tx } }, "baisser vos primes"), "."), /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 10, marginTop: 18, padding: "10px 16px", borderRadius: 10, background: T.accentSoft, color: T.accent, fontWeight: 700, fontSize: 16 } }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 18 }), "Attestation de traçage fournie")), /* @__PURE__ */ React.createElement(Card, { style: { padding: 28 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 700, fontSize: 17, color: T.tx, marginBottom: 18 } }, "Coût carburant · 6 mois"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "flex-end", height: 180 } }, [[92, "Jan"], [88, "Fév"], [79, "Mar"], [74, "Avr"], [68, "Mai"], [61, "Juin"]].map(([h, m], i) => {
    const grow = seg(p, 0.2 + i * 0.06, 0.5 + i * 0.06, Easing.easeOutCubic);
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: `${h * grow}%`, background: i >= 3 ? T.accent : "rgba(16,224,160,.35)", borderRadius: "5px 5px 0 0" } }), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 13, color: T.tx3, fontFamily: T.mono } }, m));
  })))));
}
function GroupesScreen() {
  const groups = [["Livraison", 12, "Dépôt Nord", T.accent], ["Commercial", 6, "Siège Toulouse", T.accent], ["Chantier", 4, "Base Muret", T.warning], ["Nuit", 2, "Dépôt Sud", T.tx2]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 22 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Organisation"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Groupes de véhicules"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Par site, agence ou activité, avec vues et droits dédiés")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 18 } }, groups.map((g, i) => /* @__PURE__ */ React.createElement(Card, { key: i, style: { padding: 26, display: "flex", alignItems: "center", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 60, borderRadius: 15, background: T.accentSoft, color: g[3], display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: "layers", size: 30 })), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 22, fontWeight: 800, color: T.tx } }, g[0]), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 5, color: T.tx2, fontSize: 15 } }, /* @__PURE__ */ React.createElement(Icon, { name: "pin", size: 15, color: T.tx3 }), g[2])), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 30, fontWeight: 800, color: T.tx } }, g[1]), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, color: T.tx3 } }, "véhicules"))))));
}
function ConducteursScreen() {
  const rows = [["Marc Léon", "2431", "AB-123-CD", "accent"], ["Sophie Fabre", "7712", "IJ-789-KL", "accent"], ["Alex Petit", "5088", ",", "muted"], ["Léa Roux", "9204", "QR-345-ST", "accent"]];
  return /* @__PURE__ */ React.createElement("div", { style: PAD }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 20 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Attribution"), /* @__PURE__ */ React.createElement("h1", { style: { margin: "8px 0 0", fontSize: 34, fontWeight: 800, color: T.tx } }, "Identification conducteur"), /* @__PURE__ */ React.createElement("p", { style: { margin: "6px 0 0", color: T.tx2, fontSize: 17 } }, "Par code PIN, chaque trajet attribué au bon agent")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" } }, /* @__PURE__ */ React.createElement(Card, { style: { padding: 28 } }, /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginBottom: 18, fontWeight: 700, color: T.tx2, fontSize: 15 } }, "Saisie du code au démarrage"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", gap: 10, marginBottom: 22 } }, ["2", "4", "3", "1"].map((d, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { width: 54, height: 64, borderRadius: 12, border: `1px solid ${T.border2}`, background: T.surface2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, fontWeight: 800, color: T.accent, fontFamily: T.mono } }, d))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 } }, ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => /* @__PURE__ */ React.createElement("div", { key: n, style: { height: 52, borderRadius: 11, background: T.surface2, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 700, color: T.tx } }, n)))), /* @__PURE__ */ React.createElement(Card, { style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.4fr .8fr 1fr", padding: "16px 24px", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: T.tx3, borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement("span", null, "Conducteur"), /* @__PURE__ */ React.createElement("span", null, "PIN"), /* @__PURE__ */ React.createElement("span", null, "Véhicule")), rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1.4fr .8fr 1fr", alignItems: "center", padding: "19px 24px", borderBottom: i < rows.length - 1 ? `1px solid ${T.border}` : "none" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 40, height: 40, borderRadius: 99, background: "linear-gradient(135deg,#10e0a0,#047857)", color: T.accentInk, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14 } }, r[0].split(" ").map((x) => x[0]).join("")), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 700, color: T.tx, fontSize: 16 } }, r[0])), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: T.tx2, fontSize: 16, letterSpacing: ".15em" } }, "••", r[1].slice(2)), /* @__PURE__ */ React.createElement("span", { style: { fontFamily: T.mono, color: r[3] === "accent" ? T.accent : T.tx3, fontWeight: 600, fontSize: 15 } }, r[2]))))));
}
const SCREENS = {
  dashboard: (o) => /* @__PURE__ */ React.createElement(DashboardScreen, { ...o }),
  carte: (o) => /* @__PURE__ */ React.createElement(CarteScreen, { ...o }),
  vehicules: (o) => /* @__PURE__ */ React.createElement(VehiculesScreen, { ...o }),
  geofences: (o) => /* @__PURE__ */ React.createElement(GeofencesScreen, { ...o }),
  alertes: (o) => /* @__PURE__ */ React.createElement(AlertesScreen, { ...o }),
  audio: (o) => /* @__PURE__ */ React.createElement(AudioScreen, { ...o }),
  coupecircuit: (o) => /* @__PURE__ */ React.createElement(CoupeCircuitScreen, { ...o }),
  horaires: (o) => /* @__PURE__ */ React.createElement(HorairesScreen, { ...o }),
  actions: (o) => /* @__PURE__ */ React.createElement(ActionsScreen, { ...o }),
  rapports: (o) => /* @__PURE__ */ React.createElement(RapportsScreen, { ...o }),
  economies: (o) => /* @__PURE__ */ React.createElement(EconomiesScreen, { ...o }),
  trajet: (o) => /* @__PURE__ */ React.createElement(TrajetScreen, { ...o }),
  recit: (o) => /* @__PURE__ */ React.createElement(TrajetScreen, { recap: true, ...o }),
  scores: (o) => /* @__PURE__ */ React.createElement(ScoresScreen, { ...o }),
  agenda: (o) => /* @__PURE__ */ React.createElement(AgendaScreen, { ...o }),
  incident: (o) => /* @__PURE__ */ React.createElement(IncidentScreen, { ...o }),
  utilisateurs: (o) => /* @__PURE__ */ React.createElement(UtilisateursScreen, { ...o }),
  groupes: (o) => /* @__PURE__ */ React.createElement(GroupesScreen, { ...o }),
  conducteurs: (o) => /* @__PURE__ */ React.createElement(ConducteursScreen, { ...o }),
  permissions: (o) => /* @__PURE__ */ React.createElement(PermissionsScreen, { ...o }),
  sim: (o) => /* @__PURE__ */ React.createElement(SimScreen, { ...o }),
  installation: (o) => /* @__PURE__ */ React.createElement(InstallationScreen, { ...o })
};
const CAT_COLOR = { Supervision: T.accent, Analyse: T.accent, Administration: T.accent };
function GridBG({ p }) {
  const drift = p * 40;
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: -60, backgroundImage: `linear-gradient(${T.border} 1px,transparent 1px),linear-gradient(90deg,${T.border} 1px,transparent 1px)`, backgroundSize: "58px 58px", transform: `translate(${drift}px,${drift}px)`, maskImage: "radial-gradient(ellipse 70% 60% at 50% 45%,#000 30%,transparent 80%)", WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 45%,#000 30%,transparent 80%)" } });
}
function IntroScene({ scene }) {
  const { progress: p } = useScene();
  const logoS = interpolate(seg(p, 0, 0.28, Easing.easeOutBack), [0, 1], [0.4, 1]);
  const logoO = seg(p, 0, 0.2);
  const titO = seg(p, 0.22, 0.42);
  const titY = (1 - seg(p, 0.22, 0.42, Easing.easeOutCubic)) * 30;
  const subO = seg(p, 0.4, 0.58);
  const barW = seg(p, 0.34, 0.6, Easing.easeOutCubic) * 120;
  const out = 1 - seg(p, 0.9, 1);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: T.sans, opacity: out } }, /* @__PURE__ */ React.createElement(GridBG, { p }), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { transform: `scale(${logoS})`, opacity: logoO, display: "flex", justifyContent: "center", marginBottom: 30 } }, /* @__PURE__ */ React.createElement(Logo, { size: 120 })), /* @__PURE__ */ React.createElement("div", { style: { opacity: titO, transform: `translateY(${titY}px)` } }, /* @__PURE__ */ React.createElement(Eyebrow, null, scene.eyebrow), /* @__PURE__ */ React.createElement("h1", { style: { margin: "16px 0 0", fontSize: 88, fontWeight: 800, letterSpacing: "-.03em", color: T.tx, lineHeight: 1 } }, scene.title)), /* @__PURE__ */ React.createElement("div", { style: { width: barW, height: 4, background: T.accent, borderRadius: 4, margin: "30px auto 0", boxShadow: `0 0 20px ${T.accent}` } }), /* @__PURE__ */ React.createElement("p", { style: { opacity: subO, margin: "26px auto 0", fontSize: 26, color: T.tx2, maxWidth: 900, textWrap: "pretty" } }, scene.tagline)));
}
function MenuScene({ scene }) {
  const { progress: p } = useScene();
  const groupRef = useRef(null);
  const wrapRef = useRef(null);
  const innerRef = useRef(null);
  const [box, setBox] = useState(null);
  const MS = 1.34;
  const LEFT = 170;
  useLayoutEffect(() => {
    if (groupRef.current && wrapRef.current && innerRef.current) {
      const g = groupRef.current.getBoundingClientRect();
      const w = wrapRef.current.getBoundingClientRect();
      const inr = innerRef.current.getBoundingClientRect();
      const S = w.height / 1080;
      setBox({ x: (g.left - inr.left) / S, y: (g.top - inr.top) / S, w: g.width / S, h: g.height / S });
    }
  }, []);
  const enterX = (1 - seg(p, 0, 0.16, Easing.easeOutExpo)) * -90;
  const enterO = seg(p, 0, 0.12);
  const draw = seg(p, 0.2, 0.5, Easing.easeInOutCubic);
  const pulse = 1 + Math.sin(clamp01((p - 0.5) / 0.14) * Math.PI) * 0.05 * (p > 0.5 && p < 0.66 ? 1 : 0);
  const out = 1 - seg(p, 0.9, 1);
  const active = NAV[scene.group][0].label;
  const shiftY = box ? 540 - (box.y + box.h / 2) : 0;
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: T.bg, fontFamily: T.sans, opacity: out, overflow: "hidden" } }, /* @__PURE__ */ React.createElement(GridBG, { p }), /* @__PURE__ */ React.createElement("div", { ref: wrapRef, style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement("div", { ref: innerRef, style: { position: "absolute", left: LEFT, top: 0, transform: `translate(${enterX}px, ${shiftY}px)`, opacity: enterO } }, /* @__PURE__ */ React.createElement("div", { style: { transform: `scale(${MS})`, transformOrigin: "left top" } }, /* @__PURE__ */ React.createElement(SidebarWithRefs, { active, highlight: scene.group, groupRef })), box && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, transform: `scale(${pulse})`, transformOrigin: "center" } }, /* @__PURE__ */ React.createElement(RedBox, { x: 0, y: 0, w: box.w, h: box.h, progress: draw })))), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", right: 96, top: "50%", transform: "translateY(-50%)", maxWidth: 620, opacity: seg(p, 0.42, 0.6), textAlign: "left" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 10, padding: "9px 18px", borderRadius: 99, background: "rgba(255,77,77,.12)", border: "1px solid rgba(255,77,77,.4)", color: T.red, fontWeight: 800, fontSize: 18, letterSpacing: ".08em", marginBottom: 22 } }, scene.group.toUpperCase()), /* @__PURE__ */ React.createElement("h2", { style: { margin: 0, fontSize: 56, fontWeight: 800, letterSpacing: "-.02em", color: T.tx, lineHeight: 1.05 } }, scene.heading), /* @__PURE__ */ React.createElement("p", { style: { margin: "20px 0 0", fontSize: 24, lineHeight: 1.5, color: T.tx2, textWrap: "pretty" } }, scene.sub)));
}
function SidebarWithRefs({ active, highlight, groupRef }) {
  return /* @__PURE__ */ React.createElement("div", { style: { width: 300, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 16, display: "flex", flexDirection: "column", fontFamily: T.sans, paddingBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { height: 76, display: "flex", alignItems: "center", gap: 12, padding: "0 22px", borderBottom: `1px solid ${T.border}` } }, /* @__PURE__ */ React.createElement(Logo, { size: 28 }), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 21, color: T.tx } }, "Tracky"), /* @__PURE__ */ React.createElement("div", { style: { marginLeft: "auto", display: "flex", flexDirection: "column", gap: 4 } }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("span", { key: i, style: { width: 18, height: 2, background: T.tx3, borderRadius: 2 } })))), /* @__PURE__ */ React.createElement("div", { style: { padding: "12px 14px", display: "flex", flexDirection: "column" } }, Object.entries(NAV).map(([section, items]) => /* @__PURE__ */ React.createElement("div", { key: section, ref: section === highlight ? groupRef : null, style: { marginTop: section === "Supervision" ? 2 : 14, padding: 4 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, fontSize: 12, fontWeight: 600, letterSpacing: ".16em", textTransform: "uppercase", color: section === highlight ? T.red : T.tx3, padding: "0 12px 9px" } }, section), items.map((it) => {
    const on = it.label === active;
    return /* @__PURE__ */ React.createElement("div", { key: it.label, style: { display: "flex", alignItems: "center", gap: 13, padding: "10px 12px", borderRadius: 10, marginBottom: 2, background: on ? T.accentSoft : "transparent", color: on ? T.accent : T.tx2, fontWeight: on ? 700 : 500, fontSize: 16 } }, /* @__PURE__ */ React.createElement(Icon, { name: it.icon, size: 20, sw: 1.8 }), /* @__PURE__ */ React.createElement("span", { style: { whiteSpace: "nowrap" } }, it.label));
  })))));
}
function ServiceScene({ scene }) {
  const { progress: p } = useScene();
  const z = scene.zoom || {};
  const tgt = z.s1 ?? 1.26, ox = z.ox ?? 60, oy = z.oy ?? 52;
  const ein = Easing.easeOutExpo(clamp01(p / 0.24));
  const drift = Easing.easeInOutSine(p) * 0.1;
  const seed = window.OM_MOTION_SEED || 0;
  const variant = ((scene.i || 1) + seed) % 6;
  let scale, tx = 0, ty = 0, rot = 0, tox = ox, toy = oy;
  if (variant === 0) {
    scale = lerp(1.14, tgt, ein) + drift;
  } else if (variant === 1) {
    scale = lerp(tgt + 0.06, tgt, ein) + drift;
    tx = (1 - ein) * 30;
  } else if (variant === 2) {
    scale = lerp(tgt + 0.04, tgt, ein) + drift;
    ty = (1 - ein) * 34;
  } else if (variant === 3) {
    scale = lerp(1.1, tgt, ein) + drift;
    rot = (1 - ein) * -3.5;
  } else if (variant === 4) {
    scale = lerp(1.34, tgt, ein) + drift;
    tox = 50;
    toy = 50;
  } else {
    scale = lerp(tgt + 0.05, tgt, ein) + drift;
    tx = (1 - ein) * -26;
    ty = (1 - ein) * 22;
    rot = (1 - ein) * 2.5;
  }
  const enter = seg(p, 0, 0.06, Easing.easeOutCubic);
  const exit = 1 - seg(p, 0.94, 1, Easing.easeInCubic);
  const scrObj = scene.opts || {};
  const dyn = {};
  if (scene.screen === "carte") {
    dyn.filter = true;
    dyn.cine = seg(p, 0.55, 0.68) > 0.5;
    dyn.sync = seg(p, 0.24, 0.4);
  }
  const spotX = (scene.corner || "bl") === "br" ? 78 : 30;
  const sweep = 34 + 10 * Math.sin(p * Math.PI * 2);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: T.bg, overflow: "hidden", opacity: enter * exit, perspective: "1800px" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, transform: `translate(${tx}px, ${ty}px) rotateY(${rot}deg)`, transformStyle: "preserve-3d" } }, /* @__PURE__ */ React.createElement(Camera, { scale, ox: tox, oy: toy }, /* @__PURE__ */ React.createElement(AppFrame, { active: scene.active, title: scene.title }, SCREENS[scene.screen]({ ...scrObj, ...dyn, p })))), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, pointerEvents: "none", background: `radial-gradient(120% 90% at ${sweep}% 8%, rgba(16,224,160,.10), transparent 42%)`, mixBlendMode: "screen" } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, pointerEvents: "none", background: `radial-gradient(70% 60% at ${spotX}% 82%, rgba(255,255,255,.06), transparent 55%)`, mixBlendMode: "screen", opacity: seg(p, 0.1, 0.3) } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 220px 60px rgba(0,0,0,.55)" } }), /* @__PURE__ */ React.createElement(Callout, { index: scene.i, total: scene.total, icon: scene.icon, title: scene.ct, desc: scene.cd, p, corner: scene.corner || "bl" }));
}
const LT = { bg: "#F1F5F3", bg2: "#E8EEEB", card: "#FFFFFF", tx: "#0B1512", tx2: "#55655E", tx3: "#8A968F", border: "rgba(11,21,18,.09)", accent: "#0FA579", accentDeep: "#047857" };
function LightBase({ p, children, tint = "tr" }) {
  const g = tint === "tr" ? "radial-gradient(circle at 84% 16%, rgba(16,224,160,.18), transparent 46%), radial-gradient(circle at 10% 92%, rgba(4,120,87,.10), transparent 42%)" : "radial-gradient(circle at 50% 8%, rgba(16,224,160,.16), transparent 52%)";
  const out = 1 - seg(p, 0.9, 1);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: `linear-gradient(160deg, ${LT.bg}, ${LT.bg2})`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.sans, padding: 90, boxSizing: "border-box", opacity: out, overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, backgroundImage: g } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, backgroundImage: `linear-gradient(rgba(11,21,18,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(11,21,18,.045) 1px,transparent 1px)`, backgroundSize: "64px 64px", maskImage: "radial-gradient(ellipse 72% 72% at 50% 50%,#000,transparent 80%)", WebkitMaskImage: "radial-gradient(ellipse 72% 72% at 50% 50%,#000,transparent 80%)" } }), children);
}
function StatScene({ scene }) {
  const { progress: p } = useScene();
  const layout = scene.layout || "hero";
  if (layout === "quote") return /* @__PURE__ */ React.createElement(QuoteScene, { scene, p });
  if (layout === "deploy") return /* @__PURE__ */ React.createElement(DeployScene, { scene, p });
  return /* @__PURE__ */ React.createElement(HeroStatScene, { scene, p });
}
function HeroStatScene({ scene, p }) {
  const enter = seg(p, 0.04, 0.2, Easing.easeOutCubic);
  const numO = seg(p, 0.12, 0.3, Easing.easeOutBack);
  const bigP = seg(p, 0.12, 0.7, Easing.easeOutCubic);
  const items = scene.items || [];
  const m = /^([^\d-]*)(-?\d+)(.*)$/.exec(scene.value || "");
  const shownNum = m ? `${m[1]}${Math.round(parseInt(m[2], 10) * bigP)}${m[3]}` : scene.value || "";
  return /* @__PURE__ */ React.createElement(LightBase, { p }, /* @__PURE__ */ React.createElement("div", { style: { position: "relative", display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 70, alignItems: "center", maxWidth: 1500, width: "100%", opacity: enter } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 16px", borderRadius: 99, background: "rgba(15,165,121,.14)", color: LT.accentDeep, fontWeight: 700, fontFamily: T.mono, fontSize: 15, letterSpacing: ".16em", textTransform: "uppercase", marginBottom: 26 } }, scene.eyebrow), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 210, fontWeight: 800, lineHeight: 0.86, letterSpacing: "-.04em", color: LT.tx, transform: `scale(${0.82 + numO * 0.18})`, transformOrigin: "left center", fontVariantNumeric: "tabular-nums" } }, shownNum), /* @__PURE__ */ React.createElement("h2", { style: { margin: "22px 0 0", fontSize: 40, fontWeight: 800, letterSpacing: "-.02em", color: LT.tx, lineHeight: 1.1, textWrap: "balance", maxWidth: 620 } }, scene.title), /* @__PURE__ */ React.createElement("p", { style: { margin: "16px 0 0", fontSize: 21, lineHeight: 1.5, color: LT.tx2, maxWidth: 560, textWrap: "pretty" } }, scene.sub)), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, items.map((it, i) => {
    const o = seg(p, 0.32 + i * 0.12, 0.5 + i * 0.12, Easing.easeOutCubic);
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 18, background: LT.card, border: `1px solid ${LT.border}`, borderRadius: 16, padding: "22px 26px", boxShadow: "0 16px 40px rgba(11,21,18,.06)", opacity: o, transform: `translateX(${(1 - o) * 30}px)` } }, /* @__PURE__ */ React.createElement("div", { style: { width: 50, height: 50, flex: "none", borderRadius: 13, background: "rgba(15,165,121,.12)", color: LT.accentDeep, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: it[0], size: 26 })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 20, fontWeight: 700, color: LT.tx } }, it[1]), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 15.5, color: LT.tx2, marginTop: 3 } }, it[2])));
  }))));
}
function QuoteScene({ scene, p }) {
  const enter = seg(p, 0.04, 0.2, Easing.easeOutCubic);
  const markO = seg(p, 0.08, 0.24, Easing.easeOutBack);
  const words = (scene.quote || "").split(" ");
  const shown = Math.round(seg(p, 0.18, 0.72, Easing.easeOutCubic) * words.length);
  const cardO = seg(p, 0.6, 0.76, Easing.easeOutCubic);
  const strip = scene.strip || [];
  return /* @__PURE__ */ React.createElement(LightBase, { p, tint: "top" }, /* @__PURE__ */ React.createElement("div", { style: { position: "relative", maxWidth: 1300, width: "100%", opacity: enter, textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 16px", borderRadius: 99, background: "rgba(15,165,121,.14)", color: LT.accentDeep, fontWeight: 700, fontFamily: T.mono, fontSize: 15, letterSpacing: ".16em", textTransform: "uppercase", marginBottom: 30 } }, scene.eyebrow || "Ils utilisent Tracky"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 150, lineHeight: 0.5, color: LT.accent, fontWeight: 800, opacity: markO, height: 60, fontFamily: "Georgia, serif" } }, "“"), /* @__PURE__ */ React.createElement("h2", { style: { margin: "0 auto", fontSize: 46, fontWeight: 700, letterSpacing: "-.02em", color: LT.tx, lineHeight: 1.28, maxWidth: 1080, textWrap: "balance" } }, words.map((w, i) => /* @__PURE__ */ React.createElement("span", { key: i, style: { color: i < shown ? LT.tx : "rgba(11,21,18,.16)", transition: "none" } }, w, i < words.length - 1 ? " " : ""))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginTop: 40, opacity: cardO, transform: `translateY(${(1 - cardO) * 16}px)` } }, /* @__PURE__ */ React.createElement("div", { style: { width: 62, height: 62, borderRadius: 99, background: "linear-gradient(135deg,#10e0a0,#047857)", color: "#04130D", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 22 } }, scene.author_initials), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "left" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 21, fontWeight: 800, color: LT.tx } }, scene.author), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 16, color: LT.tx2 } }, scene.role))), strip.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", gap: 40, marginTop: 44, opacity: cardO } }, strip.map((s, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 34, fontWeight: 800, color: LT.accentDeep, letterSpacing: "-.02em" } }, s[0]), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 15, color: LT.tx2, marginTop: 2 } }, s[1]))))));
}
function DeployScene({ scene, p }) {
  const enter = seg(p, 0.04, 0.2, Easing.easeOutCubic);
  const numO = seg(p, 0.14, 0.34, Easing.easeOutBack);
  const steps = scene.items || [];
  return /* @__PURE__ */ React.createElement(LightBase, { p, tint: "top" }, /* @__PURE__ */ React.createElement("div", { style: { position: "relative", maxWidth: 1400, width: "100%", opacity: enter, textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 16px", borderRadius: 99, background: "rgba(15,165,121,.14)", color: LT.accentDeep, fontWeight: 700, fontFamily: T.mono, fontSize: 15, letterSpacing: ".16em", textTransform: "uppercase", marginBottom: 22 } }, scene.eyebrow), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "center", gap: 22, flexWrap: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: 140, fontWeight: 800, lineHeight: 0.9, letterSpacing: "-.04em", color: LT.tx, transform: `scale(${0.84 + numO * 0.16})`, transformOrigin: "right center", display: "inline-block", whiteSpace: "nowrap", flex: "none" } }, scene.value), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 38, fontWeight: 800, color: LT.accentDeep, maxWidth: 420, textAlign: "left", lineHeight: 1.1, flex: "none" } }, scene.title)), /* @__PURE__ */ React.createElement("p", { style: { margin: "24px auto 0", fontSize: 21, lineHeight: 1.5, color: LT.tx2, maxWidth: 780, textWrap: "pretty" } }, scene.sub), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `repeat(${steps.length},1fr)`, gap: 20, marginTop: 50, position: "relative" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 30, left: "12%", right: "12%", height: 2, background: "rgba(11,21,18,.1)" } }), steps.map((it, i) => {
    const o = seg(p, 0.34 + i * 0.14, 0.52 + i * 0.14, Easing.easeOutBack);
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: o, transform: `translateY(${(1 - o) * 18}px)` } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 60, borderRadius: 99, background: LT.card, border: `2px solid ${LT.accent}`, color: LT.accentDeep, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 26px rgba(11,21,18,.08)" } }, /* @__PURE__ */ React.createElement(Icon, { name: it[0], size: 28 })), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 19, fontWeight: 700, color: LT.tx } }, it[1]), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 15, color: LT.tx2, maxWidth: 260, lineHeight: 1.4 } }, it[2]));
  }))));
}
function CNILScene({ scene }) {
  const { progress: p } = useScene();
  const pillars = [
    ["shield", "Hébergement souverain", "Serveurs en France. Aucune donnée hors UE."],
    ["lock", "Chiffrement bout-en-bout", "TLS 1.3 · chiffrement au repos · accès journalisé."],
    ["report", "RGPD by design", "DPA signable · rétention documentée · droits opérationnels."],
    ["eye", "Mode vie privée CNIL", "Trajets personnels masqués, kilométrage préservé."]
  ];
  const titO = seg(p, 0.05, 0.2);
  const out = 1 - seg(p, 0.92, 1);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: T.sans, padding: 80, opacity: out, boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement(GridBG, { p }), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", textAlign: "center", opacity: titO, marginBottom: 44, width: "100%", maxWidth: 1200 } }, /* @__PURE__ */ React.createElement(Eyebrow, null, "Conformité"), /* @__PURE__ */ React.createElement("h2", { style: { margin: "14px 0 0", fontSize: 50, fontWeight: 800, letterSpacing: "-.02em", color: T.tx, lineHeight: 1.1 } }, "Sécurité & RGPD, par conception."), /* @__PURE__ */ React.createElement("p", { style: { margin: "18px 0 0", fontSize: 23, color: T.tx2, lineHeight: 1.4 } }, "Vos données restent en France, sous votre contrôle, conformité CNIL.")), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22, maxWidth: 1160, width: "100%" } }, pillars.map((pi, i) => {
    const o = seg(p, 0.24 + i * 0.1, 0.42 + i * 0.1, Easing.easeOutCubic);
    return /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", gap: 20, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, padding: 30, opacity: o, transform: `translateY(${(1 - o) * 26}px)` } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 60, flex: "none", borderRadius: 15, background: T.accentSoft, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement(Icon, { name: pi[0], size: 30 })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", { style: { margin: 0, fontSize: 26, fontWeight: 700, color: T.tx } }, pi[1]), /* @__PURE__ */ React.createElement("p", { style: { margin: "10px 0 0", fontSize: 19, lineHeight: 1.5, color: T.tx2, textWrap: "pretty" } }, pi[2])));
  })));
}
function MaestrooScene({ scene }) {
  const { progress: p } = useScene();
  const MB = "#4d75ff";
  const titO = seg(p, 0.05, 0.2);
  const leftX = (1 - seg(p, 0.15, 0.35, Easing.easeOutExpo)) * -70;
  const rightX = (1 - seg(p, 0.15, 0.35, Easing.easeOutExpo)) * 70;
  const flow = seg(p, 0.4, 0.7, Easing.easeInOutCubic);
  const chipsO = seg(p, 0.62, 0.82);
  const out = 1 - seg(p, 0.92, 1);
  const dots = [0, 1, 2, 3];
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: T.sans, padding: 80, opacity: out, boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement(GridBG, { p }), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", textAlign: "center", opacity: titO, marginBottom: 38 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: T.mono, fontSize: 16, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: T.tx2, marginBottom: 22 } }, "Intégration ", /* @__PURE__ */ React.createElement("span", { style: { position: "relative", display: "inline-block", color: T.accent, padding: "0 6px" } }, /* @__PURE__ */ React.createElement("span", { style: { position: "absolute", left: 0, bottom: 1, height: "46%", width: `${seg(p, 0.2, 0.55, Easing.easeOutCubic) * 100}%`, background: "rgba(16,224,160,.28)", borderRadius: 3, zIndex: 0 } }), /* @__PURE__ */ React.createElement("span", { style: { position: "relative", zIndex: 1 } }, "disponible"))), /* @__PURE__ */ React.createElement("h2", { style: { margin: 0, fontSize: 56, fontWeight: 800, letterSpacing: "-.02em", color: T.tx, lineHeight: 1.05 } }, "Tracky & ", /* @__PURE__ */ React.createElement("span", { style: { color: MB } }, "Maestroo"), ", déjà connectés."), /* @__PURE__ */ React.createElement("p", { style: { margin: "18px auto 0", fontSize: 23, color: T.tx2, maxWidth: 980, textWrap: "pretty" } }, "Vous êtes une ", /* @__PURE__ */ React.createElement("strong", { style: { color: T.tx } }, "société de transport de colis"), " ? L'intégration Maestroo est ", /* @__PURE__ */ React.createElement("strong", { style: { color: T.tx } }, "disponible"), ". Vos données Tracky alimentent Maestroo en direct, sans double saisie."), /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 9, marginTop: 18, padding: "8px 16px", borderRadius: 99, background: "rgba(77,117,255,.1)", border: "1px solid rgba(77,117,255,.3)", color: MB, fontWeight: 700, fontSize: 15 } }, /* @__PURE__ */ React.createElement(Icon, { name: "truck", size: 16 }), "Partenaire dédié au transport de colis")), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", display: "flex", alignItems: "center", gap: 40 } }, /* @__PURE__ */ React.createElement("div", { style: { transform: `translateX(${leftX}px)`, opacity: seg(p, 0.15, 0.35), width: 300, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 20, padding: 34, textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", marginBottom: 16 } }, /* @__PURE__ */ React.createElement(Logo, { size: 64 })), /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 800, fontSize: 30, color: T.tx } }, "Tracky"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 16, color: T.tx2, marginTop: 6 } }, "Télématique à bord")), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", width: 200, height: 60, display: "flex", alignItems: "center", justifyContent: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 0, right: 0, top: "50%", height: 2, background: `linear-gradient(90deg, ${T.accent}, ${MB})`, opacity: 0.5 } }), dots.map((d) => {
    const dp = clamp01((flow * 1.6 % 1 - d * 0.18 + 1) % 1);
    return /* @__PURE__ */ React.createElement("div", { key: d, style: { position: "absolute", left: `${dp * 100}%`, top: "50%", transform: "translate(-50%,-50%)", width: 11, height: 11, borderRadius: 99, background: T.accent, opacity: Math.sin(dp * Math.PI), boxShadow: `0 0 12px ${T.accent}` } });
  }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: -30, left: "50%", transform: "translateX(-50%)", fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent, letterSpacing: ".08em", whiteSpace: "nowrap" } }, "API · TEMPS RÉEL")), /* @__PURE__ */ React.createElement("div", { style: { transform: `translateX(${rightX}px)`, opacity: seg(p, 0.15, 0.35), width: 300, background: "rgba(77,117,255,.08)", border: "1px solid rgba(77,117,255,.3)", borderRadius: 20, padding: 34, textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 64, height: 64, borderRadius: 16, background: MB, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 34 } }, "M")), /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 800, fontSize: 30, color: MB } }, "Maestroo"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 16, color: T.tx2, marginTop: 6 } }, "Gestion du transport de colis"))), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", display: "flex", gap: 12, marginTop: 44, opacity: chipsO } }, ["Carburant", "Kilomètres", "Scores conducteur", "Télémétrie"].map((c, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "inline-flex", alignItems: "center", gap: 9, padding: "11px 20px", borderRadius: 12, border: `1px solid ${T.border}`, background: T.surface, color: T.tx2, fontWeight: 600, fontSize: 17 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 8, height: 8, borderRadius: 99, background: T.accent } }), c))), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", marginTop: 30, opacity: chipsO, display: "inline-flex", alignItems: "center", gap: 10, fontSize: 18, color: T.tx2, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 99, padding: "10px 20px" } }, /* @__PURE__ */ React.createElement(Icon, { name: "check", size: 18, color: T.accent, sw: 2.4 }), "Facturation au km et coûts par mission, synchronisés automatiquement."));
}
function OutroScene({ scene }) {
  const { progress: p } = useScene();
  const enter = seg(p, 0.03, 0.2, Easing.easeOutCubic);
  const kO = seg(p, 0.1, 0.3, Easing.easeOutCubic);
  const lineW = seg(p, 0.22, 0.44, Easing.easeOutCubic);
  const subO = seg(p, 0.34, 0.52);
  const ctaA = seg(p, 0.5, 0.66, Easing.easeOutBack);
  const ctaB = seg(p, 0.58, 0.74, Easing.easeOutBack);
  const footO = seg(p, 0.72, 0.88);
  const logoS = interpolate(seg(p, 0.08, 0.4, Easing.easeOutBack), [0, 1], [0.6, 1]);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: `linear-gradient(155deg, #0A0F0E, #080B0A 60%)`, display: "flex", alignItems: "center", fontFamily: T.sans, overflow: "hidden", padding: "0 110px", boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 0, bottom: 0, right: 0, width: "42%", background: "radial-gradient(ellipse at 70% 50%, rgba(16,224,160,.10), transparent 70%)" } }), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 80, alignItems: "center", width: "100%", maxWidth: 1560, margin: "0 auto", opacity: enter } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 12, marginBottom: 30, opacity: kO } }, /* @__PURE__ */ React.createElement(Logo, { size: 44 }), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 800, fontSize: 30, color: T.tx, letterSpacing: "-.01em" } }, "Vizyo", /* @__PURE__ */ React.createElement("span", { style: { color: T.accent } }, " Tracky"))), /* @__PURE__ */ React.createElement("h2", { style: { margin: 0, fontSize: 68, fontWeight: 800, letterSpacing: "-.03em", color: T.tx, lineHeight: 1.02, textWrap: "balance" } }, scene.line), /* @__PURE__ */ React.createElement("div", { style: { width: `${lineW * 120}px`, height: 4, background: T.accent, borderRadius: 4, margin: "26px 0 26px" } }), /* @__PURE__ */ React.createElement("p", { style: { opacity: subO, margin: 0, fontSize: 23, color: T.tx2, lineHeight: 1.5, maxWidth: 620, textWrap: "pretty" } }, "Une équipe près de vous, basée en Occitanie. Parlez-nous de votre flotte, on vous rappelle sous 24 h avec une démo adaptée à vos véhicules."), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16, marginTop: 40, flexWrap: "nowrap" } }, /* @__PURE__ */ React.createElement("div", { style: { opacity: ctaA, transform: `scale(${0.92 + ctaA * 0.08})`, display: "inline-flex", alignItems: "center", gap: 14, background: T.accent, color: T.accentInk, fontWeight: 800, fontSize: 24, padding: "18px 34px", borderRadius: 15, boxShadow: `0 20px 50px ${T.accentSoft}`, whiteSpace: "nowrap" } }, scene.cta, /* @__PURE__ */ React.createElement(Icon, { name: "arrow", size: 24, sw: 2.4 })), /* @__PURE__ */ React.createElement("div", { style: { opacity: ctaB, transform: `scale(${0.92 + ctaB * 0.08})`, display: "inline-flex", alignItems: "center", gap: 12, background: "rgba(37,211,102,.14)", border: "1.5px solid rgba(37,211,102,.5)", color: "#25D366", fontWeight: 800, fontSize: 24, padding: "18px 32px", borderRadius: 15, whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement(Icon, { name: "chat", size: 24, sw: 2 }), "WhatsApp")), /* @__PURE__ */ React.createElement("div", { style: { opacity: footO, marginTop: 30, display: "inline-flex", alignItems: "center", gap: 10, fontFamily: T.mono, fontSize: 20, color: T.tx3, letterSpacing: ".04em" } }, /* @__PURE__ */ React.createElement(Icon, { name: "globe", size: 19, color: T.tx3, sw: 1.8 }), "tracky.vizyoagency.com")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", alignItems: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "relative", transform: `scale(${logoS})` } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: -60, borderRadius: 40, border: `1px solid ${T.border}`, opacity: 0.5 } }), /* @__PURE__ */ React.createElement("div", { style: { width: 300, height: 300, borderRadius: 36, background: "linear-gradient(150deg, #101514, #0B0F0E)", border: `1px solid ${T.border2}`, boxShadow: "0 40px 100px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22 } }, /* @__PURE__ */ React.createElement(Logo, { size: 120 }), /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 8, fontFamily: T.mono, fontSize: 14, color: T.tx2, fontWeight: 600 } }, /* @__PURE__ */ React.createElement(Icon, { name: "pin", size: 15, color: T.accent }), "Occitanie · France"))))));
}
const CHILDREN = { Intro: IntroScene, Menu: MenuScene, Service: ServiceScene, Stat: StatScene, CNIL: CNILScene, Maestroo: MaestrooScene, Outro: OutroScene };
function TrackyVideo() {
  const TWEAK_DEFAULTS = window.OM_TWEAKS || { motionEditor: true };
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SceneStage, { width: W, height: H, scenes: window.OM_SCENES, playback: window.OM_PLAYBACK, bg: T.bg }, CHILDREN), /* @__PURE__ */ React.createElement(TweaksPanel, null, /* @__PURE__ */ React.createElement(TweakSection, { label: "Lecture" }), /* @__PURE__ */ React.createElement(TweakToggle, { label: "Éditeur d'animation", value: t.motionEditor, onChange: (v) => setTweak("motionEditor", v) })));
}
window.TrackyVideo = TrackyVideo;
window.SCREENS = SCREENS;

})();
