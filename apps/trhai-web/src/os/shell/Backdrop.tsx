"use client";

import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import type { CoreState } from "../../components/Core";
import { visualForState } from "../../components/coreVisual";
import { useAssistantState, useLevels, useVoice } from "../state/assistant";
import { keyArt, onScreen, placeCovering, placeOnCore, samePlacement, type Placement } from "./artPlacement";
import "./backdrop.css";

// The room TRH AI lives in: the key art, full-bleed behind the whole shell.
//
// On Home the art is placed so its globe sits exactly under the live core -
// the core is drawn as that globe, and the art's beam and lit pedestal finish
// it off below - and it follows the core through scrolling, resizing and the
// sidebar folding. Every other workspace keeps the same scene behind a deeper
// scrim, so there is always somewhere, never a flat colour.
//
// Over the art, a light layer keeps the scene alive without competing with
// anything: stars that twinkle, motes of light carried between the floor and
// the globe, the pedestal glowing under the core, rings across the floor when
// the voice speaks, and packets running the beam while work is under way.
// All of it follows the core's real state and the real voice level - the same
// readings the core uses (coreVisual) - so nothing here moves for show.

/** Lets the Home core say where it is, so the art's globe can be put under it. */
const AnchorContext = createContext<(element: HTMLElement | null) => void>(() => {});
export const BackdropAnchorProvider = AnchorContext.Provider;
export function useBackdropAnchor(): (element: HTMLElement | null) => void {
  return useContext(AnchorContext);
}

type Drive = { core: CoreState; amplitude: number | undefined; home: boolean; anchor: HTMLElement | null };

/** Reads the level that changes every frame, so Backdrop itself never re-renders for it. */
function Driver({ driveRef }: { driveRef: RefObject<Drive> }) {
  const { core } = useAssistantState();
  const { micAmplitude, speechAmplitude } = useLevels();
  const { mic, speech } = useVoice();
  const amplitude = mic.listening ? micAmplitude : speech.speaking ? speechAmplitude : undefined;
  useEffect(() => {
    driveRef.current.core = core;
    driveRef.current.amplitude = amplitude;
  });
  return null;
}

type Star = { x: number; y: number; size: number; base: number; speed: number; phase: number };
type Mote = { x0: number; y0: number; x1: number; y1: number; sway: number; age: number; life: number; size: number; tint: number };

/** A fixed sky: the same stars every load, from a seeded generator. */
function makeStars(count: number): Star[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random() * 0.72,
    size: 0.5 + random() * 1.1,
    base: 0.25 + random() * 0.5,
    speed: 0.3 + random() * 1.4,
    phase: random() * Math.PI * 2
  }));
}

function glowSprite(): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 32;
  const context = sprite.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.18, "rgba(200,235,255,0.85)");
    gradient.addColorStop(0.45, "rgba(120,190,255,0.22)");
    gradient.addColorStop(1, "rgba(120,190,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
  }
  return sprite;
}

const rgb = (color: number[], alpha: number) =>
  `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;

/** The ambient layer is drawn this often; the art itself tracks every frame. */
const ambientFps = 24;
/** How long the art takes to move between workspaces. */
const glideMs = 700;

export function Backdrop({ anchor, home }: { anchor: HTMLElement | null; home: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drive = useRef<Drive>({ core: "idle", amplitude: undefined, home, anchor });

  useEffect(() => {
    drive.current.home = home;
    drive.current.anchor = anchor;
  }, [home, anchor]);

  useEffect(() => {
    const layer = root.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!layer || !canvas || !context) return;

    // Slower and quieter, never stopped: see the same note in CoreGL.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.3 : 1;
    const sprite = glowSprite();
    const stars = makeStars(150);
    const motes: Mote[] = [];
    const started = performance.now();

    // Only shown once the image is in and the first placement is known, so it
    // never flashes up somewhere else first.
    let artLoaded = false;
    const image = new Image();
    image.onload = () => { artLoaded = true; };
    image.src = keyArt.src;

    let frame: number | null = null;
    let lastDraw = 0;
    let shown: Placement | null = null;
    let seenAnchor: HTMLElement | null | undefined;
    let seenHome: boolean | undefined;
    let glide: { from: Placement; started: number } | null = null;
    let revealed = false;
    let scrollRange = -1;
    let workspace: HTMLElement | null = null;

    // Eased like the core's own values, so the room changes with it.
    let energy = 0.2;
    let converge = 0;
    let traffic = 0;
    let ripple = 0;
    let amp = 0;
    let presence = drive.current.home ? 1 : 0;
    const color = [0.21, 0.78, 1.0];

    const place = (now: number) => {
      const { anchor: core, home: onHome } = drive.current;
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (!workspace?.isConnected) workspace = document.getElementById("os-workspace");
      const box = core?.isConnected ? core.getBoundingClientRect() : null;

      // On Home the art scrolls with the workspace, and the browser does the
      // moving (backdrop.css): a script moving it a frame behind the browser's
      // own scrolling left the art trailing the core whenever Home scrolled.
      // So this places it as if Home were scrolled to the top, and says how
      // far Home can scroll; the scroll itself is applied in step with the
      // content, off the main thread.
      const range = onHome && workspace ? Math.max(0, workspace.scrollHeight - workspace.clientHeight) : 0;
      if (range !== scrollRange) {
        scrollRange = range;
        layer.style.setProperty("--workspace-scroll", `${range}px`);
      }

      let target: Placement;
      if (box && box.width > 0) {
        const scrolled = onHome && workspace ? workspace.scrollTop : 0;
        target = placeOnCore({ left: box.left, top: box.top + scrolled, width: box.width, height: box.height });
      } else {
        const column = layer.parentElement?.querySelector(".os-main")?.getBoundingClientRect();
        target = placeCovering({ width, height }, column ? { left: column.left, width: column.width } : { left: 0, width });
      }

      // Moving between workspaces glides, over a fixed time that always ends
      // exactly on the target - even one that moves meanwhile. Everything
      // else (resizing, the sidebar folding) tracks exactly.
      if (seenAnchor !== undefined && shown && (core !== seenAnchor || onHome !== seenHome)) {
        glide = { from: shown, started: now };
      }
      seenAnchor = core;
      seenHome = onHome;

      let next = target;
      if (glide) {
        const progress = Math.min(1, (now - glide.started) / glideMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        next = {
          x: glide.from.x + (target.x - glide.from.x) * eased,
          y: glide.from.y + (target.y - glide.from.y) * eased,
          scale: glide.from.scale + (target.scale - glide.from.scale) * eased
        };
        if (progress >= 1) glide = null;
      }
      if (artLoaded && !revealed) {
        revealed = true;
        layer.classList.add("os-backdrop-ready");
      }
      if (samePlacement(shown, next)) return;
      shown = next;
      const globe = onScreen(next, keyArt.globeX, keyArt.globeY);
      layer.style.setProperty("--art-x", `${next.x.toFixed(2)}px`);
      layer.style.setProperty("--art-y", `${next.y.toFixed(2)}px`);
      layer.style.setProperty("--art-s", next.scale.toFixed(5));
      layer.style.setProperty("--globe-x", `${globe.x.toFixed(1)}px`);
      layer.style.setProperty("--globe-y", `${globe.y.toFixed(1)}px`);
      layer.style.setProperty("--globe-r", `${(keyArt.globeR * next.scale).toFixed(1)}px`);
    };

    const spawnMote = (): Mote => {
      // From the floor around the pedestal, to somewhere on the globe.
      const angle = Math.random() * Math.PI * 2;
      const reach = 70 + Math.random() * 330;
      const toward = Math.random() * Math.PI * 2;
      const into = Math.random() * keyArt.globeR * 0.85;
      return {
        x0: keyArt.globeX + Math.cos(angle) * reach,
        y0: keyArt.pedestalY + Math.sin(angle) * reach * 0.22,
        x1: keyArt.globeX + Math.cos(toward) * into,
        y1: keyArt.globeY + Math.sin(toward) * into,
        sway: (Math.random() - 0.5) * 120,
        age: 0,
        life: 5 + Math.random() * 6,
        size: 0.9 + Math.random() * 1.5,
        tint: Math.random()
      };
    };

    const drawAmbient = (now: number) => {
      const delta = lastDraw === 0 ? 1 : Math.min(4, (now - lastDraw) / (1000 / 60));
      const seconds = lastDraw === 0 ? 0 : Math.min(0.2, (now - lastDraw) / 1000);
      lastDraw = now;
      const rate = (perFrame: number) => Math.min(1, perFrame * delta);
      const time = ((now - started) / 1000) * calm;

      const width = window.innerWidth;
      const height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
      const pixelsWide = Math.round(width * ratio);
      const pixelsHigh = Math.round(height * ratio);
      if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
        canvas.width = pixelsWide;
        canvas.height = pixelsHigh;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!shown) return;
      // Settings > Appearance: only the living scene moves.
      const mode = document.documentElement.getAttribute("data-backdrop");
      if (mode === "still" || mode === "plain") return;

      const { core, amplitude, home: onHome } = drive.current;
      const visual = visualForState(core);
      energy += (visual.energy - energy) * rate(0.05);
      converge += (visual.converge - converge) * rate(0.04);
      traffic += (visual.traffic - traffic) * rate(0.04);
      ripple += (visual.ripple - ripple) * rate(0.06);
      amp += ((amplitude ?? 0) - amp) * rate(0.35);
      presence += ((onHome ? 1 : 0) - presence) * rate(0.06);
      for (let i = 0; i < 3; i += 1) color[i] += (visual.color[i] - color[i]) * rate(0.05);
      // Behind a workspace the room is still there, only quieter.
      const dim = 0.45 + 0.55 * presence;
      const level = Math.min(1, Math.max(0, amp));

      context.globalCompositeOperation = "lighter";

      // Stars, fixed to the window rather than the art, so the sky fills it.
      for (const star of stars) {
        const twinkle = 0.5 + 0.5 * Math.sin(time * star.speed + star.phase);
        const alpha = star.base * (0.3 + 0.7 * twinkle * twinkle * twinkle) * dim;
        const radius = star.size * 2.6;
        context.globalAlpha = alpha;
        context.drawImage(sprite, star.x * width - radius, star.y * height - radius, radius * 2, radius * 2);
      }
      context.globalAlpha = 1;

      // Where the art is on screen right now: on Home it is scrolled with the
      // workspace by the browser (see place), so the same scroll applies here.
      const scale = shown.scale;
      const lift = onHome && workspace ? workspace.scrollTop : 0;
      const placed: Placement = { x: shown.x, y: shown.y - lift, scale };
      const pedestal = onScreen(placed, keyArt.globeX, keyArt.pedestalY);
      const globe = onScreen(placed, keyArt.globeX, keyArt.globeY);

      // The pedestal, lit from above by the core: a little at rest, more with
      // the work, and most of all with a voice.
      const lit = (0.08 + 0.2 * energy + 0.65 * level) * (0.35 + 0.65 * presence) * (visual.alive ? 1 : 0.4);
      context.save();
      context.translate(pedestal.x, pedestal.y);
      context.scale(1, 0.2);
      const pool = context.createRadialGradient(0, 0, 0, 0, 0, 320 * scale);
      pool.addColorStop(0, rgb(color, lit));
      pool.addColorStop(0.35, rgb(color, lit * 0.45));
      pool.addColorStop(1, rgb(color, 0));
      context.fillStyle = pool;
      context.beginPath();
      context.arc(0, 0, 320 * scale, 0, Math.PI * 2);
      context.fill();
      context.restore();

      // Rings across the floor while the voice speaks (out) or listens (in).
      // Their brightness is the real level, so silence draws none. Drawn as
      // ellipses rather than squashed circles, so the line keeps one width.
      const ringStrength = Math.abs(ripple) * (0.15 + 1.3 * level) * presence;
      if (ringStrength > 0.01) {
        context.lineWidth = 1.4;
        for (let k = 0; k < 3; k += 1) {
          const life = (time * 0.38 + k / 3) % 1;
          const travel = ripple > 0 ? life : 1 - life;
          const radius = (60 + 380 * travel) * scale;
          context.strokeStyle = rgb(color, Math.sin(life * Math.PI) * (1 - 0.55 * travel) * ringStrength * 0.6);
          context.beginPath();
          context.ellipse(pedestal.x, pedestal.y, radius, radius * 0.2, 0, 0, Math.PI * 2);
          context.stroke();
        }
      }

      // Packets on the beam while work is under way: up into the core when it
      // is taking things in, down from it when it is putting things out.
      if (traffic > 0.2 && presence > 0.05) {
        const top = globe.y + keyArt.globeR * scale;
        const span = pedestal.y - top;
        for (let k = 0; k < 3; k += 1) {
          const life = (time * (0.45 + 0.25 * energy) + k / 3) % 1;
          const at = converge >= 0 ? 1 - life : life;
          const y = top + span * at;
          const length = 26 * scale;
          const beam = context.createLinearGradient(0, y - length, 0, y + length);
          beam.addColorStop(0, rgb(color, 0));
          beam.addColorStop(0.5, `rgba(235,250,255,${(Math.sin(life * Math.PI) * (traffic - 0.2) * presence).toFixed(3)})`);
          beam.addColorStop(1, rgb(color, 0));
          context.fillStyle = beam;
          context.fillRect(pedestal.x - 1.5, y - length, 3, length * 2);
        }
      }

      // Motes between the floor and the globe: more and quicker with the work,
      // drawn in when it is taking in, sent out when it is searching outward.
      const wanted = Math.round((10 + 38 * energy) * (0.5 + 0.5 * presence) * calm);
      while (motes.length < wanted) {
        const mote = spawnMote();
        mote.age = Math.random() * mote.life;
        motes.push(mote);
      }
      const pace = 0.55 + energy;
      for (let i = motes.length - 1; i >= 0; i -= 1) {
        const mote = motes[i];
        mote.age += seconds * pace * calm;
        if (mote.age >= mote.life) {
          if (motes.length > wanted) motes.splice(i, 1);
          else motes[i] = spawnMote();
          continue;
        }
        const life = mote.age / mote.life;
        const along = converge >= -0.1 ? life : 1 - life;
        const eased = along * along * (3 - 2 * along);
        const artX = mote.x0 + (mote.x1 - mote.x0) * eased + Math.sin(along * Math.PI) * mote.sway;
        const artY = mote.y0 + (mote.y1 - mote.y0) * eased;
        const point = onScreen(placed, artX, artY);
        const radius = mote.size * Math.max(0.8, scale) * 2.4;
        context.globalAlpha = Math.sin(life * Math.PI) * (0.35 + 0.5 * energy) * dim * (visual.alive ? 1 : 0.3);
        context.drawImage(sprite, point.x - radius, point.y - radius, radius * 2, radius * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      place(now);
      if (now - lastDraw >= 1000 / ambientFps) drawAmbient(now);
    };

    const start = () => {
      if (frame === null && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      image.onload = null;
    };
    // Built once: the loop reads everything that varies from `drive`.
  }, []);

  return (
    <div ref={root} className="os-backdrop" data-mode={home ? "home" : "work"} aria-hidden="true">
      <Driver driveRef={drive} />
      {/* Everything that belongs to the art and scrolls with Home. */}
      <div className="os-art-track">
        <div className="os-art" />
        <div className="os-scrim os-scrim-globe" />
      </div>
      <div className="os-scrim os-scrim-home" />
      <div className="os-scrim os-scrim-work" />
      <canvas ref={canvasRef} className="os-ambient" />
    </div>
  );
}
