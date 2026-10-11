import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import * as G from './shared/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ROUND_TIME = Number(process.env.ROUND_TIME) || G.ROUND_TIME; // override for quick testing

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/info', (_req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  res.json({ lan: ips[0] || null, port: PORT });
});
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const BOT_NAMES = ['Brutus', 'Nyx', 'Vex', 'Ajax', 'Rook', 'Zara', 'Kato', 'Juno', 'Pike', 'Mira', 'Orin', 'Sable'];
const DC_GRACE_MS = 30000;
const EMPTY_ROOM_MS = 5 * 60 * 1000;
let nextId = 1;

function makeCode() {
  let c;
  do c = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
  while (rooms.has(c));
  return c;
}

function cleanName(n) {
  return String(n || '').replace(/[<>]/g, '').trim().slice(0, 12) || 'Player';
}

function newPlayer(name, opts = {}) {
  return {
    id: 'p' + nextId++, name, isBot: !!opts.isBot, socketId: opts.socketId || null,
    connected: true, cls: opts.cls || 'gladiator', team: 'red', ready: !!opts.isBot,
    colorIdx: 0, inMatch: false, score: 0, kos: 0, deaths: 0,
    x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0, dashT: 0, dashVX: 0, dashVZ: 0, slowT: 0,
    yaw: 0, pitch: 0, moveX: 0, moveZ: 0,
    hp: 100, maxHp: 100, dead: false, respawnT: 0, protT: 0, invulnT: 0, invisT: 0, shieldT: 0,
    lungeT: 0, lungeHit: false, atkCd: 0, ablCd: 0, lastHurt: -99,
    aim: null, powT: 0, spdT: 0, pity: 0, dryDeaths: 0,
    inputs: [], lastSeq: 0, lastInputAt: 0,
    bot: opts.isBot ? { strafeAng: Math.random() * 6.28, strafeT: 0, lastX: 0, lastZ: 0, checkT: 0, unstickT: 0, ux: 0, uz: 0,
      targetId: null, seenT: 0, aimErr: 0, aimGoal: 0, aimT: 0, swingAt: null } : null,
  };
}

function humans(room) { return [...room.players.values()].filter(p => !p.isBot); }

function assignColor(room, p) {
  const used = new Set([...room.players.values()].filter(q => q !== p).map(q => q.colorIdx));
  for (let i = 0; i < G.PLAYER_COLORS.length; i++) if (!used.has(i)) { p.colorIdx = i; return; }
}

function smallerTeam(room, except) {
  let red = 0, blue = 0;
  for (const q of room.players.values()) if (q !== except) q.team === 'red' ? red++ : blue++;
  return red <= blue ? 'red' : 'blue';
}

function rebalanceTeams(room) {
  let i = 0;
  for (const p of room.players.values()) p.team = i++ % 2 === 0 ? 'red' : 'blue';
}

function lobbyState(room) {
  return {
    code: room.code, hostId: room.hostId, mode: room.mode, botLevel: room.botLevel, phase: room.phase, results: room.results,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, isBot: p.isBot, cls: p.cls, team: p.team, ready: p.ready,
      connected: p.connected, colorIdx: p.colorIdx,
    })),
  };
}

function broadcastLobby(room) { io.to(room.code).emit('lobby', lobbyState(room)); }

function pickNewHost(room) {
  const h = humans(room).find(p => p.connected);
  room.hostId = h ? h.id : null;
}

function removePlayer(room, p) {
  room.players.delete(p.id);
  if (room.hostId === p.id) pickNewHost(room);
  if (humans(room).length === 0) room.emptySince = Date.now();
  broadcastLobby(room);
}

// ---------- match setup ----------

function initSim(room, p) {
  const c = G.CLASSES[p.cls];
  p.maxHp = c.hp; p.hp = c.hp;
  p.score = 0; p.kos = 0; p.deaths = 0; p.pity = 0; p.dryDeaths = 0;
  p.inMatch = true; p.inputs = [];
  spawn(room, p, true);
}

function spawn(room, p, initial) {
  const z = G.ZONES[room.zoneIdx];
  const taken = [...room.players.values()].filter(q => q !== p && q.inMatch && !q.dead);
  let best = G.SPAWNS[0], bestScore = -Infinity;
  G.SPAWNS.forEach((s, i) => {
    let score = Math.hypot(s.x - z.x, s.z - z.z);
    for (const q of taken) if (Math.hypot(q.x - s.x, q.z - s.z) < 2) score -= 100;
    if (initial) score = -i + Math.random() * 0.5 - (taken.some(q => Math.hypot(q.x - s.x, q.z - s.z) < 2) ? 100 : 0);
    if (score > bestScore) { bestScore = score; best = s; }
  });
  Object.assign(p, {
    x: best.x, z: best.z, y: G.groundHeight(best.x, best.z), vy: 0, kx: 0, kz: 0,
    dashT: 0, slowT: 0, hp: p.maxHp, dead: false, respawnT: 0, protT: G.SPAWN_PROTECT,
    invulnT: 0, invisT: 0, shieldT: 0, lungeT: 0, atkCd: 0, ablCd: 0, powT: 0, spdT: 0,
  });
  p.yaw = Math.atan2(-(z.x - p.x), -(z.z - p.z));
}

function startMatch(room) {
  room.phase = 'countdown';
  room.timer = G.COUNTDOWN_TIME;
  room.time = 0;
  room.zoneIdx = 0; room.nextZoneIdx = null; room.zoneT = G.ZONE_PERIOD;
  room.teamScore = Object.fromEntries(G.TEAMS.map(t => [t, 0]));
  room.meteors = []; room.meteorT = 0; room.meteorAnnounced = false;
  room.pickups = initPickups();
  room.projectiles = []; room.events = []; room.results = null; room.suddenIds = null;
  room.contested = false; room.holder = null;
  let i = 0;
  for (const p of room.players.values()) {
    if (!p.connected) { room.players.delete(p.id); continue; }
    initSim(room, p);
    i++;
  }
  broadcastLobby(room);
}

function endMatch(room, winner) {
  room.phase = 'ended';
  const list = [...room.players.values()].filter(p => p.inMatch).map(p => ({
    id: p.id, name: p.name, cls: p.cls, team: p.team, isBot: p.isBot,
    score: Math.floor(p.score), kos: p.kos, deaths: p.deaths,
  })).sort((a, b) => b.score - a.score || b.kos - a.kos);
  room.results = {
    mode: room.mode, winner, players: list,
    teamScore: Object.fromEntries(Object.entries(room.teamScore).map(([k, v]) => [k, Math.floor(v)])),
    teams: [...new Set(list.map(p => p.team))],
  };
  for (const p of room.players.values()) { p.inMatch = false; if (!p.isBot) p.ready = false; }
  broadcastLobby(room);
}

// ---------- combat ----------

function ev(room, e) { room.events.push(e); }

function enemiesOf(room, p) {
  const out = [];
  for (const q of room.players.values()) {
    if (q === p || !q.inMatch || q.dead) continue;
    if (room.mode === 'teams' && q.team === p.team) continue;
    out.push(q);
  }
  return out;
}

function alliesOf(room, p) {
  return [...room.players.values()].filter(q => q.inMatch && !q.dead &&
    (q === p || (room.mode === 'teams' && q.team === p.team)));
}

function addPoints(room, p, pts) {
  p.score += pts;
  if (room.mode === 'teams') room.teamScore[p.team] += pts;
}

function damage(room, src, e, amt, kbx = 0, kbz = 0) {
  if (e.dead || e.protT > 0 || e.invulnT > 0) return false;
  if (src) {
    if (src.powT > 0) amt *= 2;
    amt *= 1 + 0.15 * src.pity; // hidden comeback boost
  }
  amt *= 1 - 0.1 * e.pity;
  if (e.shieldT > 0) amt *= 0.5;
  amt = Math.max(1, Math.round(amt));
  e.hp -= amt;
  e.lastHurt = room.time;
  const res = e.cls === 'tank' ? 0.7 : 1;
  e.kx += kbx * res; e.kz += kbz * res;
  ev(room, { t: 'hit', id: e.id, by: src ? src.id : null, amt, x: e.x, y: e.y + 2, z: e.z });
  if (e.hp <= 0) knockOut(room, src, e);
  return true;
}

function knockOut(room, src, e, cause) {
  e.hp = 0; e.dead = true; e.respawnT = G.RESPAWN_TIME; e.deaths++;
  e.invisT = 0; e.dashT = 0; e.kx = 0; e.kz = 0; e.lungeT = 0; e.powT = 0; e.spdT = 0;
  // Hidden comeback boost: 3+ deaths in a row with no kill ramps it up, one level per death.
  e.dryDeaths++;
  if (e.dryDeaths >= 3) e.pity = Math.min(5, e.dryDeaths - 2);
  if (src && src !== e) {
    src.kos++;
    src.dryDeaths = 0; // the boost now fades out (see tick)
    addPoints(room, src, G.KO_POINTS);
    if (src.cls === 'gladiator' && !src.dead) src.hp = Math.min(src.maxHp, src.hp + 30);
  }
  ev(room, { t: 'ko', id: e.id, by: src ? src.id : null, x: e.x, y: e.y, z: e.z, cause });
}

function aoe(room, p, x, z, r, dmg, kb, slow = 0) {
  const f = G.facing(p.yaw);
  for (const e of enemiesOf(room, p)) {
    const dx = e.x - x, dz = e.z - z, d = Math.hypot(dx, dz);
    if (d > r + G.PLAYER_RADIUS || Math.abs(e.y - p.y) > 2.5) continue;
    const nx = d > 0.01 ? dx / d : f.x, nz = d > 0.01 ? dz / d : f.z;
    if (damage(room, p, e, dmg, nx * kb, nz * kb) && slow) e.slowT = slow;
  }
}

function lockTarget(room, p, maxDist, arcDeg) {
  const f = G.facing(p.yaw), cosA = Math.cos(arcDeg * Math.PI / 180);
  let best = null, bestD = Infinity;
  for (const e of enemiesOf(room, p)) {
    if (e.invisT > 0) continue;
    const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
    if (d > maxDist || d < 0.01) continue;
    if ((dx * f.x + dz * f.z) / d < cosA) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Direction from the hand toward the player's crosshair point (sent by the client).
function aimDir(p, o) {
  const f = G.facing(p.yaw), cp = Math.cos(p.pitch);
  const a = p.aim;
  if (a) {
    const dx = a.x - o.x, dy = a.y - o.y, dz = a.z - o.z, d = Math.hypot(dx, dy, dz);
    if (d > 1.2 && dx * f.x + dz * f.z > 0) return { x: dx / d, y: dy / d, z: dz / d, point: a };
  }
  const fwd = { x: f.x * cp, y: Math.sin(p.pitch), z: f.z * cp };
  return { ...fwd, point: { x: o.x + fwd.x * 25, y: o.y + fwd.y * 25, z: o.z + fwd.z * 25 } };
}

// Enemy closest to the aim ray within `deg` degrees (light aim assist for arrows).
function nearCrosshair(room, p, o, dir, range, deg) {
  const cosA = Math.cos(deg * Math.PI / 180);
  let best = null, bestC = cosA;
  for (const e of enemiesOf(room, p)) {
    if (e.invisT > 0) continue;
    const vx = e.x - o.x, vy = e.y + 1 - o.y, vz = e.z - o.z, d = Math.hypot(vx, vy, vz);
    if (d > range || d < 0.01) continue;
    const c = (vx * dir.x + vy * dir.y + vz * dir.z) / d;
    if (c > bestC) { bestC = c; best = e; }
  }
  return best;
}

function spawnProjectile(room, p, kind, a) {
  const f = G.facing(p.yaw);
  const o = { x: p.x + f.x * 0.6, y: p.y + 1.4, z: p.z + f.z * 0.6 };
  const pr = {
    id: nextId++, kind, owner: p.id, ox: p.x, oz: p.z, x: o.x, y: o.y, z: o.z,
    vx: 0, vy: 0, vz: 0, life: a.life, dmg: a.dmg, splash: a.splash || 0, kb: a.kb || 0,
    grav: 0, target: null, homing: 0,
  };
  const dir = aimDir(p, o);
  if (kind === 'bomb') {
    // lob: pick the low arc that lands on the crosshair point (45° if it's out of range)
    pr.grav = G.GRAVITY;
    const hx = dir.point.x - o.x, hz = dir.point.z - o.z, D = Math.hypot(hx, hz) || 0.01;
    const h = dir.point.y - o.y, v = a.speed, g = G.GRAVITY;
    const disc = v ** 4 - g * (g * D * D + 2 * h * v * v);
    const th = disc >= 0 ? Math.atan((v * v - Math.sqrt(disc)) / (g * D)) : Math.PI / 4;
    pr.vx = hx / D * Math.cos(th) * v; pr.vy = Math.sin(th) * v; pr.vz = hz / D * Math.cos(th) * v;
  } else {
    pr.vx = dir.x * a.speed; pr.vy = dir.y * a.speed; pr.vz = dir.z * a.speed;
    if (kind === 'arrow' && !p.isBot) {
      const t = nearCrosshair(room, p, o, dir, a.range, 8);
      if (t) { pr.target = t.id; pr.homing = 0.12; }
    }
  }
  room.projectiles.push(pr);
}

function doAttack(room, p) {
  const c = G.CLASSES[p.cls], a = c.attack;
  p.atkCd = a.cd + (p.isBot ? botLevel(room).extraCd * (0.5 + Math.random()) : 0);
  p.invisT = 0;
  ev(room, { t: 'atk', id: p.id });
  if (a.type !== 'melee') return spawnProjectile(room, p, a.type, a);

  const f = G.facing(p.yaw), cosA = Math.cos(a.arc / 2 * Math.PI / 180);
  for (const e of enemiesOf(room, p)) {
    const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
    if (d > a.range + G.PLAYER_RADIUS || Math.abs(e.y - p.y) > 1.8) continue;
    if (d > 0.15 && (dx * f.x + dz * f.z) / d < cosA) continue;
    let dmg = a.dmg;
    if (p.cls === 'rogue' && d > 0.01) {
      const ef = G.facing(e.yaw);
      if ((dx * ef.x + dz * ef.z) / d > 0.3) { dmg *= 2; ev(room, { t: 'txt', id: e.id, txt: 'BACKSTAB' }); }
    }
    if (p.cls === 'lancer' && e.hp > e.maxHp * 0.75) dmg += 6;
    const nx = d > 0.01 ? dx / d : f.x, nz = d > 0.01 ? dz / d : f.z;
    damage(room, p, e, dmg, nx * a.kb, nz * a.kb);
  }
}

function doAbility(room, p) {
  const c = G.CLASSES[p.cls], id = c.ability.id;
  p.ablCd = c.ability.cd + (p.isBot ? botLevel(room).extraCd * 3 : 0);
  const f = G.facing(p.yaw);
  ev(room, { t: 'abl', id: p.id, a: id, x: p.x, y: p.y, z: p.z });
  switch (id) {
    case 'slam':
      aoe(room, p, p.x, p.z, 4, 15, 13);
      break;
    case 'roll': {
      let dx = p.moveX, dz = p.moveZ, m = Math.hypot(dx, dz);
      if (m < 0.1) { dx = f.x; dz = f.z; m = 1; }
      p.dashT = 0.25; p.dashVX = dx / m * 20; p.dashVZ = dz / m * 20; p.invulnT = 0.3;
      break;
    }
    case 'nova':
      aoe(room, p, p.x, p.z, 5, 10, 2, 2);
      break;
    case 'lunge':
      p.dashT = 0.3; p.dashVX = f.x * 23; p.dashVZ = f.z * 23; p.lungeT = 0.32; p.lungeHit = false;
      break;
    case 'shadow': {
      const s = { x: p.x, y: p.y + 0.01, z: p.z };
      for (let i = 0; i < 12; i++) {
        const tx = s.x + f.x * 0.5, tz = s.z + f.z * 0.5;
        s.x = tx; s.z = tz;
        G.resolveCollision(s);
        if (Math.hypot(s.x - tx, s.z - tz) > 0.2) break;
      }
      p.x = s.x; p.z = s.z; p.y = Math.max(p.y, G.groundHeight(p.x, p.z));
      p.invisT = 2.5;
      ev(room, { t: 'abl', id: p.id, a: 'shadow2', x: p.x, y: p.y, z: p.z });
      break;
    }
    case 'sanctuary':
      for (const q of alliesOf(room, p)) {
        if (Math.hypot(q.x - p.x, q.z - p.z) <= 6) q.hp = Math.min(q.maxHp, q.hp + 35);
      }
      p.shieldT = 3;
      break;
    case 'blast':
      aoe(room, p, p.x, p.z, 3, 15, 9);
      p.vy = 11; p.dashT = 0.45; p.dashVX = f.x * 13; p.dashVZ = f.z * 13;
      break;
    case 'hook':
      spawnProjectile(room, p, 'hook', { speed: 30, life: 14 / 30, dmg: 10, range: 14 });
      break;
  }
}

function hitProjectile(room, pr, owner, e, x, y, z) {
  if (pr.splash) return explode(room, pr, owner, x, y, z);
  if (!owner) return;
  if (pr.kind === 'hook') {
    if (damage(room, owner, e, pr.dmg)) {
      const dx = owner.x - e.x, dz = owner.z - e.z, d = Math.hypot(dx, dz);
      if (d > 2) { e.kx = dx / d * 5 * (d - 2); e.kz = dz / d * 5 * (d - 2); }
      ev(room, { t: 'txt', id: e.id, txt: 'HOOKED' });
    }
    return;
  }
  let dmg = pr.dmg;
  if (pr.kind === 'arrow' && Math.hypot(x - pr.ox, z - pr.oz) > 15) dmg += 4;
  const s = Math.hypot(pr.vx, pr.vz) || 1;
  damage(room, owner, e, dmg, pr.vx / s * 2, pr.vz / s * 2);
}

function explode(room, pr, owner, x, y, z) {
  ev(room, { t: 'boom', x, y, z, r: pr.splash, k: pr.kind });
  if (!owner) return;
  for (const e of enemiesOf(room, owner)) {
    const dx = e.x - x, dz = e.z - z, d = Math.hypot(dx, dz);
    if (d > pr.splash + G.PLAYER_RADIUS || Math.abs(e.y + 0.9 - y) > 2.5) continue;
    const nx = d > 0.01 ? dx / d : 0, nz = d > 0.01 ? dz / d : 0;
    damage(room, owner, e, pr.dmg, nx * pr.kb, nz * pr.kb);
  }
}

function updateProjectiles(room, dt) {
  const keep = [];
  for (const pr of room.projectiles) {
    const owner = room.players.get(pr.owner);
    if (pr.target) {
      const t = room.players.get(pr.target);
      if (t && !t.dead && t.invisT <= 0) {
        const sp = Math.hypot(pr.vx, pr.vy, pr.vz);
        const dx = t.x - pr.x, dy = t.y + 1.0 - pr.y, dz = t.z - pr.z, d = Math.hypot(dx, dy, dz) || 1;
        const k = pr.homing || 0.3;
        pr.vx += (dx / d * sp - pr.vx) * k; pr.vy += (dy / d * sp - pr.vy) * k; pr.vz += (dz / d * sp - pr.vz) * k;
      }
    }
    pr.vy -= pr.grav * dt;
    // sub-step so fast arrows can't skip through players
    const steps = 3;
    let done = false;
    for (let i = 0; i < steps && !done; i++) {
      pr.x += pr.vx * dt / steps; pr.y += pr.vy * dt / steps; pr.z += pr.vz * dt / steps;
      if (owner) {
        for (const e of enemiesOf(room, owner)) {
          if (Math.hypot(e.x - pr.x, e.y + 0.9 - pr.y, e.z - pr.z) < 0.85) {
            hitProjectile(room, pr, owner, e, pr.x, pr.y, pr.z); done = true; break;
          }
        }
      }
      if (!done && G.isSolid(pr.x, pr.y, pr.z)) {
        if (pr.splash) explode(room, pr, owner, pr.x, Math.max(pr.y, G.groundHeight(pr.x, pr.z)), pr.z);
        done = true;
      }
    }
    pr.life -= dt;
    if (!done && pr.life <= 0) {
      if (pr.kind === 'bomb') explode(room, pr, owner, pr.x, pr.y, pr.z);
      done = true;
    }
    if (!done) keep.push(pr);
  }
  room.projectiles = keep;
}

// ---------- bots ----------

// Bot skill levels. aim = radians of aim wobble, react = seconds before attacking a new
// target, extraCd = extra seconds added between attacks, abl = chance per tick to use a
// ready special, speed = movement multiplier, whiff = chance a melee swing is badly timed.
// miss = chance a melee swing is aimed badly enough to miss outright,
// lead = how much ranged bots aim ahead of a moving target (1 = perfect).
const BOT_LEVELS = {
  easy:   { aim: 0.45, react: 0.9,  extraCd: 0.8,  abl: 0.012, speed: 0.75, whiff: 0.35, miss: 0.4,  lead: 0 },
  normal: { aim: 0.28, react: 0.55, extraCd: 0.4,  abl: 0.025, speed: 0.87, whiff: 0.25, miss: 0.4,  lead: 0.35 },
  hard:   { aim: 0.12, react: 0.3,  extraCd: 0.12, abl: 0.05,  speed: 0.97, whiff: 0.12, miss: 0.2,  lead: 0.75 },
};
const botLevel = room => BOT_LEVELS[room.botLevel] || BOT_LEVELS.normal;

function botThink(room, p) {
  const b = p.bot, c = G.CLASSES[p.cls], dt = G.DT, L = botLevel(room);
  const inp = { mx: 0, mz: 0, jump: false, atk: false, abl: false, yaw: p.yaw, pitch: -0.1 };
  if (p.dead || room.phase === 'countdown') return inp;

  const zone = (room.nextZoneIdx != null && room.zoneT < 3) ? G.ZONES[room.nextZoneIdx] : G.ZONES[room.zoneIdx];
  let e = null, d = Infinity;
  for (const q of enemiesOf(room, p)) {
    if (q.invisT > 0) continue;
    const dd = Math.hypot(q.x - p.x, q.z - p.z);
    if (dd < d) { d = dd; e = q; }
  }
  const ranged = c.attack.type !== 'melee';
  const engage = ranged ? Math.min(c.attack.range, 18) : 7;
  const zd = Math.hypot(zone.x - p.x, zone.z - p.z);
  let tx = zone.x, tz = zone.z;

  // reaction time: a bot has to "notice" a new target before it attacks
  if (!e || d >= engage) { b.targetId = null; b.seenT = 0; }
  else if (b.targetId !== e.id) { b.targetId = e.id; b.seenT = 0; }
  else b.seenT += dt;
  const reacted = b.seenT >= L.react;

  // aim error drifts slowly, so bots track you imperfectly instead of snapping on
  b.aimT -= dt;
  if (b.aimT <= 0) { b.aimGoal = (Math.random() * 2 - 1) * L.aim; b.aimT = 0.3 + Math.random() * 0.5; }
  b.aimErr += (b.aimGoal - b.aimErr) * Math.min(1, dt * 6);

  b.strafeT -= dt;
  if (b.strafeT <= 0) { b.strafeAng = Math.random() * Math.PI * 2; b.strafeT = 1 + Math.random(); }
  if (zd < G.ZONE_RADIUS - 1.2) { tx = p.x + Math.cos(b.strafeAng) * 2; tz = p.z + Math.sin(b.strafeAng) * 2; }

  if (e && d < engage) {
    // track the target's velocity so better bots can aim ahead of a moving player
    const tv = b.prev && b.prev.id === e.id ? { x: (e.x - b.prev.x) / dt, z: (e.z - b.prev.z) / dt } : { x: 0, z: 0 };
    b.prev = { id: e.id, x: e.x, z: e.z };
    if (Math.hypot(tv.x, tv.z) > 12) { tv.x = 0; tv.z = 0; } // ignore respawn teleports
    const lt = ranged ? (d / (c.attack.speed || 20)) * L.lead : 0;
    const ax = e.x + tv.x * lt, az = e.z + tv.z * lt;
    inp.yaw = Math.atan2(-(ax - p.x), -(az - p.z)) + b.aimErr;
    // crosshair point for ranged shots: along the (imperfect) aim direction, at the target's distance
    const ad = Math.hypot(ax - p.x, az - p.z);
    inp.ax = p.x - Math.sin(inp.yaw) * ad; inp.az = p.z - Math.cos(inp.yaw) * ad;
    inp.ay = (p.cls === 'bomber' ? e.y + 0.3 : e.y + 1.0) + b.aimErr * 2;
    if (ranged) {
      if (d < 5) { tx = p.x - (e.x - p.x); tz = p.z - (e.z - p.z); }
      if (p.cls === 'bomber') {
        const th = 0.5 * Math.asin(Math.min(1, G.GRAVITY * d / (c.attack.speed ** 2)));
        inp.pitch = th - 0.45 + b.aimErr * 0.6;
      } else {
        inp.pitch = Math.atan2(e.y - p.y, d) - 0.2 + b.aimErr * 0.3;
      }
      if (reacted && d < c.attack.range) inp.atk = true;
    } else {
      // close in, but stop at arm's length instead of standing inside the target
      if (d < 6 || zd < G.ZONE_RADIUS + 3) {
        const keep = Math.min(1.3, c.attack.range * 0.6);
        tx = e.x + (p.x - e.x) / (d || 1) * keep; tz = e.z + (p.z - e.z) / (d || 1) * keep;
      }
      // badly timed swings: sometimes the bot swings from too far away and whiffs
      if (p.atkCd <= 0 && b.swingAt == null) b.swingAt = c.attack.range + (Math.random() < L.whiff ? 0.8 + Math.random() * 1.2 : -0.3);
      if (reacted && b.swingAt != null && d < b.swingAt) {
        inp.atk = true; b.swingAt = null;
        if (Math.random() < L.miss) inp.yaw += (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.5);
      }
    }
  } else b.swingAt = null;

  // grab a nearby power-up if nobody is right on top of us
  if (!(e && d < 4)) {
    let best = null, bd = 7;
    for (const pk of room.pickups) {
      if (!pk.active) continue;
      const dd = Math.hypot(pk.x - p.x, pk.z - p.z);
      if (dd < bd) { bd = dd; best = pk; }
    }
    if (best) { tx = best.x; tz = best.z; }
  }
  // run out of meteor circles (worse bots notice later)
  for (const mt of room.meteors) {
    const dd = Math.hypot(p.x - mt.x, p.z - mt.z);
    if (dd < mt.maxR + 1 && mt.t > L.react * 2) {
      tx = p.x + (p.x - mt.x) / (dd || 1) * 4; tz = p.z + (p.z - mt.z) / (dd || 1) * 4;
      break;
    }
  }

  let mx = tx - p.x, mz = tz - p.z;
  const m = Math.hypot(mx, mz);
  if (m > 0.4) { mx /= m; mz /= m; } else { mx = 0; mz = 0; }

  // stuck detection: if we wanted to move but barely moved, sidestep for a moment
  b.checkT -= dt;
  if (b.checkT <= 0) {
    if (m > 0.4 && Math.hypot(p.x - b.lastX, p.z - b.lastZ) < 0.4 && p.dashT <= 0) {
      const side = Math.random() < 0.5 ? 1 : -1;
      b.ux = -mz * side; b.uz = mx * side; b.unstickT = 0.6; inp.jump = true;
    }
    b.lastX = p.x; b.lastZ = p.z; b.checkT = 0.5;
  }
  if (b.unstickT > 0) { b.unstickT -= dt; mx = b.ux; mz = b.uz; }
  inp.mx = mx * L.speed; inp.mz = mz * L.speed;
  if (!(e && d < engage) && m > 0.4) inp.yaw = Math.atan2(-mx, -mz);

  if (p.ablCd <= 0 && reacted && Math.random() < L.abl) {
    const hpFrac = p.hp / p.maxHp;
    const use = {
      tank: e && d < 3.5,
      archer: e && d < 4 && hpFrac < 0.6,
      mage: e && d < 4.5,
      gladiator: e && d > 2.5 && d < 7,
      rogue: e && d > 3.5 && d < 7.5,
      paladin: hpFrac < 0.5,
      bomber: e && d < 3,
      lancer: e && d > 4 && d < 13,
    }[p.cls];
    if (use) inp.abl = true;
  }
  return inp;
}

// ---------- tick ----------

function applyInput(room, p, inp, frozen) {
  const c = G.CLASSES[p.cls];
  let mx = Number(inp.mx) || 0, mz = Number(inp.mz) || 0;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  if (frozen || p.dead) { mx = 0; mz = 0; }
  if (Number.isFinite(inp.yaw)) p.yaw = inp.yaw;
  if (Number.isFinite(inp.pitch)) p.pitch = Math.max(-1.2, Math.min(1.2, inp.pitch));
  if (Number.isFinite(inp.ax) && Number.isFinite(inp.ay) && Number.isFinite(inp.az)) p.aim = { x: inp.ax, y: inp.ay, z: inp.az };
  p.moveX = mx; p.moveZ = mz;
  if (!p.dead) G.stepMove(p, { mx, mz, jump: !frozen && !!inp.jump }, G.DT, c.speed * (p.spdT > 0 ? G.SPEED_BUFF : 1));
  if (frozen || p.dead || p.protT > 0) return;
  if (inp.atk && p.atkCd <= 0) doAttack(room, p);
  if (inp.abl && p.ablCd <= 0) doAbility(room, p);
}

function tickRoom(room) {
  const dt = G.DT;
  room.events = [];
  const inMatch = room.phase === 'countdown' || room.phase === 'playing' || room.phase === 'sudden';
  if (!inMatch) return;
  room.time += dt;
  const frozen = room.phase === 'countdown';

  if (frozen) {
    room.timer -= dt;
    if (room.timer <= 0) {
      room.phase = 'playing'; room.timer = ROUND_TIME;
      for (const p of room.players.values()) p.protT = 0;
      broadcastLobby(room);
    }
  } else {
    room.timer -= dt;
    room.zoneT -= dt;
    if (room.zoneT <= G.ZONE_WARN && room.nextZoneIdx == null) {
      let n;
      do n = (Math.random() * G.ZONES.length) | 0; while (n === room.zoneIdx);
      room.nextZoneIdx = n;
    }
    if (room.zoneT <= 0) {
      room.zoneIdx = room.nextZoneIdx; room.nextZoneIdx = null; room.zoneT = G.ZONE_PERIOD;
      ev(room, { t: 'zone' });
    }
  }

  const now = Date.now();
  for (const p of room.players.values()) {
    if (!p.inMatch) continue;
    for (const k of ['atkCd', 'ablCd', 'protT', 'invulnT', 'invisT', 'shieldT', 'powT', 'spdT']) if (p[k] > 0) p[k] = Math.max(0, p[k] - dt);
    if (p.dead && !frozen) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) { spawn(room, p, false); ev(room, { t: 'spawn', id: p.id }); }
    }
    if (p.isBot) {
      applyInput(room, p, botThink(room, p), frozen);
    } else {
      // speed-hack guard: at most 4 inputs per tick, drop a backlog
      if (p.inputs.length > 15) p.inputs.splice(0, p.inputs.length - 15);
      const batch = p.inputs.splice(0, 4);
      for (const inp of batch) { applyInput(room, p, inp, frozen); p.lastSeq = inp.seq; }
      if (!batch.length && now - p.lastInputAt > 250) applyInput(room, p, {}, frozen);
    }
    if (p.lungeT > 0 && !p.dead) {
      p.lungeT -= dt;
      if (!p.lungeHit) {
        const f = G.facing(p.yaw);
        for (const e of enemiesOf(room, p)) {
          if (Math.hypot(e.x - p.x, e.z - p.z) < 1.4 && Math.abs(e.y - p.y) < 1.8) {
            damage(room, p, e, 25, f.x * 6, f.z * 6);
            p.lungeHit = true; p.dashT = 0; break;
          }
        }
      }
    }
    if (!p.dead && !frozen) {
      if (p.cls === 'paladin' && room.time - p.lastHurt > 4) p.hp = Math.min(p.maxHp, p.hp + 3 * dt);
    }
    // comeback boost ramps back down (one level every 4 s) once the streak is broken
    if (p.dryDeaths < 3 && p.pity > 0) p.pity = Math.max(0, p.pity - dt / 4);
  }

  if (!frozen) {
    updateProjectiles(room, dt);
    updateMeteors(room, dt);
    updatePickups(room, dt);
    scoreZone(room, dt);
    checkEnd(room);
  }
  sendSnapshot(room);
}

function updateMeteors(room, dt) {
  const active = room.phase === 'sudden' || (room.phase === 'playing' && room.timer <= G.METEOR_START);
  if (active) {
    if (!room.meteorAnnounced) { room.meteorAnnounced = true; ev(room, { t: 'meteors' }); }
    room.meteorT -= dt;
    if (room.meteorT <= 0) {
      room.meteorT = G.METEOR_INTERVAL;
      room.meteors.push({
        id: nextId++, t: 0, r: 0, maxR: 2.2 + Math.random() * 1.5,
        x: (Math.random() * 2 - 1) * (G.ARENA.halfX - 2), z: (Math.random() * 2 - 1) * (G.ARENA.halfZ - 2),
      });
    }
  }
  room.meteors = room.meteors.filter(m => {
    m.t += dt;
    m.r = m.maxR * Math.min(1, m.t / G.METEOR_GROW);
    if (m.t < G.METEOR_GROW + G.METEOR_FALL) return true;
    ev(room, { t: 'impact', x: m.x, z: m.z, r: m.maxR });
    for (const p of room.players.values()) {
      if (p.inMatch && !p.dead && p.protT <= 0 && Math.hypot(p.x - m.x, p.z - m.z) < m.maxR + 0.25) knockOut(room, null, p, 'meteor');
    }
    return false;
  });
}

const randKind = () => G.PICKUP_KINDS[(Math.random() * G.PICKUP_KINDS.length) | 0];

function initPickups() {
  return G.PICKUP_SPOTS.map((s, i) => ({ id: nextId++, x: s.x, z: s.z, k: randKind(), active: false, respawnT: 4 + i * 3 }));
}

function updatePickups(room, dt) {
  for (const pk of room.pickups) {
    if (!pk.active) {
      pk.respawnT -= dt;
      if (pk.respawnT <= 0) { pk.active = true; pk.k = randKind(); }
      continue;
    }
    for (const p of room.players.values()) {
      if (!p.inMatch || p.dead) continue;
      if (Math.hypot(p.x - pk.x, p.z - pk.z) > 1.2 || Math.abs(p.y - G.groundHeight(pk.x, pk.z)) > 1.8) continue;
      if (pk.k === 'heal') p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.5);
      if (pk.k === 'power') p.powT = G.BUFF_TIME;
      if (pk.k === 'speed') p.spdT = G.BUFF_TIME;
      ev(room, { t: 'pick', id: p.id, k: pk.k, x: pk.x, z: pk.z });
      pk.active = false; pk.respawnT = 15 + Math.random() * 8;
      break;
    }
  }
}

function scoreZone(room, dt) {
  const z = G.ZONES[room.zoneIdx];
  const occ = [...room.players.values()].filter(p => p.inMatch && !p.dead &&
    Math.hypot(p.x - z.x, p.z - z.z) < G.ZONE_RADIUS);
  for (const p of occ) if (p.cls === 'mage') p.hp = Math.min(p.maxHp, p.hp + 2 * dt);
  room.contested = false; room.holder = null;
  if (!occ.length) return;
  if (room.mode === 'teams') {
    const teams = new Set(occ.map(p => p.team));
    if (teams.size > 1) { room.contested = true; return; }
    const t = occ[0].team;
    room.holder = t;
    room.teamScore[t] += dt;
    for (const p of occ) p.score += dt;
  } else {
    if (occ.length > 1) { room.contested = true; return; }
    const p = occ[0];
    room.holder = p.id;
    if (room.phase === 'sudden' && !room.suddenIds.includes(p.id)) return;
    p.score += dt;
  }
}

function leaders(room) {
  if (room.mode === 'teams') {
    const inPlay = [...new Set([...room.players.values()].filter(p => p.inMatch).map(p => p.team))];
    const top = Math.max(...inPlay.map(t => Math.floor(room.teamScore[t])));
    return inPlay.filter(t => Math.floor(room.teamScore[t]) === top);
  }
  const ps = [...room.players.values()].filter(p => p.inMatch);
  const top = Math.max(...ps.map(p => Math.floor(p.score)));
  return ps.filter(p => Math.floor(p.score) === top).map(p => p.id);
}

function checkEnd(room) {
  if (room.phase === 'playing' && room.timer <= 0) {
    const l = leaders(room);
    if (l.length === 1) return endMatch(room, l[0]);
    room.phase = 'sudden'; room.timer = G.SUDDEN_DEATH_TIME; room.suddenIds = l;
    ev(room, { t: 'sudden' });
    broadcastLobby(room);
  } else if (room.phase === 'sudden') {
    const l = leaders(room);
    if (l.length === 1) return endMatch(room, l[0]);
    if (room.timer <= 0) return endMatch(room, 'draw');
  }
}

const r2 = v => Math.round(v * 100) / 100;

function sendSnapshot(room) {
  const snap = {
    phase: room.phase, timer: r2(Math.max(0, room.timer)),
    zone: { i: room.zoneIdx, next: room.nextZoneIdx, t: r2(room.zoneT), contested: room.contested, holder: room.holder },
    ts: Object.fromEntries(Object.entries(room.teamScore).map(([k, v]) => [k, Math.floor(v)])),
    mt: room.meteors.map(m => ({ id: m.id, x: r2(m.x), z: r2(m.z), r: r2(m.r), mr: r2(m.maxR), f: r2(Math.max(0, m.t - G.METEOR_GROW)) })),
    pk: room.pickups.filter(pk => pk.active).map(pk => ({ id: pk.id, k: pk.k, x: pk.x, z: pk.z })),
    p: [], pr: room.projectiles.map(pr => ({ id: pr.id, k: pr.kind, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z) })),
    ev: room.events,
  };
  for (const p of room.players.values()) {
    if (!p.inMatch) continue;
    snap.p.push({
      id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), hp: Math.ceil(p.hp), mhp: p.maxHp,
      dead: p.dead, rt: r2(p.respawnT), prot: p.protT > 0, inv: p.invisT > 0, sh: p.shieldT > 0, slow: p.slowT > 0,
      sc: Math.floor(p.score), ko: p.kos, pw: p.powT > 0, sp: p.spdT > 0, pwT: r2(p.powT), spT: r2(p.spdT),
      // movement + cooldown state, used by that player's own client for prediction and HUD
      vy: r2(p.vy), kx: r2(p.kx), kz: r2(p.kz), dT: r2(p.dashT), dX: r2(p.dashVX), dZ: r2(p.dashVZ), sT: r2(p.slowT),
      seq: p.lastSeq, aCd: r2(p.atkCd), bCd: r2(p.ablCd),
    });
  }
  io.to(room.code).emit('snap', snap);
}

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, 1000 / G.TICK_RATE);

// housekeeping: drop disconnected players after the grace period and empty rooms after 5 min
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const p of [...room.players.values()]) {
      if (!p.isBot && !p.connected && now - p.dcAt > DC_GRACE_MS) removePlayer(room, p);
    }
    if (humans(room).length === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) rooms.delete(code);
    if (humans(room).length === 0 && !room.emptySince) room.emptySince = now;
  }
}, 2000);

// ---------- sockets ----------

io.on('connection', socket => {
  let room = null, me = null;

  const isHost = () => room && me && room.hostId === me.id;

  function enter(r, p) {
    room = r; me = p;
    socket.join(r.code);
    r.emptySince = null;
  }

  socket.on('create', ({ name } = {}, cb) => {
    if (room) return;
    const code = makeCode();
    const r = {
      code, hostId: null, players: new Map(), mode: 'ffa', botLevel: 'normal', phase: 'lobby', results: null,
      projectiles: [], events: [], teamScore: Object.fromEntries(G.TEAMS.map(t => [t, 0])), meteors: [], pickups: [], zoneIdx: 0, nextZoneIdx: null, zoneT: G.ZONE_PERIOD,
      timer: 0, time: 0, emptySince: null,
    };
    rooms.set(code, r);
    const p = newPlayer(cleanName(name), { socketId: socket.id });
    r.players.set(p.id, p);
    r.hostId = p.id;
    assignColor(r, p);
    enter(r, p);
    cb && cb({ ok: true, code, you: p.id });
    broadcastLobby(r);
  });

  socket.on('join', ({ code, name } = {}, cb) => {
    if (room) return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return cb && cb({ ok: false, error: 'No room with that code.' });
    const n = cleanName(name);
    // rejoin within the grace window keeps your score
    let p = [...r.players.values()].find(q => !q.isBot && !q.connected && q.name === n);
    if (p) {
      p.connected = true; p.socketId = socket.id; p.inputs = [];
    } else {
      if (r.players.size >= G.MAX_PLAYERS) {
        const bot = [...r.players.values()].find(q => q.isBot);
        if (!bot || r.phase !== 'lobby') return cb && cb({ ok: false, error: 'Room is full.' });
        r.players.delete(bot.id); // a human takes a bot's seat in the lobby
      }
      if ([...r.players.values()].some(q => q.name === n)) return cb && cb({ ok: false, error: 'That name is taken in this room.' });
      p = newPlayer(n, { socketId: socket.id });
      if (r.mode === 'teams') p.team = smallerTeam(r, p);
      r.players.set(p.id, p);
      assignColor(r, p);
      if (r.phase === 'countdown' || r.phase === 'playing' || r.phase === 'sudden') initSim(r, p);
    }
    if (!r.hostId) r.hostId = p.id;
    enter(r, p);
    cb && cb({ ok: true, code: r.code, you: p.id });
    broadcastLobby(r);
  });

  socket.on('setClass', cls => {
    if (!me || !G.CLASSES[cls] || (room.phase !== 'lobby' && room.phase !== 'ended')) return;
    me.cls = cls; broadcastLobby(room);
  });

  socket.on('setTeam', team => {
    if (!me || room.mode !== 'teams' || !G.TEAMS.includes(team) || room.phase !== 'lobby') return;
    me.team = team; broadcastLobby(room);
  });

  socket.on('ready', val => {
    if (!me) return;
    me.ready = !!val; broadcastLobby(room);
  });

  socket.on('setMode', mode => {
    if (!isHost() || !['ffa', 'teams'].includes(mode) || room.phase !== 'lobby') return;
    room.mode = mode;
    if (mode === 'teams') rebalanceTeams(room);
    broadcastLobby(room);
  });

  socket.on('addBot', () => {
    if (!isHost() || room.phase !== 'lobby' || room.players.size >= G.MAX_PLAYERS) return;
    const used = new Set([...room.players.values()].map(p => p.cls));
    const free = G.CLASS_ORDER.filter(c => !used.has(c));
    const cls = free.length ? free[(Math.random() * free.length) | 0] : G.CLASS_ORDER[(Math.random() * 8) | 0];
    const names = new Set([...room.players.values()].map(p => p.name));
    const name = BOT_NAMES.find(n => !names.has('Bot ' + n)) || String(nextId);
    const p = newPlayer('Bot ' + name, { isBot: true, cls });
    if (room.mode === 'teams') p.team = smallerTeam(room, p);
    room.players.set(p.id, p);
    assignColor(room, p);
    broadcastLobby(room);
  });

  socket.on('setBotLevel', lvl => {
    if (!isHost() || !BOT_LEVELS[lvl] || room.phase !== 'lobby') return;
    room.botLevel = lvl; broadcastLobby(room);
  });

  socket.on('removeBot', id => {
    if (!isHost() || room.phase !== 'lobby') return;
    const p = room.players.get(id);
    if (p && p.isBot) { room.players.delete(id); broadcastLobby(room); }
  });

  socket.on('setBotTeam', ({ id, team } = {}) => {
    if (!isHost() || room.mode !== 'teams' || room.phase !== 'lobby' || !G.TEAMS.includes(team)) return;
    const p = room.players.get(id);
    if (p && p.isBot) { p.team = team; broadcastLobby(room); }
  });

  socket.on('start', () => {
    if (!isHost() || room.phase !== 'lobby') return;
    const ps = [...room.players.values()].filter(p => p.connected);
    if (ps.length < 2 || ps.some(p => !p.ready)) return;
    if (room.mode === 'teams') {
      const teams = new Set(ps.map(p => p.team));
      if (teams.size < 2) return;
    }
    startMatch(room);
  });

  socket.on('backToLobby', () => {
    if (!isHost() || room.phase !== 'ended') return;
    room.phase = 'lobby'; room.results = null;
    broadcastLobby(room);
  });

  socket.on('input', inp => {
    if (!me || !inp || typeof inp.seq !== 'number') return;
    me.inputs.push(inp);
    me.lastInputAt = Date.now();
  });

  socket.on('leave', () => {
    if (!room || !me) return;
    socket.leave(room.code);
    removePlayer(room, me);
    room = null; me = null;
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    if (room.phase === 'lobby' || room.phase === 'ended') return removePlayer(room, me);
    me.connected = false; me.dcAt = Date.now(); me.inputs = [];
    if (room.hostId === me.id) pickNewHost(room);
    broadcastLobby(room);
  });
});

server.listen(PORT, () => console.log(`Class Clash 3D on http://localhost:${PORT}`));
