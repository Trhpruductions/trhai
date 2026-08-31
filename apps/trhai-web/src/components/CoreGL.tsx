"use client";

import { useEffect, useRef, useState } from "react";
import { Core, type CoreState } from "./Core";
import { breathe, visualForState } from "./coreVisual";
import "./coregl.css";

// The core, rendered on the GPU.
//
// One quad, one fragment shader, one draw call. Three.js was considered and
// left out: a scene graph, a camera and a material system are for arranging
// objects in a space, and there are no objects here — the whole core is a
// distance field evaluated per pixel. Adding 600 kB of library to draw two
// triangles would have cost more than it did anything.
//
// Everything the reference asks for is procedural: the interior of the orb is
// domain-warped noise, the rings are analytic, the particles are hashed from
// their index, the filaments are angular noise. Nothing is a texture and
// nothing is a sprite, so the whole thing is resolution-independent and reacts
// per-frame to state and to the real audio level.
//
// It degrades rather than disappearing. No WebGL2 and a lost context both fall
// back to the SVG core, which is a complete drawing in its own right — never a
// blank rectangle where the centre of the app should be. Reduced motion is
// handled inside the loop instead, by slowing it; see the note there.

const vertexSource = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragmentSource = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform float uEnergy;
uniform float uSpin;
uniform float uConverge;
uniform float uAmplitude;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uAlive;

out vec4 fragColor;

const float TAU = 6.28318530718;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    total += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return total;
}

/* A hairline ring, anti-aliased against the pixel footprint rather than a
   fixed blur. This is what keeps the instrument crisp: a smoothstep with a
   constant width is a soft band at 380px and a fuzzy smear at 760px, which is
   why the first version of this looked out of focus on a high-DPI screen. */
float hairline(float r, float radius, float halfWidth) {
  float d = abs(r - radius) - halfWidth;
  float aa = fwidth(r) * 1.2;
  return 1.0 - smoothstep(-aa, aa, d);
}

/* A soft band, for glow rather than geometry. */
float band(float r, float radius, float thickness) {
  return smoothstep(thickness, 0.0, abs(r - radius));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  float r = length(uv);
  float angle = atan(uv.y, uv.x);

  /* Discarded early: roughly a fifth of the pixels are outside the core, and
     every one would otherwise pay for four octaves of noise. */
  if (r > 0.60) {
    fragColor = vec4(0.0);
    return;
  }

  float t = uTime;
  float energy = uEnergy;
  float amp = uAmplitude;
  float spin = t * uSpin;

  vec3 col = vec3(0.0);

  /* ---- the orb ---------------------------------------------------------
     Small and intense rather than large and soft. The interior is domain-
     warped noise so it churns, but the falloff is tight: what reads as a
     power source is a hard bright centre, not a wide haze. */
  float pulse = 1.0 + 0.09 * amp + 0.025 * sin(t * 0.9);
  float coreRadius = 0.105 * pulse;

  vec2 warp = vec2(
    fbm(uv * 7.0 + vec2(t * 0.21, t * -0.17)),
    fbm(uv * 7.0 + vec2(t * -0.13, t * 0.19) + 7.31)
  );
  float interior = fbm(uv * 11.0 + warp * 2.2 + vec2(0.0, t * 0.30));

  float orb = smoothstep(coreRadius, coreRadius * 0.1, r);
  col += uColor * orb * mix(0.85, 1.9, interior) * (1.6 + 1.2 * amp);

  /* The white-hot centre. Kept small so it reads as a source rather than
     bleaching the middle of the screen into a flat disc. */
  col += vec3(0.55, 0.85, 1.0) * smoothstep(coreRadius * 0.62, 0.0, r) * (1.5 + 1.0 * amp);
  col += vec3(1.0) * smoothstep(coreRadius * 0.45, 0.0, r) * (3.0 + 2.5 * amp);

  /* ---- the orb is a sphere, not a disc --------------------------------
     Everything above is radial, which is why the core read as a glow painted
     on glass rather than as an object sitting in the space the rings imply.
     Reconstructing a hemisphere normal from the pixel position and lighting it
     is what gives it a near side and a far side.

     The light comes from up and to the left, matching the key light in the
     room gradient behind it, so the core is lit by the same scene as
     everything else rather than by a source of its own. */
  if (r < coreRadius) {
    vec2 sphere = uv / coreRadius;
    float z = sqrt(max(0.0, 1.0 - dot(sphere, sphere)));
    vec3 normal = normalize(vec3(sphere, z));
    vec3 lightDir = normalize(vec3(-0.42, 0.46, 0.78));

    float lambert = max(0.0, dot(normal, lightDir));
    /* A terminator this soft keeps it looking like plasma rather than
       billiard-ball plastic. */
    float shaded = mix(0.72, 1.0, pow(lambert, 0.7));

    /* Fresnel: the limb of a glowing sphere is brighter than its middle,
       which is what sells it as luminous rather than merely round. */
    float limb = pow(1.0 - z, 2.4);

    /* Shading is applied gently. A lit sphere is the goal, but this one is
       also the light source in the scene — dimming it the way an opaque
       object would be lit made it read as a grey ball with a highlight, and
       cost the core the luminosity that made it worth looking at. */
    col *= mix(1.0, shaded, 0.3);
    col += uColor * limb * (2.2 + 1.4 * amp);
    col += mix(uColor, vec3(1.0), 0.6) * limb * limb * (1.2 + 0.9 * amp);
    /* A specular glint, small and offset, so the surface has a direction. */
    col += vec3(1.0) * pow(max(0.0, dot(normal, lightDir)), 42.0) * 1.4;
  }

  /* ---- the iris --------------------------------------------------------
     Blades around the orb that close as the core works harder, so the
     silhouette itself changes rather than only the colour. Driven by energy,
     which is driven by the real state and the machine's real load — an iris
     that opened and shut on a timer would be the most convincing fake here,
     because a mechanism implies a mechanism.

     Twelve blades, each a wedge whose inner edge sits at a radius set by how
     open the iris is. Analytic, so it costs a couple of instructions. */
  float blade = abs(fract(angle / TAU * 12.0) - 0.5) * 2.0;
  float irisOpen = mix(0.30, 0.16, clamp(energy + amp * 0.4, 0.0, 1.0));
  float irisEdge = irisOpen + blade * 0.028;
  float iris = smoothstep(irisEdge + 0.012, irisEdge, r) * smoothstep(coreRadius * 1.6, coreRadius * 2.6, r);
  col += uColor * iris * (0.16 + 0.3 * energy);
  /* A lit rim along each blade edge, which is what makes it read as a plate
     rather than a shadow. */
  col += mix(uColor, uAccent, 0.4) * hairline(r, irisEdge, 0.0016) * (0.7 + 0.9 * energy);

  /* ---- bloom -----------------------------------------------------------
     Two falloffs: a tight one that gives the orb its halo, and a wide faint
     one that lifts the whole instrument off the background. */
  col += uColor * exp(-r * 13.0) * (0.85 + 0.7 * amp);
  col += mix(uColor, uAccent, 0.5) * exp(-r * 4.5) * (0.16 + 0.22 * energy);

  /* ---- energy field ----------------------------------------------------
     Turbulence between the orb and the rings, pushed or pulled by uConverge
     so the field has a direction matching the work being done. Kept dim: this
     is atmosphere, and it is what turned into visible smears when it was not. */
  float flow = fbm(uv * 5.5 - vec2(0.0, t * (0.15 + 0.4 * energy)) + uConverge * r * 3.0);
  float shell = smoothstep(coreRadius, 0.30, r) * smoothstep(0.52, 0.28, r);
  col += uAccent * shell * pow(flow, 2.0) * energy * 0.42;

  /* ---- rings -----------------------------------------------------------
     Hairlines at radii that share no common multiple, each with its own
     rotation and its own gap pattern, so they never line up into a single
     spinning wheel. */
  float innerGaps = smoothstep(0.30, 0.85, abs(sin((angle + spin * 0.60) * 6.0)));
  col += uColor * hairline(r, 0.190, 0.0016) * innerGaps * (3.2 + 1.8 * energy);

  float midGaps = smoothstep(0.15, 0.70, abs(sin((angle - spin * 0.37) * 3.0)));
  col += uAccent * hairline(r, 0.268, 0.0026) * midGaps * (2.8 + 2.0 * energy);

  /* A continuous faint ring between them, so the gapped ones read as sitting
     on a dial rather than floating. */
  col += uColor * hairline(r, 0.228, 0.0008) * 1.0;

  /* Tick marks. The one element that does not rotate: without a fixed
     reference the eye has nothing to read the rotation against. */
  float ticks = smoothstep(0.80, 0.995, abs(sin(angle * 36.0)));
  col += uColor * hairline(r, 0.330, 0.0075) * ticks * 2.0;

  float majorTicks = smoothstep(0.93, 0.999, abs(sin(angle * 6.0)));
  col += uColor * hairline(r, 0.330, 0.016) * majorTicks * 2.4;

  /* ---- data ring -------------------------------------------------------
     Dashes of hashed length, counter-rotating. Irregular spacing is what
     separates a readout from a dotted line: an even dash pattern reads as
     ornament, an uneven one reads as content. */
  float dataAngle = angle * 24.0 - spin * 0.9;
  float dataCell = floor(dataAngle / TAU * 24.0);
  float dataLen = 0.35 + 0.6 * hash21(vec2(dataCell, 17.0));
  float dataMark = step(1.0 - dataLen, fract(dataAngle / TAU * 24.0));
  col += uColor * hairline(r, 0.245, 0.0035) * dataMark * 0.75;

  /* ---- the waveform ring ----------------------------------------------
     Radius modulated by the real level. With no reading this is a true
     circle, which is the honest resting state — a waveform that writhes while
     nothing is being heard is exactly the fake this build refuses. */
  float wave = sin(angle * 9.0 - t * 2.1) * 0.5 + sin(angle * 14.0 + t * 1.3) * 0.3;
  col += mix(uColor, uAccent, 0.6)
    * hairline(r, 0.386 + wave * amp * 0.05, 0.0022)
    * (0.55 + 1.5 * amp);

  /* ---- light shafts ----------------------------------------------------
     Thin volumetric rays leaving the orb, spaced by the same twelve-fold
     symmetry as the iris so they read as light escaping between the blades
     rather than as a separate decoration laid on top. */
  float shaft = pow(abs(sin(angle * 6.0)), 26.0);
  float shaftFade = smoothstep(coreRadius, coreRadius * 2.2, r) * smoothstep(0.5, 0.16, r);
  col += mix(uColor, vec3(1.0), 0.35) * shaft * shaftFade * (0.5 + 1.1 * amp + 0.5 * energy);

  /* ---- scan sweep ------------------------------------------------------
     One arm sweeping the dial, brightest at its leading edge and fading
     behind it like a radar trace. It rotates with uSpin, so it quickens when
     real work starts rather than turning at a fixed rate — this is the one
     element people read as "the machine is looking at something", and it
     would be a lie if it swept the same way while nothing was happening. */
  float sweepPhase = fract((angle - t * 0.16 * uSpin) / TAU);
  float sweepArm = pow(1.0 - sweepPhase, 7.0);
  float sweepBand = smoothstep(coreRadius, 0.17, r) * smoothstep(0.54, 0.19, r);
  col += mix(uColor, uAccent, 0.35) * sweepArm * sweepBand * (0.45 + 0.65 * energy);

  /* The leading edge itself, a hard bright line so the arm has a front. */
  col += uAccent * smoothstep(0.986, 1.0, 1.0 - sweepPhase) * sweepBand * (0.9 + 1.2 * energy);

  /* ---- filaments -------------------------------------------------------
     Thin radial threads. Both the angular frequency and the exponent are high,
     which is what makes these threads: at frequency 5 and pow 6 the same
     expression produced broad wedges that read as smudges on the glass. */
  float filament = pow(noise(vec2(angle * 26.0, t * 0.30)), 16.0);
  float filamentBand = smoothstep(coreRadius, 0.20, r) * smoothstep(0.46, 0.22, r);
  col += uAccent * filament * filamentBand * (1.0 + 1.6 * energy);

  /* ---- particles -------------------------------------------------------
     Hashed from their own index, so radii, speeds and phases all differ with
     nothing stored per particle. uConverge moves the set in or out. */
  for (int i = 0; i < 28; i++) {
    float fi = float(i);
    float seed = hash21(vec2(fi, 3.7));
    float seed2 = hash21(vec2(fi, 9.1));

    float direction = seed2 > 0.5 ? 1.0 : -1.0;
    float pa = seed * TAU + t * (0.25 + seed * 0.75) * (0.5 + energy) * direction * 0.6;

    /* Wrapped, so particles keep arriving rather than all reaching the
       destination at once and stopping there. */
    float drift = fract(seed2 + t * 0.06 * (0.4 + energy));
    float base = mix(0.20, 0.52, seed);
    float pr = uConverge >= 0.0
      ? mix(base, coreRadius + 0.02, drift * uConverge)
      : mix(base, 0.56, drift * -uConverge);

    float d = length(uv - vec2(cos(pa), sin(pa)) * pr);
    float size = 0.0013 + 0.0016 * seed2;

    /* A tight dot with its own small halo, faded at both ends of the drift so
       nothing pops in or out. */
    float life = sin(drift * 3.14159);
    col += mix(uColor, uAccent, seed) * smoothstep(size * 2.0, 0.0, d) * life * 2.2;
    col += mix(uColor, uAccent, seed) * smoothstep(size * 7.0, 0.0, d) * life * 0.35;
  }

  /* ---- outer frame -----------------------------------------------------
     Six brackets rather than a full circle: an unbroken outer ring reads as a
     loading spinner. Each is an arc plus two end caps. */
  float bracketAngle = angle + spin * 0.10;
  float brackets = smoothstep(0.88, 0.995, abs(sin(bracketAngle * 3.0)));
  col += uColor * hairline(r, 0.500, 0.0022) * brackets * 2.6;
  col += uColor * hairline(r, 0.500, 0.012) * smoothstep(0.985, 1.0, abs(sin(bracketAngle * 3.0))) * 2.6;

  /* A faint outer haze, so the frame has something to sit against. */
  col += uColor * band(r, 0.500, 0.055) * 0.05;

  /* Colour drains when the machine cannot be reached. */
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uAlive);

  /* Tonemapped on luminance rather than per channel.
     Compressing each channel separately drags every bright colour toward
     grey, because the channels converge as they approach 1. That is what made
     the first version look washed out: the rings measured [183,212,216] — a
     cyan instrument rendered almost colourless. Scaling by a luminance curve
     keeps the ratio between channels, so brightness is compressed and hue
     survives. Anything meant to read white, like the centre, is added as
     white and stays white. */
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= (lum / (lum + 0.55)) / max(lum, 0.0001);
  col = pow(col, vec3(0.90));

  fragColor = vec4(col, clamp(max(max(col.r, col.g), col.b) * 1.7, 0.0, 1.0));
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Logged rather than thrown: a driver that cannot compile this should cost
    // the user the fallback core, not the whole page.
    console.error("Core shader failed to compile:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  // Attached shaders are reference-counted by the program, so deleting them
  // here frees the sources without touching the linked result.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Core shader failed to link:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** Above 2 the extra pixels are invisible and the cost is quadratic. */
const maxPixelRatio = 2;

/**
 * Frames per second the core is drawn at.
 *
 * Everything here moves slowly on purpose — a four-second breath, rings that
 * take a minute to come round, particles drifting. None of it is improved by
 * being drawn sixty times a second, and drawing it thirty times instead is
 * close to half the cost of the whole app.
 *
 * Measured on this machine: the renderer was 31% of one core at 60fps while
 * idle. That is not a lot, but it is an app that sits open all day, and there
 * is no visible difference to pay for it with.
 *
 * The audio-reactive path is the one thing that would notice, and it does not:
 * the microphone level is smoothed over a longer window than a frame either
 * way, so the core still tracks a voice as closely as the meter does.
 */
const targetFps = 30;
const frameIntervalMs = 1000 / targetFps;

export function CoreGL({ state = "idle", size = 300, amplitude, load }: {
  state?: CoreState;
  size?: number;
  /**
   * A real loudness reading, 0..1 — the microphone's own level while
   * listening, or the neural voice's while speaking. Undefined when nothing is
   * being measured, which is what selects the breathing fallback.
   */
  amplitude?: number;
  /**
   * How hard this machine is actually working, 0..1 — the measured CPU and GPU
   * load, not the assistant's own activity.
   *
   * The core used to ignore it entirely, which left it doing exactly the same
   * thing whether the machine was asleep or pinned at 95%. Feeding the real
   * number in is the difference between a core that animates and one that is
   * plugged into something: it stirs when the machine stirs, all on its own,
   * with nobody typing. Undefined until the first telemetry arrives.
   */
  load?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Null until the first effect decides. Rendering the fallback while this is
  // null would flash the SVG core on every load.
  const [usable, setUsable] = useState<boolean | null>(null);

  // Read inside the render loop rather than captured by it, so a state change
  // steers the running animation instead of rebuilding the GL context.
  // Size lives here too, deliberately.
  //
  // It used to be an effect dependency, which meant every resize tore the GL
  // context down and built a new one. That was wasteful on its own, and at the
  // time the teardown also lost the context, which poisoned the canvas element
  // and left the rebuilt context dead. The teardown no longer does that, but
  // this stays a ref regardless: resizing a canvas does not need a new context
  // at all, since the draw loop already sets its dimensions every frame.
  const live = useRef({ state, amplitude, load, size });
  // After commit rather than during render. The draw loop reads this every
  // frame, so a value written by a render React then threw away would be
  // rendered on screen despite never having been committed.
  useEffect(() => { live.current = { state, amplitude, load, size }; });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Reduced motion calms the core; it does not switch it off.
    //
    // This used to fall back to the SVG core here, which was the wrong reading
    // of the preference twice over. The preference asks for less motion, not
    // for none — a slow glow is not what triggers vestibular symptoms, fast
    // parallax and darting movement are. And swapping to a component that has
    // its own animations was not honouring it in the first place; it just
    // traded one moving thing for another.
    //
    // It also cost the app the thing it is for. Chromium reports reduce in
    // more places than people expect, and wherever it did, the centre of the
    // screen stopped being alive at all.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.25 : 1;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      // The core sits over a dark background and never reads back its own
      // pixels, so there is nothing to gain from keeping the buffer around.
      preserveDrawingBuffer: false,
      powerPreference: "low-power"
    });

    if (!gl) {
      setUsable(false);
      return;
    }

    const program = buildProgram(gl);
    if (!program) {
      setUsable(false);
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One oversized triangle covering clip space. No other vertex data exists.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      resolution: gl.getUniformLocation(program, "uResolution"),
      time: gl.getUniformLocation(program, "uTime"),
      energy: gl.getUniformLocation(program, "uEnergy"),
      spin: gl.getUniformLocation(program, "uSpin"),
      converge: gl.getUniformLocation(program, "uConverge"),
      amplitude: gl.getUniformLocation(program, "uAmplitude"),
      color: gl.getUniformLocation(program, "uColor"),
      accent: gl.getUniformLocation(program, "uAccent"),
      alive: gl.getUniformLocation(program, "uAlive")
    };

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    setUsable(true);

    let frame: number | null = null;
    let lost = false;
    const started = performance.now();

    // Eased rather than jumped. A tool finishing flips the state in one tick,
    // and snapping every uniform at once looks like a cut between two separate
    // animations instead of one system changing what it is doing.
    let easedEnergy = 0;
    let easedSpin = 1;
    let easedConverge = 0;
    let easedAmp = 0;
    let easedAlive = 1;
    const easedColor = [0, 0, 0];
    const easedAccent = [0, 0, 0];
    let first = true;

    const approach = (current: number, target: number, rate: number) =>
      current + (target - current) * rate;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
      const pixels = Math.max(1, Math.round(live.current.size * ratio));
      if (canvas.width !== pixels || canvas.height !== pixels) {
        canvas.width = pixels;
        canvas.height = pixels;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    let lastDrawAt = 0;

    const draw = (nowMs: number) => {
      frame = null;
      if (lost) return;

      // Scheduled first, so a skipped frame still keeps the loop alive.
      frame = requestAnimationFrame(draw);

      // rAF fires at the display's rate; this decides how often the expensive
      // part actually runs.
      if (nowMs - lastDrawAt < frameIntervalMs) return;

      // How many 60fps frames this step is worth.
      //
      // Every ease below is a per-frame fraction, so halving the frame rate
      // would otherwise halve how fast the core responds — the colours would
      // drift in lazily and, worse, the amplitude would visibly lag the voice
      // driving it. Scaling by real elapsed time keeps the behaviour identical
      // at any rate. Clamped so a stall or a backgrounded window does not
      // resume with one enormous jump.
      const delta = lastDrawAt === 0
        ? 1
        : Math.min(4, (nowMs - lastDrawAt) / (1000 / 60));
      lastDrawAt = nowMs;

      /** A per-frame ease rate, corrected for the time this step covered. */
      const rate = (perFrame: number) => Math.min(1, perFrame * delta);

      resize();

      const visual = visualForState(live.current.state);
      // The machine's own load lifts the floor of the core's energy without
      // ever exceeding what a running tool shows: a busy machine should be
      // visible, and should still not look like the assistant is working when
      // it is not.
      const machine = live.current.load ?? 0;
      const targetEnergy = Math.min(1, visual.energy + machine * 0.45);
      // Time itself runs slower under reduced motion, which calms every moving
      // part at once — rings, particles, turbulence — without needing each to
      // know about the preference.
      const seconds = ((performance.now() - started) / 1000) * calm;

      // The real level whenever one exists; otherwise the breathing rhythm,
      // which is presence rather than a reading and is never shown as a number.
      // A real reading is never damped: it is the user's own voice, and
      // slowing it would make the core lag the person driving it.
      const target = live.current.amplitude ?? breathe(seconds) * 0.22;

      if (first) {
        easedEnergy = targetEnergy;
        easedSpin = visual.spin;
        easedConverge = visual.converge;
        easedAlive = visual.alive;
        easedAmp = target;
        for (let i = 0; i < 3; i += 1) {
          easedColor[i] = visual.color[i];
          easedAccent[i] = visual.accent[i];
        }
        first = false;
      } else {
        easedEnergy = approach(easedEnergy, targetEnergy, rate(0.06));
        easedSpin = approach(easedSpin, visual.spin, rate(0.05));
        easedConverge = approach(easedConverge, visual.converge, rate(0.04));
        easedAlive = approach(easedAlive, visual.alive, rate(0.05));
        // Amplitude tracks far faster: it is a live signal, and smoothing it
        // to match the colours would make the core lag the voice driving it.
        easedAmp = approach(easedAmp, target, rate(0.35));
        for (let i = 0; i < 3; i += 1) {
          easedColor[i] = approach(easedColor[i], visual.color[i], rate(0.05));
          easedAccent[i] = approach(easedAccent[i], visual.accent[i], rate(0.05));
        }
      }

      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, seconds);
      // Energy and spin are damped as well as slowed, so a busy state stays
      // legible as busy without the field becoming agitated.
      gl.uniform1f(uniforms.energy, easedEnergy * (calm < 1 ? 0.55 : 1));
      gl.uniform1f(uniforms.spin, easedSpin);
      gl.uniform1f(uniforms.converge, easedConverge);
      gl.uniform1f(uniforms.amplitude, Math.min(1, Math.max(0, easedAmp)));
      gl.uniform3f(uniforms.color, easedColor[0], easedColor[1], easedColor[2]);
      gl.uniform3f(uniforms.accent, easedAccent[0], easedAccent[1], easedAccent[2]);
      gl.uniform1f(uniforms.alive, easedAlive);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const start = () => {
      if (frame === null && !lost && !document.hidden) frame = requestAnimationFrame(draw);
    };

    const stop = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    // A hidden window gets no frames. Without this the GPU keeps drawing a core
    // nobody is looking at, which on a laptop is measurable battery.
    const onVisibility = () => (document.hidden ? stop() : start());

    // A driver reset or a GPU switch kills the context. Preventing the default
    // is what makes restoration possible at all; until it comes back the SVG
    // core stands in, rather than the middle of the screen going blank.
    const onLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      stop();
      setUsable(false);
    };

    const onRestored = () => {
      lost = false;
      first = true;
      setUsable(true);
      start();
    };

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      // Deliberately NOT calling WEBGL_lose_context.loseContext() here.
      //
      // It used to, to free the backing surface immediately rather than wait
      // for the canvas to be collected. But losing the context poisons the
      // canvas *element*, not just this context object, and React hands the
      // same element back on remount - so the next getContext returns a
      // context that is already dead. Every shader then fails to compile with
      // a null info log, setUsable(false) fires, and the core drops to the SVG
      // fallback with no visible error.
      //
      // Emptying the dependency array stopped resizes from triggering that,
      // which hid the bug in production while leaving it live anywhere React
      // legitimately remounts: StrictMode in development does mount, unmount
      // and mount again, so the core was never the WebGL one while developing
      // it. Fast Refresh does the same on every save.
      //
      // Deleting the program and buffer releases what actually accumulates.
      // The surface goes when the element does, a little later, which is a far
      // better trade than a core that is permanently dead.
    };
    // No dependencies: this builds the context once and the loop reads
    // everything that varies from `live`. Anything listed here would rebuild
    // the context on every change of it, for no gain.
  }, []);

  if (usable === false) {
    return <Core state={state} size={size} amplitude={amplitude} />;
  }

  return (
    <div className={`coregl coregl-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      <canvas ref={canvasRef} className="coregl-canvas" style={{ width: size, height: size }} />
    </div>
  );
}
