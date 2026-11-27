import React, { useEffect, useRef } from 'react';

// The analysers are smoothed, so 30 frames a second looks the same as 60 or
// 120 and costs half (or a quarter) of the drawing on a phone.
const FRAME_MS = 1000 / 30;
// With "reduce motion" on, the spectrum becomes a slow stepped readout.
const REDUCED_FRAME_MS = 500;
const MAX_PIXEL_RATIO = 3;
// Share of the analyser bins shown; the top of the range is empty for speech.
const USABLE_BINS = 0.72;

function readColours() {
  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    input: pick('--mic', '#3a6f96'),
    output: pick('--accent', '#e05528'),
    idle: pick('--ink-text', '#2a231c'),
  };
}

// Canvas spectrum: microphone (dim) behind the changed voice (accent).
// It only animates while the voice is running, the canvas is on screen and
// the tab is visible; otherwise it paints one still frame and stops.
export default function Visualizer({ getAnalysers, isRunning, hero = false }) {
  const canvasRef = useRef(null);
  const runningRef = useRef(isRunning);
  const refreshRef = useRef(() => {});

  useEffect(() => {
    runningRef.current = isRunning;
    refreshRef.current();
  }, [isRunning]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    let colours = readColours();
    let cssWidth = 0;
    let onScreen = true;
    let frame = 0;
    let timer = 0;
    let lastPaint = 0;
    let inputData = null;
    let outputData = null;

    let reducedMotion = null;
    try {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      // matchMedia missing: animate normally.
    }

    const shouldAnimate = () => runningRef.current && onScreen && !document.hidden;

    // Everything is drawn in device pixels on whole-pixel edges, so the bars
    // stay sharp on any screen density.
    const paint = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      if (W < 8 || H < 8) return;

      const ratio = W / Math.max(1, cssWidth);
      const barCount = Math.max(24, Math.min(96, Math.floor(cssWidth / 12)));
      const gap = Math.max(1, Math.round(2 * ratio));
      const barWidth = Math.max(1, Math.floor((W - gap * (barCount - 1)) / barCount));
      const left = Math.max(0, Math.floor((W - (barCount * barWidth + (barCount - 1) * gap)) / 2));
      const floor = Math.max(1, Math.round(ratio));

      const { input, output } = (runningRef.current && getAnalysers?.()) || {};

      if (!input && !output) {
        // Idle: a still, low skyline.
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = colours.idle;
        for (let i = 0; i < barCount; i++) {
          const t = i / (barCount - 1);
          const wave = 0.06 + 0.04 * Math.sin(t * 7) * Math.sin(t * 3) + 0.02 * Math.sin(t * 13);
          const h = Math.max(floor, Math.round(Math.abs(wave) * H));
          ctx.fillRect(left + i * (barWidth + gap), H - h, barWidth, h);
        }
        ctx.globalAlpha = 1;
        return;
      }

      const binCount = (output || input).frequencyBinCount;
      if (input) {
        if (!inputData || inputData.length !== input.frequencyBinCount) {
          inputData = new Uint8Array(input.frequencyBinCount);
        }
        input.getByteFrequencyData(inputData);
      }
      if (output) {
        if (!outputData || outputData.length !== output.frequencyBinCount) {
          outputData = new Uint8Array(output.frequencyBinCount);
        }
        output.getByteFrequencyData(outputData);
      }

      const layers = [
        [input ? inputData : null, colours.input, 0.38],
        [output ? outputData : null, colours.output, 0.9],
      ];
      for (const [data, colour, alpha] of layers) {
        if (!data) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colour;
        for (let i = 0; i < barCount; i++) {
          const t = i / (barCount - 1);
          const bin = Math.min(binCount - 1, Math.floor(Math.pow(t, 1.6) * binCount * USABLE_BINS));
          const h = Math.max(floor, Math.round((data[bin] / 255) * H * 0.92));
          ctx.fillRect(left + i * (barWidth + gap), H - h, barWidth, h);
        }
      }
      ctx.globalAlpha = 1;
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      frame = 0;
      timer = 0;
    };

    const tick = (now) => {
      frame = 0;
      if (!shouldAnimate()) return;
      if (now - lastPaint >= FRAME_MS - 2) {
        lastPaint = now;
        paint();
      }
      frame = requestAnimationFrame(tick);
    };

    const slowTick = () => {
      timer = 0;
      if (!shouldAnimate()) return;
      paint();
      timer = setTimeout(slowTick, REDUCED_FRAME_MS);
    };

    // Paint a correct still frame now, then animate only if there is a reason to.
    const refresh = () => {
      stop();
      paint();
      if (!shouldAnimate()) return;
      if (reducedMotion?.matches) timer = setTimeout(slowTick, REDUCED_FRAME_MS);
      else frame = requestAnimationFrame(tick);
    };
    refreshRef.current = refresh;

    // Size the backing store in device pixels. Read on resize only, never per frame.
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const w = Math.max(1, Math.round(rect.width * ratio));
      const h = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      cssWidth = rect.width;
      refresh();
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(canvas);
    // Zoom and moving between screens change the pixel ratio without resizing the box.
    window.addEventListener('resize', measure);

    let intersectionObserver = null;
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
        refresh();
      });
      intersectionObserver.observe(canvas);
    }

    document.addEventListener('visibilitychange', refresh);
    reducedMotion?.addEventListener?.('change', refresh);

    // Repaint in the new colours when the theme button flips data-theme.
    const themeObserver = new MutationObserver(() => {
      colours = readColours();
      refresh();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    measure();

    return () => {
      stop();
      refreshRef.current = () => {};
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', refresh);
      reducedMotion?.removeEventListener?.('change', refresh);
    };
  }, [getAnalysers]);

  if (hero) {
    return (
      <canvas
        ref={canvasRef}
        className="h-full min-h-[120px] w-full rounded-xl bg-surface-2/35 sm:min-h-[200px]"
        aria-hidden="true"
      />
    );
  }

  return (
    <section className="panel relative overflow-hidden p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="panel-title">Live spectrum</h2>
        <div className="flex items-center gap-4 text-xs font-medium text-muted">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-mic/60" aria-hidden="true" />
            Microphone
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-accent" aria-hidden="true" />
            Changed voice
          </span>
        </div>
      </div>
      <div className="relative mt-4">
        <canvas
          ref={canvasRef}
          className="h-44 w-full rounded-xl bg-surface-2/35 sm:h-52"
          role="img"
          aria-label={
            isRunning
              ? 'Live spectrum of your microphone and your changed voice'
              : 'Spectrum, idle'
          }
        />
        {!isRunning && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-muted">
            Press Start to see your voice here
          </p>
        )}
      </div>
    </section>
  );
}
