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
// after setup, and it stops entirely when the tab is hidden or the user has
// asked for reduced motion.

type Particle = { x: number; y: number; vx: number; vy: number; radius: number; alpha: number };

/** Deliberately modest. Density is not what makes this read as alive; motion is. */
const particleCount = 48;

/** How each state moves the field. Speed multiplies drift; pull draws toward the centre. */
const behaviour: Record<CoreState, { speed: number; pull: number; alpha: number }> = {
  idle: { speed: 1, pull: 0, alpha: 0.5 },
  listening: { speed: 1.1, pull: -0.02, alpha: 0.75 },
  thinking: { speed: 2.4, pull: 0.015, alpha: 0.9 },
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
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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

    /**
     * Paint one frame. Deliberately separate from scheduling the next one:
     * the reduced-motion path needs to repaint on resize and on becoming
     * visible without ever starting a loop.
     */
    const renderFrame = () => {
      const { speed, pull, alpha: stateAlpha } = behaviour[stateRef.current] ?? behaviour.idle;
      context.clearRect(0, 0, width, height);

      const centreX = width / 2;
      const centreY = height / 2;

      for (const particle of particles) {
        if (pull !== 0) {
          const dx = centreX - particle.x;
          const dy = centreY - particle.y;
          const distance = Math.hypot(dx, dy) || 1;
          particle.vx += (dx / distance) * pull;
          particle.vy += (dy / distance) * pull;
          // Without a cap the pull compounds every frame and the field
          // collapses into a dot within a couple of seconds.
          const speedNow = Math.hypot(particle.vx, particle.vy);
          const limit = 1.6;
          if (speedNow > limit) {
            particle.vx = (particle.vx / speedNow) * limit;
            particle.vy = (particle.vy / speedNow) * limit;
          }
        }

        particle.x += particle.vx * speed;
        particle.y += particle.vy * speed;

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

    const loop = () => {
      renderFrame();
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      if (frame === null && !reducedMotion && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    // One still frame under reduced motion: the field is present and
    // readable, and nothing moves.
    if (reducedMotion) renderFrame();
    else start();

    // Nothing to animate for a tab nobody is looking at — this is most of
    // what keeps an always-on interface from costing a background CPU core.
    // Reduced motion still repaints on return, because a canvas resized while
    // hidden comes back blank otherwise.
    const onVisibility = () => {
      if (document.hidden) stop();
      else if (reducedMotion) renderFrame();
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
      if (reducedMotion) renderFrame();
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
