"use client";

import { useEffect, useRef, useState } from "react";
import { Core, type CoreState } from "./Core";
import { coreGlobeFraction } from "./coreGeometry";
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
// It is drawn as the globe in the app's key art (public/trh-background.png):
// a see-through sphere of points joined to their neighbours, a bright limb, an
// orbit ring around its waist and HUD arcs around that. On the dashboard it sits
// exactly over the art's own globe, so the two read as one object - the art's
// beam and floor finish it off below. It was a radar dial before, drawn on top
// of a globe it looked nothing like.
//
// Everything is procedural: the network is a 3D cell field on the sphere, the
// rings are analytic, the particles are hashed from their index. Nothing is a
// texture and nothing is a sprite, so the whole thing is resolution-independent
// and reacts per-frame to state and to the real audio level.
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
/* How far the globe has turned. Integrated from the state's spin on the CPU,
   so a change of state changes the speed and never jumps the angle - time
   multiplied by a changing speed spun everything wildly for a second at every
   transition. */
uniform float uPhase;
uniform float uEnergy;
uniform float uConverge;
uniform float uAmplitude;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uAlive;
/* What kind of work is going on (coreVisual), eased on the CPU like the rest:
   signals along the network's links, rings leaving or arriving, a sweep round
   the instrument, and the drawing slipping when something has failed. */
uniform float uTraffic;
uniform float uRipple;
uniform float uScan;
uniform float uGlitch;

out vec4 fragColor;

const float TAU = 6.28318530718;
/* The key art's few warm marks among the blue. Fixed rather than per state:
   they are part of the drawing, not a reading. */
const vec3 WARM = vec3(1.0, 0.56, 0.24);
/* The sphere the network lives on, in cell units: about 140 points in all. */
const float NET_SCALE = 3.2;
/* The globe's radius as a share of the canvas. Shared with the page, which
   lines the key art's own globe up exactly under this one (artPlacement.ts). */
const float GLOBE = ${coreGlobeFraction.toFixed(4)};

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

/* Smooth value noise, for the light moving inside the globe. */
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash31(i);
  float b = hash31(i + vec3(1.0, 0.0, 0.0));
  float c = hash31(i + vec3(0.0, 1.0, 0.0));
  float d = hash31(i + vec3(1.0, 1.0, 0.0));
  float e = hash31(i + vec3(0.0, 0.0, 1.0));
  float g = hash31(i + vec3(1.0, 0.0, 1.0));
  float h = hash31(i + vec3(0.0, 1.0, 1.0));
  float k = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

/* The globe's own frame: its axis leans toward the viewer, the way the art's
   does, and it turns about that axis by phase. */
mat3 globeFrame(float phase) {
  float ct = cos(0.40), st = sin(0.40);
  float cp = cos(phase), sp = sin(phase);
  mat3 tilt = mat3(1.0, 0.0, 0.0, 0.0, ct, st, 0.0, -st, ct);
  mat3 turn = mat3(cp, 0.0, -sp, 0.0, 1.0, 0.0, sp, 0.0, cp);
  return turn * tilt;
}

/* One link of the network, from a to b, following the sphere's surface.
   Only neighbours are joined, as in the art: a long link fades out.
   x is the line itself, y a signal running along it. */
vec2 link(vec3 q, vec3 a, vec3 b, float px, float time) {
  /* Each link runs one way whichever end a pixel happens to be nearer -
     otherwise the half of it nearer b would carry its signal backwards. */
  if (dot(a, vec3(1.0, 57.0, 113.0)) > dot(b, vec3(1.0, 57.0, 113.0))) {
    vec3 swap = a;
    a = b;
    b = swap;
  }
  vec3 ab = b - a;
  float len = length(ab);
  float keep = smoothstep(1.25, 0.80, len);
  if (keep <= 0.0) return vec2(0.0);
  float h = clamp(dot(q - a, ab) / (len * len), 0.0, 1.0);
  vec3 c = a + ab * h;
  c *= NET_SCALE / length(c);
  float d = length(q - c);
  float line = keep * (1.0 - smoothstep(0.35 * px, 1.5 * px, d));

  /* Only some links carry a signal at once - more as the work does - each at
     its own pace from its own start. A sharp head and a long tail behind it,
     so which way it is going reads at a glance. */
  vec3 seed = hash33(a + b + 0.37);
  if (seed.x >= uTraffic) return vec2(line, 0.0);
  float head = fract(time * (0.22 + 0.5 * seed.y) + seed.z);
  float behind = (head - h) * len;
  float along = behind >= 0.0 ? exp(-behind * 6.0) : exp(behind * 55.0);
  float across = 1.0 - smoothstep(0.0, 3.5 * px, d);
  /* Faded in and out at the nodes, so a signal leaves and arrives rather than
     appearing out of nothing. */
  return vec2(line, keep * across * along * sin(head * 3.14159));
}

/* The network at one point of the sphere: x is links, y is nodes, z signals.
   s is a unit vector in the globe's frame and px the size of a pixel there.

   Points come from a 3D cell field, each cell holding one, and only points
   lying near the surface count - otherwise the cells inside the sphere would
   pile their points onto it too. The four nearest are joined to each other,
   which draws every short link in full: wherever a link passes, both of its
   ends are among the four nearest points. */
vec3 network(vec3 s, float px, float time) {
  vec3 q = s * NET_SCALE;
  vec3 base = floor(q);
  vec3 p0 = vec3(0.0), p1 = vec3(0.0), p2 = vec3(0.0), p3 = vec3(0.0);
  float d0 = 1e3, d1 = 1e3, d2 = 1e3, d3 = 1e3;
  float seed0 = 0.0;

  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 cell = base + vec3(float(x), float(y), float(z));
        vec3 h = hash33(cell);
        vec3 f = cell + h;
        float lf = length(f);
        if (abs(lf - NET_SCALE) > 0.55) continue;
        f *= NET_SCALE / lf;
        float d = length(q - f);
        if (d >= d3) continue;
        if (d < d0) { p3 = p2; d3 = d2; p2 = p1; d2 = d1; p1 = p0; d1 = d0; p0 = f; d0 = d; seed0 = h.x; }
        else if (d < d1) { p3 = p2; d3 = d2; p2 = p1; d2 = d1; p1 = f; d1 = d; }
        else if (d < d2) { p3 = p2; d3 = d2; p2 = f; d2 = d; }
        else { p3 = f; d3 = d; }
      }
    }
  }

  vec2 lines = vec2(0.0);
  if (d1 < 1e2) lines = max(lines, link(q, p0, p1, px, time));
  if (d2 < 1e2) {
    lines = max(lines, link(q, p0, p2, px, time));
    lines = max(lines, link(q, p1, p2, px, time));
  }
  if (d3 < 1e2) {
    lines = max(lines, link(q, p0, p3, px, time));
    lines = max(lines, link(q, p1, p3, px, time));
    lines = max(lines, link(q, p2, p3, px, time));
  }

  /* Each node a hard dot with a small halo, twinkling on its own clock. */
  float twinkle = 0.55 + 0.45 * sin(time * (0.7 + 1.6 * seed0) + seed0 * TAU);
  float nodes = 0.0;
  if (d0 < 1e2) {
    nodes = (1.0 - smoothstep(0.7 * px, 1.8 * px, d0)) * 1.3
      + exp(-d0 * d0 / (2.0 * pow(4.0 * px, 2.0))) * 0.45;
    nodes *= twinkle;
  }
  return vec3(lines.x, nodes, lines.y);
}

/* Distance to an ellipse, close enough for a hairline (Quilez's estimate). */
float ellipseDistance(vec2 p, vec2 radii) {
  float k0 = length(p / radii);
  float k1 = max(length(p / (radii * radii)), 1e-5);
  return k0 * (k0 - 1.0) / k1;
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

  /* A fault: now and then, bands of the drawing slip sideways. Only now and
     then - a constant shake reads as a broken GPU, not a failed task. */
  if (uGlitch > 0.01) {
    float slot = floor(uTime * 6.0);
    float now = step(0.68, hash21(vec2(slot, 3.1)));
    float row = floor(uv.y * 24.0);
    float slip = (hash21(vec2(row, slot)) - 0.5) * step(0.55, hash21(vec2(row, slot + 9.0)));
    uv.x += slip * 0.05 * uGlitch * now;
  }

  float r = length(uv);
  float angle = atan(uv.y, uv.x);

  /* Discarded early: the corners are outside everything drawn here. */
  if (r > 0.60) {
    fragColor = vec4(0.0);
    return;
  }

  float t = uTime;
  float energy = uEnergy;
  float amp = uAmplitude;
  float spin = uPhase;
  float pixel = 1.0 / min(uResolution.x, uResolution.y);

  vec3 col = vec3(0.0);

  /* ---- the globe ---------------------------------------------------------
     Large, like the art's, and transparent: the far side of the network shows
     through the near side, dimmer, which is what makes it read as a sphere of
     light rather than a picture of one. A real level swells it slightly - the
     voice moving the globe - and with no reading it only breathes. */
  float R = GLOBE * (1.0 + 0.035 * amp + 0.006 * sin(t * 0.9));
  float inDisc = 1.0 - smoothstep(R - 1.5 * pixel, R + 1.5 * pixel, r);

  vec2 onDisc = uv / R;
  float z = sqrt(max(0.0, 1.0 - dot(onDisc, onDisc)));
  if (inDisc > 0.0) {
    mat3 frame = globeFrame(spin);
    /* A pixel's size on the network's sphere, which grows toward the limb as
       the surface turns away - so links keep one width on screen. */
    float px = NET_SCALE * pixel / R / max(z, 0.22);
    vec3 near = network(frame * vec3(onDisc, z), px, t);
    vec3 far = network(frame * vec3(onDisc, -z), px, t);

    /* Quieter in the middle, behind the TRH AI mark, so the mark stays legible. */
    float hush = mix(0.5, 1.0, smoothstep(0.08, 0.5, length(onDisc)));
    vec3 linkColor = mix(uColor, vec3(0.80, 0.95, 1.0), 0.22);
    col += linkColor * near.x * (0.85 + 0.55 * energy) * hush * inDisc;
    col += mix(uColor, vec3(1.0), 0.55) * near.y * (1.25 + 0.8 * energy + 1.3 * amp) * hush * inDisc;
    col += uColor * (far.x * 0.32 + far.y * 0.5) * hush * inDisc;

    /* Signals: the brightest things on the network, nearly white at the head.
       The far side's show through, dimmer, like everything else there. */
    vec3 signalColor = mix(uAccent, vec3(1.0), 0.45);
    col += signalColor * near.z * (1.5 + 1.2 * energy) * mix(0.65, 1.0, hush) * inDisc;
    col += signalColor * far.z * 0.4 * hush * inDisc;

    /* Light moving inside: a slow cloud sampled at three depths through the
       globe, so it has volume and turns with it. Faint at rest; the work
       thickens it and a voice brightens it. */
    float cloud = 0.0;
    for (int i = 0; i < 3; i++) {
      vec3 p = frame * vec3(onDisc, (float(i) - 1.0) * 0.6 * z) * 1.7 + vec3(0.0, t * 0.05, t * 0.035);
      cloud += noise3(p) * 0.62 + noise3(p * 2.1 + 4.3) * 0.38;
    }
    cloud = smoothstep(0.45, 0.85, cloud / 3.0);
    col += mix(uColor, uAccent, cloud) * cloud * z * (0.12 + 0.26 * energy + 0.6 * amp) * hush * inDisc;
  }

  /* The limb: a sphere of light is brightest at its edge. */
  float limb = pow(1.0 - z, 3.0);
  col += uColor * limb * (1.3 + 0.9 * energy + 1.4 * amp) * inDisc;
  col += mix(uColor, vec3(1.0), 0.45) * hairline(r, R, 0.0011) * (1.1 + 0.9 * amp);
  /* A soft light at the heart, under the mark, that a voice brightens. */
  col += mix(uColor, vec3(1.0), 0.3) * exp(-r * r / 0.0045) * (0.28 + 0.55 * amp);
  /* And a halo just outside the edge. */
  col += uColor * exp(-max(r - R, 0.0) * 20.0) * (1.0 - inDisc) * (0.30 + 0.30 * energy + 0.45 * amp);

  /* ---- the orbit ------------------------------------------------------------
     Rings around the globe's waist, seen from a little above as in the art:
     the near half crosses in front of the globe and the far half passes behind
     it, where only a trace shows through. Dashes run round the main ring at the
     globe's own speed. */
  /* Centred a little below the globe's middle, so the rings wrap its lower half. */
  vec2 e = mat2(cos(0.08), -sin(0.08), sin(0.08), cos(0.08)) * (uv + vec2(0.0, 0.07));
  float behind = step(0.0, e.y) * inDisc;
  float orbitAngle = atan(e.y / 0.17, e.x);
  float orbitDash = step(0.42, fract(orbitAngle / TAU * 22.0 - spin * 0.55));

  float orbitMain = 1.0 - smoothstep(0.0, 1.6 * pixel, abs(ellipseDistance(e, vec2(0.44, 0.44 * 0.17))));
  float orbitOuter = 1.0 - smoothstep(0.0, 1.2 * pixel, abs(ellipseDistance(e, vec2(0.475, 0.475 * 0.17))));
  float orbitGlow = exp(-abs(ellipseDistance(e, vec2(0.44, 0.44 * 0.17))) * 60.0);
  float occlusion = mix(1.0, 0.16, behind);
  col += mix(uColor, vec3(1.0), 0.3) * orbitMain * mix(0.55, 1.0, orbitDash) * (1.2 + 0.8 * energy) * occlusion;
  col += uColor * orbitOuter * 0.55 * occlusion;
  col += uColor * orbitGlow * (0.22 + 0.25 * energy) * occlusion;

  /* ---- HUD arcs ------------------------------------------------------------
     Concentric arcs around the globe, as in the art: a fine ring hugging it,
     broken arcs turning with it, a scale that stays still so the turning has
     something to be read against, and a readout of uneven dashes. Hairlines
     at radii that share no common multiple, so they never line up into a
     single spinning wheel. */
  col += uColor * hairline(r, R * 1.09, 0.0007) * 0.9;

  float arcTurn = angle + spin * 2.0;
  float arcGaps = smoothstep(0.25, 0.80, abs(sin(arcTurn * 3.0)));
  col += uColor * hairline(r, 0.335, 0.0014) * arcGaps * (1.9 + 1.2 * energy);

  /* The art's few warm marks: two short arcs riding the turning ring. */
  float along = fract(arcTurn / TAU);
  float warmMarks = (1.0 - smoothstep(0.0, 0.014, abs(along - 0.17)))
    + (1.0 - smoothstep(0.0, 0.008, abs(along - 0.62)));
  col += WARM * hairline(r, 0.335, 0.0024) * warmMarks * 1.5;

  /* The still scale. */
  float ticks = smoothstep(0.82, 0.995, abs(sin(angle * 45.0)));
  col += uColor * hairline(r, 0.365, 0.0045) * ticks * 0.9;
  float majorTicks = smoothstep(0.95, 0.999, abs(sin(angle * 6.0)));
  col += uColor * hairline(r, 0.365, 0.010) * majorTicks * 1.4;

  /* A readout of dashes of uneven length, counter-turning, over the upper
     half where the art carries its blocks. Irregular spacing is what makes it
     read as content rather than ornament. */
  float dataAngle = angle - spin * 1.4;
  float dataCell = floor(dataAngle / TAU * 60.0);
  float dataLen = 0.25 + 0.65 * hash21(vec2(dataCell, 17.0));
  float dataMark = step(1.0 - dataLen, fract(dataAngle / TAU * 60.0)) * step(0.3, hash21(vec2(dataCell, 5.0)));
  col += mix(uColor, vec3(1.0), 0.2) * hairline(r, 0.392, 0.0042) * dataMark
    * smoothstep(-0.1, 0.3, sin(angle)) * (0.8 + 0.8 * energy);

  /* ---- the waveform ring ----------------------------------------------
     Radius modulated by the real level. With no reading this is a true
     circle, which is the honest resting state — a waveform that writhes while
     nothing is being heard is exactly the fake this build refuses. */
  float wave = sin(angle * 9.0 - t * 2.1) * 0.5 + sin(angle * 14.0 + t * 1.3) * 0.3;
  col += mix(uColor, uAccent, 0.6)
    * hairline(r, 0.418 + wave * amp * 0.04, 0.0018)
    * (0.45 + 1.5 * amp);

  /* ---- the axis ------------------------------------------------------------
     A hairline of light through the globe from above, and a beam below it
     reaching down toward the art's own pedestal - the canvas ends, the art's
     beam carries on. Faint across the globe itself. */
  float axisLine = 1.0 - smoothstep(0.4 * pixel, 1.6 * pixel, abs(uv.x));
  col += mix(uColor, vec3(1.0), 0.4) * axisLine * mix(1.0, 0.22, inDisc) * smoothstep(0.50, 0.36, uv.y) * 0.75;
  float belowGlobe = smoothstep(-R * 0.85, -R - 0.03, uv.y);
  col += uColor * exp(-abs(uv.x) * 90.0) * belowGlobe * (0.30 + 0.35 * energy + 0.4 * amp);
  col += mix(uColor, vec3(1.0), 0.5) * axisLine * belowGlobe * 0.9;

  /* ---- rings: a voice going out, or sound coming in ---------------------
     Three at a time, evenly spaced in their life. How bright they are follows
     the real level, so silence sends nothing - only their spacing is a clock. */
  if (abs(uRipple) > 0.01) {
    float strength = abs(uRipple) * (0.2 + 1.5 * amp);
    for (int k = 0; k < 3; k++) {
      float life = fract(t * 0.38 + float(k) / 3.0);
      float travel = uRipple > 0.0 ? life : 1.0 - life;
      float radius = R * (1.05 + 0.82 * travel);
      col += mix(uColor, uAccent, travel) * band(r, radius, 0.0035 + 0.008 * travel)
        * sin(life * 3.14159) * (1.0 - 0.6 * travel) * strength;
    }
  }

  /* ---- the sweep: looking for something ----------------------------------
     A beam turning through the instrument's ring with a fading wake behind
     it, as on a radar. Only while searching, reading or analysing. */
  if (uScan > 0.01) {
    float sweep = mod(t * 1.25, TAU);
    float wake = mod(sweep - angle, TAU);
    float annulus = smoothstep(R * 1.10, R * 1.16, r) * (1.0 - smoothstep(0.37, 0.40, r));
    col += mix(uColor, uAccent, 0.5) * exp(-wake * 2.4) * annulus * uScan * 0.5;
    col += mix(uColor, vec3(1.0), 0.5) * (1.0 - smoothstep(0.0, 1.5 * pixel, wake * r)) * annulus * uScan * 1.2;
  }

  /* ---- particles -------------------------------------------------------
     Hashed from their own index, so radii, speeds and phases all differ with
     nothing stored per particle. uConverge moves the set in or out. */
  for (int i = 0; i < 20; i++) {
    float fi = float(i);
    float seed = hash21(vec2(fi, 3.7));
    float seed2 = hash21(vec2(fi, 9.1));

    float direction = seed2 > 0.5 ? 1.0 : -1.0;
    float pa = seed * TAU + t * (0.25 + seed * 0.75) * (0.5 + energy) * direction * 0.6;

    /* Wrapped, so particles keep arriving rather than all reaching the
       destination at once and stopping there. Pulled in, they settle on the
       globe's edge; pushed out, they leave the frame. */
    float drift = fract(seed2 + t * 0.06 * (0.4 + energy));
    float base = mix(0.31, 0.50, seed);
    float pr = uConverge >= 0.0
      ? mix(base, R + 0.02, drift * uConverge)
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
  float bracketAngle = angle + spin * 0.5;
  float brackets = smoothstep(0.88, 0.995, abs(sin(bracketAngle * 3.0)));
  col += uColor * hairline(r, 0.488, 0.0016) * brackets * 1.6;
  col += uColor * hairline(r, 0.488, 0.010) * smoothstep(0.985, 1.0, abs(sin(bracketAngle * 3.0))) * 1.8;

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

  /* Written premultiplied, with blending off: light adds to whatever is
     behind the canvas, and the globe's disc is filled dark enough to hide the
     key art's own globe, which sits right behind this one on Home - two
     networks turning against each other read as noise. The fill reaches a
     little past the edge too, so the art's bright rim never shows as a second
     outline beside this one's. */
  float glow = clamp(max(max(col.r, col.g), col.b) * 1.5, 0.0, 1.0);
  float rim = 1.0 - smoothstep(R * 1.015, R * 1.085, r);
  float fill = max(inDisc * 0.88, rim * 0.78);
  vec3 deep = vec3(0.008, 0.024, 0.050);
  fragColor = vec4(col + deep * fill * (1.0 - glow), max(fill, glow));
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
      phase: gl.getUniformLocation(program, "uPhase"),
      converge: gl.getUniformLocation(program, "uConverge"),
      amplitude: gl.getUniformLocation(program, "uAmplitude"),
      color: gl.getUniformLocation(program, "uColor"),
      accent: gl.getUniformLocation(program, "uAccent"),
      alive: gl.getUniformLocation(program, "uAlive"),
      traffic: gl.getUniformLocation(program, "uTraffic"),
      ripple: gl.getUniformLocation(program, "uRipple"),
      scan: gl.getUniformLocation(program, "uScan"),
      glitch: gl.getUniformLocation(program, "uGlitch")
    };

    gl.useProgram(program);
    // No blending: one triangle is drawn once over a cleared canvas, and the
    // shader writes its colour already premultiplied, the way the page
    // composites a WebGL canvas.
    gl.disable(gl.BLEND);

    setUsable(true);

    let frame: number | null = null;
    let lost = false;
    const started = performance.now();

    // Eased rather than jumped. A tool finishing flips the state in one tick,
    // and snapping every uniform at once looks like a cut between two separate
    // animations instead of one system changing what it is doing.
    let easedEnergy = 0;
    let easedSpin = 1;
    // The globe's turn, accumulated from the eased spin. See uPhase.
    let phase = 0;
    let easedConverge = 0;
    let easedAmp = 0;
    let easedAlive = 1;
    let easedTraffic = 0;
    let easedRipple = 0;
    let easedScan = 0;
    let easedGlitch = 0;
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
        easedTraffic = visual.traffic;
        easedRipple = visual.ripple;
        easedScan = visual.scan;
        easedGlitch = visual.glitch;
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
        easedTraffic = approach(easedTraffic, visual.traffic, rate(0.04));
        easedRipple = approach(easedRipple, visual.ripple, rate(0.06));
        easedScan = approach(easedScan, visual.scan, rate(0.05));
        // A fault shows at once; recovering from one settles more slowly.
        easedGlitch = approach(easedGlitch, visual.glitch, rate(visual.glitch > easedGlitch ? 0.3 : 0.04));
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
      // About a turn every forty seconds at rest, faster as the work does.
      phase += (delta / 60) * 0.16 * easedSpin * calm;
      gl.uniform1f(uniforms.phase, phase);
      gl.uniform1f(uniforms.converge, easedConverge);
      gl.uniform1f(uniforms.amplitude, Math.min(1, Math.max(0, easedAmp)));
      gl.uniform3f(uniforms.color, easedColor[0], easedColor[1], easedColor[2]);
      gl.uniform3f(uniforms.accent, easedAccent[0], easedAccent[1], easedAccent[2]);
      gl.uniform1f(uniforms.alive, easedAlive);
      gl.uniform1f(uniforms.traffic, easedTraffic * (calm < 1 ? 0.6 : 1));
      gl.uniform1f(uniforms.ripple, easedRipple);
      gl.uniform1f(uniforms.scan, easedScan);
      // No slipping at all under reduced motion: it is exactly the darting
      // movement the preference asks to be spared.
      gl.uniform1f(uniforms.glitch, calm < 1 ? 0 : easedGlitch);

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
