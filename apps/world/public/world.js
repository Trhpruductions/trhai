// TRH World: a pixel-art town drawn on a canvas.
//
// Everything that moves or lights up comes from /api/world, which is TRH AI's
// own record of what it is doing. A building is lit and an agent walks to it
// only while a step of that kind is really running; otherwise the agents stand
// in front of their own buildings, idle. Nothing is scripted, and nothing
// wanders for show. All text from the server goes in with textContent.

"use strict";

const canvas = document.getElementById("town");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

const W = canvas.width;
const H = canvas.height;
const CELL_X = 152, CELL_Y = 108, ORIGIN_X = 28, ORIGIN_Y = 14, BW = 96, BH = 60;

const roofs = {
  study: "#7c5cd6", library: "#c0562f", workshop: "#d49a2a", depot: "#4a8f5a",
  lab: "#2f9bb3", terminal: "#5b6478", launchpad: "#c2415a"
};

const SPEED = 58; // pixels per second

let world = null;       // the last answer from /api/world
let online = false;
const actors = new Map(); // agent id -> { x, y, path, roomId, state, hue, step }
let hover = null;
let mouse = null;

// --- geometry ----------------------------------------------------------------

function building(room) {
  const x = ORIGIN_X + room.col * CELL_X;
  const y = ORIGIN_Y + room.row * CELL_Y;
  return { x, y, doorX: x + BW / 2, doorY: y + BH, roadY: y + BH + 14, col: room.col };
}

function gapX(col) { return ORIGIN_X + col * CELL_X + BW + (CELL_X - BW) / 2; }

/** The points to walk to get from one building's door to another's, along the roads. */
function route(fromRoom, toRoom) {
  const a = building(fromRoom), b = building(toRoom);
  if (fromRoom.id === toRoom.id) return [];
  const gap = gapX(a.col === b.col ? Math.min(a.col, 1) : Math.min(a.col, b.col));
  return [
    { x: a.doorX, y: a.roadY }, { x: gap, y: a.roadY }, { x: gap, y: b.roadY },
    { x: b.doorX, y: b.roadY }
  ];
}

function standing(resident, index, count, room) {
  const b = building(room);
  const spread = Math.min(20, 64 / Math.max(count, 1));
  const x = b.doorX + (index - (count - 1) / 2) * spread;
  // Working: at the door. Idle: out front on the road.
  return { x, y: resident.state === "working" ? b.doorY + 2 : b.roadY - 3 };
}

// --- drawing -----------------------------------------------------------------

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function drawGround() {
  ctx.fillStyle = "#2f6b3a";
  ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 8) {
    for (let x = 0; x < W; x += 8) {
      const n = hash(`${x},${y}`) % 7;
      if (n === 0) { ctx.fillStyle = "#2a6234"; ctx.fillRect(x, y, 8, 8); }
      else if (n === 1) { ctx.fillStyle = "#3a7a45"; ctx.fillRect(x + 2, y + 3, 2, 2); }
    }
  }
  // Roads: one along the front of each row, one in each gap between columns.
  ctx.fillStyle = "#c9b27c";
  for (let r = 0; r < 3; r += 1) ctx.fillRect(0, ORIGIN_Y + r * CELL_Y + BH + 8, W, 12);
  for (let c = 0; c < 2; c += 1) ctx.fillRect(gapX(c) - 6, 0, 12, H);
  ctx.fillStyle = "#b39c68";
  for (let r = 0; r < 3; r += 1) for (let x = 6; x < W; x += 24) ctx.fillRect(x, ORIGIN_Y + r * CELL_Y + BH + 14, 8, 1);
}

function drawBuilding(room, live, tick) {
  const b = building(room);
  ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(b.x + 3, b.y + 6, BW, BH); // shadow
  ctx.fillStyle = live ? "#efe3c6" : "#d9ccae"; ctx.fillRect(b.x, b.y + 14, BW, BH - 14); // walls
  ctx.fillStyle = roofs[room.id] || "#777";
  ctx.fillRect(b.x - 4, b.y, BW + 8, 18); // roof
  ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.fillRect(b.x - 4, b.y, BW + 8, 3);
  // windows
  for (let i = 0; i < 3; i += 1) {
    const wx = b.x + 8 + i * 30;
    ctx.fillStyle = live ? ((tick + i) % 2 ? "#ffe98a" : "#ffd24a") : "#5d7a9a";
    ctx.fillRect(wx, b.y + 26, 14, 10);
    ctx.fillStyle = "#3b4c66"; ctx.fillRect(wx + 6, b.y + 26, 2, 10);
  }
  ctx.fillStyle = "#6b4a2c"; ctx.fillRect(b.doorX - 6, b.y + BH - 16, 12, 16); // door
  ctx.fillStyle = "#e8c86a"; ctx.fillRect(b.doorX + 3, b.y + BH - 9, 2, 2);
  // sign
  ctx.fillStyle = "#2a2118"; ctx.fillRect(b.x + 18, b.y + 4, BW - 36, 11);
  ctx.fillStyle = "#f3e6c4"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(room.name.toUpperCase(), b.x + BW / 2, b.y + 10);
  if (live) {
    ctx.strokeStyle = "#5fd0ff"; ctx.lineWidth = 2; ctx.strokeRect(b.x - 5, b.y - 1, BW + 10, BH + 2);
  }
}

function drawActor(actor, resident, moving, tick) {
  const x = Math.round(actor.x), y = Math.round(actor.y);
  ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.fillRect(x - 5, y, 10, 3); // shadow
  const hue = actor.hue;
  const frame = moving ? Math.floor(tick / 2) % 2 : 0;
  const bob = !moving && resident.state === "working" ? (tick % 2) : 0;
  ctx.fillStyle = "#2b2f45"; // legs
  ctx.fillRect(x - 3, y - 4, 2, 4 - frame); ctx.fillRect(x + 1, y - 4, 2, 3 + frame);
  ctx.fillStyle = `hsl(${hue} 65% 52%)`; ctx.fillRect(x - 4, y - 10 - bob, 8, 7); // body
  ctx.fillStyle = "#f1c9a0"; ctx.fillRect(x - 3, y - 15 - bob, 6, 5); // head
  ctx.fillStyle = `hsl(${(hue + 40) % 360} 40% 25%)`; ctx.fillRect(x - 3, y - 16 - bob, 6, 2); // hair
  if (resident.active) { ctx.fillStyle = "#5fd0ff"; ctx.fillRect(x - 1, y - 20 - bob, 2, 2); }
}

function bubble(text, x, y) {
  ctx.font = "8px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const clipped = text.length > 36 ? `${text.slice(0, 35)}…` : text;
  const w = Math.ceil(ctx.measureText(clipped).width) + 10;
  let bx = Math.round(x - w / 2); bx = Math.max(2, Math.min(W - w - 2, bx));
  const by = Math.max(2, Math.round(y - 34));
  ctx.fillStyle = "#fffdf4"; ctx.fillRect(bx, by, w, 13);
  ctx.fillStyle = "#1c2238"; ctx.strokeStyle = "#1c2238"; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, w - 1, 12);
  ctx.fillRect(Math.round(x) - 1, by + 13, 3, 3);
  ctx.fillText(clipped, bx + 5, by + 7);
}

// --- movement ----------------------------------------------------------------

function step(actor, dt) {
  let left = SPEED * dt;
  while (left > 0 && actor.path.length > 0) {
    const next = actor.path[0];
    const dx = next.x - actor.x, dy = next.y - actor.y;
    const d = Math.hypot(dx, dy);
    if (d <= left) { actor.x = next.x; actor.y = next.y; actor.path.shift(); left -= d; }
    else { actor.x += (dx / d) * left; actor.y += (dy / d) * left; left = 0; }
  }
}

function sync() {
  if (!world) return;
  const rooms = new Map(world.rooms.map((room) => [room.id, room]));
  const perRoom = new Map();
  for (const resident of world.residents) {
    const list = perRoom.get(resident.room.id) ?? [];
    list.push(resident); perRoom.set(resident.room.id, list);
  }
  for (const resident of world.residents) {
    const room = rooms.get(resident.room.id);
    const here = perRoom.get(room.id);
    const spot = standing(resident, here.indexOf(resident), here.length, room);
    let actor = actors.get(resident.id);
    if (!actor) {
      actor = { x: spot.x, y: spot.y, path: [], roomId: room.id, hue: hash(resident.id) % 360, spot };
      actors.set(resident.id, actor);
    }
    const moved = actor.roomId !== room.id;
    if (moved) {
      const from = rooms.get(actor.roomId) ?? room;
      actor.path = [...route(from, room), spot];
      actor.roomId = room.id;
    } else if (actor.spot.x !== spot.x || actor.spot.y !== spot.y) {
      actor.path = [spot];
    }
    actor.spot = spot;
    actor.resident = resident;
  }
}

// --- the page ----------------------------------------------------------------

const linkChip = document.getElementById("link");
const modeChip = document.getElementById("mode");
const offline = document.getElementById("offline");
const rosterEl = document.getElementById("roster");
const stepsEl = document.getElementById("steps");
const noSteps = document.getElementById("nosteps");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderSide() {
  if (!world) return;
  document.getElementById("count").textContent = String(world.residents.length);
  rosterEl.replaceChildren(...world.residents.map((resident) => {
    const li = el("li", resident.active ? "active" : "");
    li.append(el("span", "face", resident.avatar));
    const body = el("div");
    const name = el("strong", "", resident.name);
    if (resident.active) name.append(el("span", "chip live", "in use"));
    body.append(name, el("small", "", resident.role),
      el("p", "", resident.state === "working" && resident.doing ? `Now: ${resident.doing}` : resident.focus),
      el("small", "", `${resident.room.name} · ${resident.state}`));
    li.append(body);
    return li;
  }));
  noSteps.hidden = world.steps.length > 0;
  stepsEl.replaceChildren(...world.steps.map(({ event, room }) => {
    const li = el("li");
    li.append(el("span", `dot ${event.status}`), el("span", "", event.label), el("span", "where", `${room.name} · ${event.status}`));
    return li;
  }));
  modeChip.textContent = world.working ? `${world.residents[0].name} working` : "All idle";
  modeChip.className = `chip ${world.working ? "live" : ""}`;
}

async function poll() {
  try {
    const response = await fetch("/api/world", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    world = body.data;
    online = true;
    sync();
    renderSide();
  } catch {
    online = false;
  }
  linkChip.textContent = online ? "Connected to TRH AI" : "TRH AI is not running";
  linkChip.className = `chip ${online ? "ok" : "danger"}`;
  offline.hidden = online;
  setTimeout(poll, world && world.working ? 500 : 1500);
}

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  mouse = { x: (event.clientX - rect.left) * (W / rect.width), y: (event.clientY - rect.top) * (H / rect.height) };
});
canvas.addEventListener("mouseleave", () => { mouse = null; });

let last = performance.now();
let tick = 0;
let tickAt = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (now - tickAt > 140) { tick += 1; tickAt = now; }

  drawGround();
  if (world) {
    const live = new Set(world.working ? [world.residents[0].room.id] : []);
    for (const room of world.rooms) drawBuilding(room, live.has(room.id), tick);

    const list = [...actors.values()].filter((actor) => actor.resident);
    for (const actor of list) step(actor, dt);
    list.sort((a, b) => a.y - b.y);
    hover = null;
    for (const actor of list) {
      const moving = actor.path.length > 0;
      drawActor(actor, actor.resident, moving, tick);
      if (mouse && Math.abs(mouse.x - actor.x) < 7 && mouse.y > actor.y - 20 && mouse.y < actor.y + 3) hover = actor;
    }
    for (const actor of list) {
      if (actor.resident.state === "working" && actor.resident.doing) bubble(actor.resident.doing, actor.x, actor.y);
    }
    if (hover && hover.resident.state !== "working") bubble(`${hover.resident.name}: ${hover.resident.focus}`, hover.x, hover.y);
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
void poll();
