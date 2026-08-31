"use client";

import { useEffect, useRef } from "react";
import type { CoreState } from "./Core";

// The ambient field behind the core.
//
// The spec asks for particles, and particles are the one thing here at real
// risk of being decoration — motion for its own sake, which is what the core
// was deliberately built to refuse. So the field is driven by the same state
// everything else reads: it drifts almost imperceptibly at rest, quickens
// while the model is working, and pulls inward while a tool actually runs.
// Someone watching it learns something true about what the machine is doing.
//
// Canvas rather than DOM nodes: a few dozen animated elements each with their
// own compositor layer is how an "alive" interface becomes a fan spinning up.
// One canvas, one requestAnimationFrame loop, no per-particle allocation
// after setup, and it stops entirely when the tab is hidden. Reduced motion
// slows the drift rather than stopping it — see the note in the effect.

type Particle = { x: number; y: number; vx: number; vy: number; radius: number; alpha: number };

/** Deliberately modest. Density is not what makes this read as alive; motion is. */
const particleCount = 48;

/**
 * How often the field is redrawn.
 *
 * The same reasoning as the core: this drifts slowly and gains nothing from
 * sixty frames a second. Halving it is most of the cost of a canvas that is
 * open all day behind an app people leave running.
 */
const targetFps = 30;
const frameIntervalMs = 1000 / targetFps;

/** How each state moves the field. Speed multiplies drift; pull draws toward the centre. */
const behaviour: Record<CoreState, { speed: number; pull: number; alpha: number }> = {
  idle: { speed: 1, pull: 0, alpha: 0.5 },
  listening: { speed: 1.1, pull: -0.02, alpha: 0.75 },
  thinking: { speed: 2.4, pull: 0.015, alpha: 0.9 },
  // The four work states move differently because the work differs, and each
  // is entered by a real tool call. Searching pushes outward — the field is
  // going somewhere to look. Reading draws inward, slowly: something is being
  // taken in. Writing is fast and converging, output forming at the centre.
  // Analysing is tight and quick, circling the same point.
  searching: { speed: 3.2, pull: -0.05, alpha: 0.95 },
  reading: { speed: 1.5, pull: 0.02, alpha: 0.8 },
  writing: { speed: 2.8, pull: 0.04, alpha: 0.95 },
  analysing: { speed: 2.6, pull: 0.03, alpha: 0.9 },
  // Strongest inward pull: a tool is genuinely running, and the field
  // converging is the most legible way to show work happening at the centre.
  executing: { speed: 3.4, pull: 0.045, alpha: 1 },
  speaking: { speed: 1.6, pull: -0.03, alpha: 0.85 },
  success: { speed: 2, pull: -0.06, alpha: 0.9 },
  error: { speed: 0.7, pull: 0, alpha: 0.5 },
  offline: { speed: 0.25, pull: 0, alpha: 0.25 }
};

export function ParticleField({ state = "idle", className }: { state?: CoreState; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read inside the loop rather than captured, so a state change steers the
  // existing particles instead of restarting the animation.
  const stateRef = useRef<CoreState>(state);
  // After commit rather than during render: a discarded render must not be
  // able to steer the field toward a state the app never entered.
  useEffect(() => { stateRef.current = state; });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Reduced motion slows the field; it does not freeze it.
    //
    // This used to paint one still frame and stop. The intent was right and
    // the result was an app whose background was a photograph — and because
    // the core fell back at the same time, wherever Chromium reported reduce
    // nothing on the entire screen moved. Drift is scaled instead, which is
    // what the preference actually asks for: less motion, not a still image.
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const calm = reducedMotion ? 0.2 : 1;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];

    // Capped at 2: past that the pixel count grows faster than the visual
    // improvement, on exactly the high-DPI machines least able to spare it.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const seed = () => {
      particles = Array.from({ length: particleCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        radius: 0.6 + Math.random() * 1.5,
        alpha: 0.15 + Math.random() * 0.5
      }));
    };

    resize();
    seed();

    // The accent, read once from the cascade so the field follows the theme
    // rather than hardcoding a colour the rest of the HUD can change.
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim() || "#35c7ff";

    let frame: number | null = null;

    /** Paint one frame. Separate from scheduling the next so a repaint can be
     *  forced without touching the loop. */
    const renderFrame = (delta = 1) => {
      const { speed, pull, alpha: stateAlpha } = behaviour[stateRef.current] ?? behaviour.idle;
      context.clearRect(0, 0, width, height);

      const centreX = width / 2;
      const centreY = height / 2;

      for (const particle of particles) {
        if (pull !== 0) {
          const dx = centreX - particle.x;
          const dy = centreY - particle.y;
          const distance = Math.hypot(dx, dy) || 1;
          particle.vx += (dx / distance) * pull * calm * delta;
          particle.vy += (dy / distance) * pull * calm * delta;
          // Without a cap the pull compounds every frame and the field
          // collapses into a dot within a couple of seconds.
          const speedNow = Math.hypot(particle.vx, particle.vy);
          const limit = 1.6;
          if (speedNow > limit) {
            particle.vx = (particle.vx / speedNow) * limit;
            particle.vy = (particle.vy / speedNow) * limit;
          }
        }

        particle.x += particle.vx * speed * calm * delta;
        particle.y += particle.vy * speed * calm * delta;

        // Wrap rather than respawn: a particle vanishing at an edge and
        // reappearing elsewhere reads as a glitch.
        if (particle.x < -4) particle.x = width + 4;
        if (particle.x > width + 4) particle.x = -4;
        if (particle.y < -4) particle.y = height + 4;
        if (particle.y > height + 4) particle.y = -4;

        context.globalAlpha = particle.alpha * stateAlpha;
        context.fillStyle = accent;
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
    };

    let lastDrawAt = 0;

    const loop = (nowMs: number) => {
      frame = requestAnimationFrame(loop);
      if (nowMs - lastDrawAt < frameIntervalMs) return;

      // Drift is per-frame, so a slower loop would move the field more slowly
      // rather than the same distance less often. This keeps the speed the
      // same at any rate; clamped so a stalled tab does not resume with every
      // particle teleporting.
      const delta = lastDrawAt === 0 ? 1 : Math.min(4, (nowMs - lastDrawAt) / (1000 / 60));
      lastDrawAt = nowMs;
      renderFrame(delta);
    };

    const start = () => {
      if (frame === null && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    start();

    // Nothing to animate for a tab nobody is looking at — this is most of
    // what keeps an always-on interface from costing a background CPU core.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Resizing clears the backing store, so the still frame has to be redrawn
    // or it stays empty. Caught live: the canvas is laid out at zero size on
    // first mount and only gets real dimensions from this observer, so the
    // reduced-motion field never appeared at all.
    const observer = new ResizeObserver(() => {
      resize();
      seed();
    });
    observer.observe(canvas);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
