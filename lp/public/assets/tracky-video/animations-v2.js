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
    } }, "animations-v2: the scenes prop isn't a valid JSON scene list", /* @__PURE__ */ React.createElement("br", null), "(expected '[", "{", '"name":"\u2026","dur":N', "}", ", \u2026]')");
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
