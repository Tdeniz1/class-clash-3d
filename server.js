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
    aim: null, powT: 0, spdT: 0, pity: 0, dryDeaths: 0, dmgDone: 0, kingDmg: 0, guardDmg: 0, nextCls: null, auraT: 0,
    inputs: [], lastSeq: 0, lastInputAt: 0,
    bot: opts.isBot ? { strafeAng: Math.random() * 6.28, strafeT: 0, lastX: 0, lastZ: 0, checkT: 0, unstickT: 0, ux: 0, uz: 0,
      targetId: null, seenT: 0, aimErr: 0, aimGoal: 0, aimT: 0, swingAt: null } : null,
  };
}

function humans(room) { return [...room.players.values()].filter(p => !p.isBot); }
const teamMode = room => room.mode === 'teams' || room.mode === 'ktk';
const otherTeam = t => (t === 'red' ? 'blue' : 'red');
const kingOf = (room, team) => [...room.players.values()].find(q => q.isKing && q.team === team && q.inMatch);
const seatCount = room => [...room.players.values()].filter(q => !q.temp).length;

function assignColor(room, p) {
  const used = new Set([...room.players.values()].filter(q => q !== p).map(q => q.colorIdx));
  for (let i = 0; i < G.PLAYER_COLORS.length; i++) if (!used.has(i)) { p.colorIdx = i; return; }
}

function smallerTeam(room, except) {
  let red = 0, blue = 0;
  for (const q of room.players.values()) if (q !== except && !q.temp) q.team === 'red' ? red++ : blue++;
  return red <= blue ? 'red' : 'blue';
}

function rebalanceTeams(room) {
  let i = 0;
  for (const p of room.players.values()) p.team = i++ % 2 === 0 ? 'red' : 'blue';
}

function lobbyState(room) {
  return {
    code: room.code, hostId: room.hostId, mode: room.mode, botLevel: room.botLevel, phase: room.phase, results: room.results,
    map: room.map.key, layout: room.layout || null,
    draft: room.phase === 'draft' ? room.draft : null, draftLeft: room.phase === 'draft' ? room.draftT : 0,
    draftReady: room.phase === 'draft' ? [...room.draftReady] : [],
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, isBot: p.isBot, cls: p.cls, team: p.team, ready: p.ready,
      connected: p.connected, colorIdx: p.colorIdx, role: p.role || null, isKing: !!p.isKing, temp: !!p.temp,
    })),
  };
}

// Bots are named team + class (+ a number when a team has two of the same class): "Red Archer", "Blue Tank 2".
// Free-for-all has no teams, so just the class.
function nameBots(room) {
  const groups = new Map();
  for (const p of room.players.values()) {
    if (!p.isBot || p.isKing) continue;
    const base = (room.mode === 'ffa' ? '' : G.TEAM_NAMES[p.team] + ' ') + G.CLASSES[p.cls].name;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(p);
  }
  for (const [base, list] of groups) list.forEach((p, i) => { p.name = list.length > 1 ? `${base} ${i + 1}` : base; });
}

function broadcastLobby(room) { nameBots(room); io.to(room.code).emit('lobby', lobbyState(room)); }

function pickNewHost(room) {
  const h = humans(room).find(p => p.connected);
  room.hostId = h ? h.id : null;
}

function removePlayer(room, p) {
  if (room.mode === 'ktk' && p.inMatch && !p.isBot && ['countdown', 'playing', 'sudden'].includes(room.phase)) {
    const b = newPlayer(`${G.TEAM_NAMES[p.team]} ${p.role || 'M'}`, { isBot: true, cls: p.cls });
    Object.assign(b, { temp: true, team: p.team, role: p.role || 'M', lane: p.lane || 0 });
    initSim(room, b);
    Object.assign(b, { x: p.x, y: p.y, z: p.z, hp: p.dead ? b.maxHp : p.hp, dead: p.dead, respawnT: p.respawnT });
    room.players.set(b.id, b);
  }
  room.players.delete(p.id);
  if (room.hostId === p.id) pickNewHost(room);
  if (humans(room).length === 0) room.emptySince = Date.now();
  broadcastLobby(room);
}

// ---------- match setup ----------

function initSim(room, p) {
  const c = G.CLASSES[p.cls];
  p.maxHp = c.hp; p.hp = c.hp;
  p.score = 0; p.kos = 0; p.deaths = 0; p.pity = 0; p.dryDeaths = 0; p.dmgDone = 0; p.kingDmg = 0; p.guardDmg = 0; p.nextCls = null;
  p.inMatch = true; p.inputs = [];
  spawn(room, p, true);
}

// Is anything solid in the ~5 m behind a spawn point (where the camera sits)? side = -1 for Red (faces +x)
function viewBlocked(map, x, z, side) {
  for (let t = 0; t <= 5; t += 0.5) {
    const cx = x + side * t;
    if (map.pillars.some(pl => Math.hypot(pl.x - cx, pl.z - z) < pl.r + 2)) return true;
    if (map.walls.some(w => Math.abs(w.x - cx) < w.w / 2 + 1.5 && Math.abs(w.z - z) < w.d / 2 + 1.5)) return true;
  }
  return false;
}

function spawn(room, p, initial) {
  if (p.nextCls && G.CLASS_ORDER.includes(p.nextCls)) { p.cls = p.nextCls; p.maxHp = Math.round(G.CLASSES[p.cls].hp * (room.overtime ? G.OVERTIME.HP : 1)); }
  p.nextCls = null;
  let pos, yaw;
  if (room.mode === 'ktk') {
    // each role spawns on its own line of the team's half; Red defends x < 0
    const side = p.team === 'red' ? -1 : 1;
    const line = initial || p.isKing ? G.ROLE_SPAWN[p.role || 'M'] : G.RESPAWN_LINE;
    pos = { x: side * line, y: 0, z: initial ? (p.lane || 0) : (Math.random() * 2 - 1) * 10 };
    // slide sideways if a pillar or wall would sit between the camera and the player
    const z0 = pos.z;
    for (const dz of [0, 1.5, -1.5, 3, -3, 4.5, -4.5, 6, -6]) {
      const z = Math.max(-room.map.halfZ + 2, Math.min(room.map.halfZ - 2, z0 + dz));
      if (!viewBlocked(room.map, pos.x, z, side)) { pos.z = z; break; }
    }
    G.resolveCollision(pos, room.map);
    yaw = side * Math.PI / 2; // face the other team
  } else {
    const z = room.map.zones[room.zoneIdx];
    const taken = [...room.players.values()].filter(q => q !== p && q.inMatch && !q.dead);
    let best = room.map.spawns[0], bestScore = -Infinity;
    room.map.spawns.forEach((s, i) => {
      let score = Math.hypot(s.x - z.x, s.z - z.z);
      for (const q of taken) if (Math.hypot(q.x - s.x, q.z - s.z) < 2) score -= 100;
      if (initial) score = -i + Math.random() * 0.5 - (taken.some(q => Math.hypot(q.x - s.x, q.z - s.z) < 2) ? 100 : 0);
      if (score > bestScore) { bestScore = score; best = s; }
    });
    pos = best;
    yaw = Math.atan2(-(z.x - best.x), -(z.z - best.z));
  }
  Object.assign(p, {
    x: pos.x, z: pos.z, y: G.groundHeight(pos.x, pos.z, room.map), vy: 0, kx: 0, kz: 0,
    dashT: 0, slowT: 0, hp: p.maxHp, dead: false, respawnT: 0, protT: G.SPAWN_PROTECT,
    invulnT: 0, invisT: 0, shieldT: 0, lungeT: 0, atkCd: 0, ablCd: 0, powT: 0, spdT: 0,
  });
  p.yaw = yaw;
}

function startMatch(room) {
  const base = G.mapFor(room.mode);
  room.layout = G.randomLayout(base);
  room.map = G.withLayout(base, room.layout);
  if (room.mode === 'ktk') return startDraft(room);
  for (const p of room.players.values()) { p.role = null; p.lane = 0; }
  beginCountdown(room);
}

function beginCountdown(room) {
  room.phase = 'countdown';
  room.timer = G.COUNTDOWN_TIME;
  room.time = 0;
  room.zoneIdx = 0; room.nextZoneIdx = null; room.zoneT = G.ZONE_PERIOD;
  room.teamScore = Object.fromEntries(G.TEAMS.map(t => [t, 0]));
  room.meteors = []; room.meteorT = 0; room.meteorAnnounced = false;
  room.pickups = initPickups(room);
  room.projectiles = []; room.events = []; room.results = null; room.suddenIds = null;
  room.contested = false; room.holder = null; room.kingDown = null; room.frenzy = false; room.finale = null; room.overtime = false;
  room.skill = null;
  room.votes = new Map(); room.crowdT = G.CROWD_PERIOD;
  room.orders = { red: null, blue: null };
  for (const p of [...room.players.values()]) {
    if (!p.connected) { room.players.delete(p.id); continue; }
    initSim(room, p);
  }
  broadcastLobby(room);
}

// Late join in Kill the King: replace a bot (midfield first) on the team with fewer humans
function takeOverBot(room, p) {
  const bots = [...room.players.values()].filter(q => q.temp && !q.isKing && q.team === p.team && q.inMatch);
  const bot = bots.find(b => b.role === 'M') || bots.find(b => b.role === 'A') || bots[0];
  p.role = bot ? bot.role : 'M'; p.lane = bot ? bot.lane : 0;
  if (bot) p.cls = bot.cls;
  initSim(room, p);
  if (bot) {
    Object.assign(p, { x: bot.x, y: bot.y, z: bot.z, yaw: bot.yaw, hp: bot.dead ? p.maxHp : bot.hp, dead: bot.dead, respawnT: bot.respawnT });
    room.players.delete(bot.id);
    evLater(room, { t: 'joined', id: p.id, took: bot.name });
  }
}

// ---------- Kill the King: draft ----------
// Classes the game picks for bot spots nobody chose, by role
const ROLE_CLASSES = {
  D: ['tank', 'paladin', 'lancer', 'mage'],
  M: ['gladiator', 'mage', 'bomber', 'paladin', 'lancer'],
  A: ['rogue', 'archer', 'gladiator', 'bomber'],
};
const pickFor = role => ROLE_CLASSES[role][(Math.random() * ROLE_CLASSES[role].length) | 0];

// Build the 8 spots for a line-up, keeping earlier choices for spots that still exist
function makeSlots(formation, old = []) {
  const slots = [];
  ['D', 'M', 'A'].forEach((role, ri) => {
    const prev = old.filter(sl => sl.role === role);
    for (let i = 0; i < formation[ri]; i++) {
      const o = prev[i];
      slots.push({ role, cls: o ? o.cls : pickFor(role), humanId: o ? o.humanId : null });
    }
  });
  return slots;
}

const teamHumans = (room, team) => [...room.players.values()].filter(p => !p.isBot && p.connected && p.team === team);

function assignFreeSlot(draft, p, prefer = ['M', 'A', 'D']) {
  for (const role of prefer) {
    const sl = draft.slots.find(x => x.role === role && !x.humanId);
    if (sl) { sl.humanId = p.id; sl.cls = p.cls; return true; }
  }
  return false;
}

function startDraft(room) {
  room.phase = 'draft'; room.draftT = G.DRAFT_TIME; room.results = null; room.draftReady = new Set();
  for (const p of [...room.players.values()]) if (p.isBot || !p.connected) room.players.delete(p.id);
  room.draft = {};
  for (const team of ['red', 'blue']) {
    const d = room.draft[team] = { formation: [3, 3, 2], slots: makeSlots([3, 3, 2]) };
    for (const p of teamHumans(room, team)) assignFreeSlot(d, p);
  }
  broadcastLobby(room);
}

// Draft is over: humans take their spots, bots fill the rest, each team gets a King
function finalizeDraft(room) {
  for (const team of ['red', 'blue']) {
    const d = room.draft[team];
    for (const sl of d.slots) {
      const h = sl.humanId && room.players.get(sl.humanId);
      if (!h || !h.connected) sl.humanId = null;
    }
    for (const p of teamHumans(room, team)) if (!d.slots.some(sl => sl.humanId === p.id)) assignFreeSlot(d, p);
    const idx = { D: 0, M: 0, A: 0 }, count = { D: d.formation[0], M: d.formation[1], A: d.formation[2] };
    for (const sl of d.slots) {
      const i = idx[sl.role]++, n = count[sl.role];
      const lane = n > 1 ? -10 + 20 * i / (n - 1) : 0; // spread each line across the width
      let p;
      if (sl.humanId) { p = room.players.get(sl.humanId); p.cls = sl.cls; }
      else {
        p = newPlayer(`${G.TEAM_NAMES[team]} ${sl.role}${i + 1}`, { isBot: true, cls: sl.cls });
        p.temp = true; p.team = team;
        room.players.set(p.id, p);
      }
      p.role = sl.role; p.lane = lane;
    }
    const king = newPlayer(G.TEAM_NAMES[team] + ' King', { isBot: true, cls: 'king' });
    Object.assign(king, { temp: true, isKing: true, team, role: 'K', lane: 0 });
    room.players.set(king.id, king);
  }
  room.draft = null;
  beginCountdown(room);
}

function endMatch(room, winner) {
  room.phase = 'ended';
  const list = [...room.players.values()].filter(p => p.inMatch && !p.isKing).map(p => ({
    id: p.id, name: p.name, cls: p.cls, team: p.team, isBot: p.isBot, role: p.role || null,
    score: Math.floor(p.score), kos: p.kos, deaths: p.deaths, dmg: Math.round(p.dmgDone), kingDmg: Math.round(p.kingDmg), guardDmg: Math.round(p.guardDmg),
  })).sort((a, b) => b.score - a.score || b.kos - a.kos);
  const kingHp = {};
  if (room.mode === 'ktk') for (const t of ['red', 'blue']) { const k = kingOf(room, t); kingHp[t] = k ? Math.ceil(Math.max(0, k.hp)) : 0; }
  room.results = {
    mode: room.mode, winner, players: list,
    teamScore: Object.fromEntries(Object.entries(room.teamScore).map(([k, v]) => [k, Math.floor(v)])),
    teams: [...new Set(list.map(p => p.team))], kingHp,
    awards: mvpAwards(room.mode, list),
  };
  for (const p of [...room.players.values()]) {
    if (p.temp) { room.players.delete(p.id); continue; }
    p.inMatch = false; p.role = null;
    if (!p.isBot) p.ready = false;
  }
  broadcastLobby(room);
}

// Post-match award cards. Ties go to humans, then to the higher score.
function mvpAwards(mode, list) {
  const pick = (key, lowest = false) => {
    const pool = lowest ? list.filter(p => p.kos > 0 || p.score > 0) : list.filter(p => p[key] > 0);
    if (!pool.length) return null;
    return [...pool].sort((a, b) => (lowest ? a[key] - b[key] : b[key] - a[key]) || (a.isBot - b.isBot) || (b.score - a.score))[0];
  };
  const defs = mode === 'ktk'
    ? [['👑', 'King Slayer', 'kingDmg', 'damage to the King'], ['⚔️', 'Top Fighter', 'kos', 'knockouts'],
       ['🛡️', 'Royal Guard', 'guardDmg', 'damage near your King'], ['💥', 'Most Damage', 'dmg', 'total damage']]
    : [['🏛️', 'Zone Master', 'score', 'points'], ['⚔️', 'Top Fighter', 'kos', 'knockouts'],
       ['💥', 'Most Damage', 'dmg', 'total damage'], ['🧱', 'Survivor', 'deaths', 'deaths', true]];
  return defs.map(([icon, title, key, unit, lowest]) => {
    const p = pick(key, lowest);
    return p && { icon, title, unit, value: p[key], id: p.id, name: p.name, cls: p.cls, team: p.team, isBot: p.isBot };
  }).filter(Boolean);
}

// ---------- combat ----------

function ev(room, e) { room.events.push(e); }
// events raised outside the game tick (joins) go out with the next snapshot
function evLater(room, e) { (room.pendingEvents ||= []).push(e); }

function enemiesOf(room, p) {
  const out = [];
  for (const q of room.players.values()) {
    if (q === p || !q.inMatch || q.dead) continue;
    if (teamMode(room) && q.team === p.team) continue;
    out.push(q);
  }
  return out;
}

function alliesOf(room, p) {
  return [...room.players.values()].filter(q => q.inMatch && !q.dead &&
    (q === p || (teamMode(room) && q.team === p.team)));
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
  if (e.isKing && kingGuarded(room, e)) amt *= G.KING_GUARD.DMG; // guarded King shrugs off half
  if (room.frenzy) amt *= 2; // final 30 s of Kill the King
  if (room.overtime) amt *= G.OVERTIME.DMG;
  amt = Math.max(1, Math.round(amt));
  e.hp -= amt;
  e.lastHurt = room.time;
  const res = e.cls === 'tank' ? 0.7 : 1;
  e.kx += kbx * res; e.kz += kbz * res;
  ev(room, { t: 'hit', id: e.id, by: src ? src.id : null, amt, x: e.x, y: e.y + 2, z: e.z });
  if (src && src !== e) {
    src.dmgDone += amt;
    if (e.isKing) src.kingDmg += amt;
    if (room.mode === 'ktk') { const own = kingOf(room, src.team); if (own && !own.dead && Math.hypot(e.x - own.x, e.z - own.z) < 12) src.guardDmg += amt; }
  }
  if (e.isKing && src) src.score += amt / 10; // chipping the King is worth points
  if (e.hp <= 0) knockOut(room, src, e);
  return true;
}

function kingGuarded(room, k) {
  let n = 0;
  for (const q of room.players.values()) {
    if (q !== k && q.inMatch && !q.dead && q.team === k.team && Math.hypot(q.x - k.x, q.z - k.z) < G.KING_GUARD.R) n++;
  }
  return n >= G.KING_GUARD.MIN;
}

function knockOut(room, src, e, cause) {
  e.hp = 0; e.dead = true; e.deaths++;
  e.respawnT = room.overtime ? G.FRENZY_RESPAWN : room.mode !== 'ktk' ? G.RESPAWN_TIME : room.frenzy ? G.FRENZY_RESPAWN : G.KTK_RESPAWN;
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
  if (e.isKing) { room.kingDown = e.team; e.respawnT = Infinity; }
  // knocked-out bots join the crowd vote: mostly for a drop on their own side
  if (e.isBot && !e.isKing && room.votes) {
    const r = Math.random(), n = room.map.voteSpots.length;
    let pick = (Math.random() * n) | 0;
    if (room.mode === 'ktk') pick = r < 0.65 ? (e.team === 'red' ? 0 : 2) : r < 0.9 ? 1 : (e.team === 'red' ? 2 : 0);
    room.votes.set(e.id, pick);
  }
  ev(room, { t: 'ko', id: e.id, by: src ? src.id : null, x: e.x, y: e.y, z: e.z, cause, king: !!e.isKing });
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
  p.atkCd = a.cd + (p.isBot ? botLevelFor(room, p.team).extraCd * (0.5 + Math.random()) : 0);
  p.invisT = 0;
  ev(room, { t: 'atk', id: p.id });
  if (a.type !== 'melee') return spawnProjectile(room, p, a.type, a);

  // humans get a forgiving swing: wider cone, more reach, and point-blank hits anything in front
  const A = G.MELEE_ASSIST, human = !p.isBot;
  const arc = human ? Math.max(a.arc + A.ARC_BONUS, A.MIN_ARC) : a.arc;
  const reach = a.range + (human ? A.RANGE_BONUS : 0);
  const f = G.facing(p.yaw), cosA = Math.cos(arc / 2 * Math.PI / 180);
  for (const e of enemiesOf(room, p)) {
    const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
    if (d > reach + G.PLAYER_RADIUS || Math.abs(e.y - p.y) > (human ? 2.3 : 1.8)) continue;
    const dot = d > 0.15 ? (dx * f.x + dz * f.z) / d : 1;
    if (human && d < A.CLOSE ? dot < -0.2 : dot < cosA) continue;
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
  p.ablCd = c.ability.cd + (p.isBot ? botLevelFor(room, p.team).extraCd * 3 : 0);
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
        G.resolveCollision(s, room.map);
        if (Math.hypot(s.x - tx, s.z - tz) > 0.2) break;
      }
      p.x = s.x; p.z = s.z; p.y = Math.max(p.y, G.groundHeight(p.x, p.z, room.map));
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
    damage(room, owner, e, pr.dmg * (e.isKing ? 0.5 : 1), nx * pr.kb, nz * pr.kb); // the King shrugs off half of splash damage
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
          if (Math.hypot(e.x - pr.x, e.y + 0.9 - pr.y, e.z - pr.z) < (owner.isBot ? G.PROJECTILE_HIT_R.bot : G.PROJECTILE_HIT_R.human)) {
            hitProjectile(room, pr, owner, e, pr.x, pr.y, pr.z); done = true; break;
          }
        }
      }
      if (!done && G.isSolid(pr.x, pr.y, pr.z, room.map)) {
        if (pr.splash) explode(room, pr, owner, pr.x, Math.max(pr.y, G.groundHeight(pr.x, pr.z, room.map)), pr.z);
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
const BASE_SKILL = { easy: 0, normal: 0.5, hard: 1 };
// Bot settings for a team at its current skill (blend of the easy / normal / hard tables)
function botLevelFor(room, team) {
  const sk = room.skill && room.skill[team] != null ? room.skill[team] : BASE_SKILL[room.botLevel] ?? 0.5;
  const [a, b, t] = sk <= 0.5 ? [BOT_LEVELS.easy, BOT_LEVELS.normal, sk / 0.5] : [BOT_LEVELS.normal, BOT_LEVELS.hard, (sk - 0.5) / 0.5];
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
// Comeback bots: the team that's behind gets sharper bots, the team that's ahead gets weaker ones
function updateSkill(room, dt) {
  if (room.mode !== 'ktk' && room.mode !== 'teams') return;
  const base = BASE_SKILL[room.botLevel] ?? 0.5;
  room.skill = room.skill || { red: base, blue: base };
  let lead = 0; // red's lead, -1..1
  if (room.mode === 'ktk') {
    const r = kingOf(room, 'red'), b = kingOf(room, 'blue');
    if (r && b) lead = r.hp / r.maxHp - b.hp / b.maxHp;
  } else {
    const r = room.teamScore.red || 0, b = room.teamScore.blue || 0;
    lead = (r - b) / Math.max(20, r + b);
  }
  for (const [t, sign] of [['red', 1], ['blue', -1]]) {
    const target = Math.max(0, Math.min(1, base - sign * lead * G.RUBBER_BAND));
    room.skill[t] += (target - room.skill[t]) * Math.min(1, dt * 0.5);
  }
}

function botThink(room, p) {
  const b = p.bot, c = G.CLASSES[p.cls], dt = G.DT, L = botLevelFor(room, p.team);
  const inp = { mx: 0, mz: 0, jump: false, atk: false, abl: false, yaw: p.yaw, pitch: -0.1 };
  if (p.dead || room.phase === 'countdown') return inp;

  if (p.isKing) return kingThink(room, p, inp);
  const ranged = c.attack.type !== 'melee';
  let engage = ranged ? Math.min(c.attack.range, 18) : 7;
  // goal = where this bot wants to be; holdR = how close counts as "there"
  let goal, holdR, e = null, d = Infinity;
  const visible = enemiesOf(room, p).filter(q => q.invisT <= 0);
  const nearestTo = (x, z, maxD) => {
    let best = null, bd = maxD;
    for (const q of visible) { const dd = Math.hypot(q.x - x, q.z - z); if (dd < bd) { bd = dd; best = q; } }
    return best;
  };
  if (room.mode === 'ktk') {
    const fwd = p.team === 'red' ? 1 : -1;
    const own = kingOf(room, p.team), foe = kingOf(room, otherTeam(p.team));
    holdR = 2.5;
    if (p.role === 'D') {
      // cover our whole half: chase any enemy on our side, otherwise guard in front of the King
      const kx = own ? own.x : -fwd * G.KING_HOME;
      goal = { x: kx + fwd * 4, z: (own ? own.z : 0) + (p.lane || 0) * 0.35 };
      let best = null, bd = Infinity;
      for (const q of visible) {
        if (q.x * fwd > 0) continue; // only enemies in our half
        const dd = Math.hypot(q.x - p.x, q.z - p.z);
        if (dd < bd) { bd = dd; best = q; }
      }
      e = best;
      engage = 40;
    } else if (p.role === 'A') {
      // push for the enemy King; fight whoever blocks the way
      goal = foe && !foe.dead ? { x: foe.x, z: foe.z } : { x: fwd * G.KING_HOME, z: 0 };
      e = foe && !foe.dead && Math.hypot(foe.x - p.x, foe.z - p.z) < 14 ? foe : nearestTo(p.x, p.z, 6);
    } else {
      // midfield: roam the whole map, hunt anyone within reach, otherwise push just past halfway
      goal = { x: fwd * 6, z: (p.lane || 0) };
      e = nearestTo(p.x, p.z, 18);
      engage = 18;
    }
    // squad order from a human teammate overrides the role's default plan
    const ord = room.orders && room.orders[p.team];
    if (ord && ord.until > room.time) {
      const leader = ord.leaderId && room.players.get(ord.leaderId);
      if (ord.cmd === 'attack' && p.role !== 'D') { // defenders stay home and keep the King guarded
        goal = foe && !foe.dead ? { x: foe.x, z: foe.z + (p.lane || 0) * 0.3 } : { x: fwd * G.KING_HOME, z: 0 };
        e = foe && !foe.dead && Math.hypot(foe.x - p.x, foe.z - p.z) < 16 ? foe : nearestTo(p.x, p.z, 8);
        engage = 16;
      } else if (ord.cmd === 'defend') {
        const kx = own ? own.x : -fwd * G.KING_HOME, kz = own ? own.z : 0;
        goal = { x: kx + fwd * 2, z: kz + (p.lane || 0) * 0.22 }; // hug the King so he stays guarded
        e = own ? nearestTo(own.x, own.z, 14) : null;
        engage = 30;
      } else if (ord.cmd === 'follow' && leader && !leader.dead && leader.inMatch) {
        goal = { x: leader.x - fwd * 2.5, z: leader.z + (p.lane || 0) * 0.35 };
        e = nearestTo(leader.x, leader.z, 11);
        engage = 20;
      } else if (ord.cmd === 'focus') {
        const tg = room.players.get(ord.targetId);
        if (tg && tg.inMatch && !tg.dead && tg.invisT <= 0) { goal = { x: tg.x, z: tg.z }; e = tg; engage = 60; }
      }
    }
    // bots respect their zone (humans don't)
    if (p.role === 'D' && goal.x * fwd > -1) goal.x = -fwd;
    if (p.role === 'A' && goal.x * fwd < -G.ATTACKER_LIMIT + 1) goal.x = (-G.ATTACKER_LIMIT + 1) * fwd;
  } else {
    goal = (room.nextZoneIdx != null && room.zoneT < 3) ? room.map.zones[room.nextZoneIdx] : room.map.zones[room.zoneIdx];
    holdR = G.ZONE_RADIUS - 1.2;
    e = nearestTo(p.x, p.z, Infinity);
  }
  if (e) d = Math.hypot(e.x - p.x, e.z - p.z);
  const zd = Math.hypot(goal.x - p.x, goal.z - p.z);
  let tx = goal.x, tz = goal.z;

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
  if (zd < holdR) { tx = p.x + Math.cos(b.strafeAng) * 2; tz = p.z + Math.sin(b.strafeAng) * 2; }

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
      if (d < 6 || zd < holdR + 4 || room.mode === 'ktk') {
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

// The King: wanders slowly around his base, swings at anyone in reach, backs away from threats.
function kingThink(room, p, inp) {
  const b = p.bot, fwd = p.team === 'red' ? 1 : -1, hx = -fwd * G.KING_HOME;
  let e = null, d = Infinity;
  for (const q of enemiesOf(room, p)) {
    if (q.invisT > 0) continue;
    const dd = Math.hypot(q.x - p.x, q.z - p.z);
    if (dd < d) { d = dd; e = q; }
  }
  b.strafeT -= G.DT;
  if (b.strafeT <= 0 || b.wx == null) { b.wx = hx + (Math.random() * 2 - 1) * 4; b.wz = (Math.random() * 2 - 1) * 5; b.strafeT = 3 + Math.random() * 2; }
  let tx = b.wx, tz = b.wz;
  if (e && d < 3.2) {
    tx = p.x; tz = p.z;
    inp.yaw = Math.atan2(-(e.x - p.x), -(e.z - p.z));
    if (p.atkCd <= 0) inp.atk = true;
  } else if (e && d < 9) {
    tx = hx - fwd * 2; tz = p.z * 0.5; // retreat toward the back of the base
    inp.yaw = Math.atan2(-(e.x - p.x), -(e.z - p.z));
  }
  let mx = tx - p.x, mz = tz - p.z;
  const m = Math.hypot(mx, mz);
  if (m > 0.5) { mx /= m; mz /= m; } else { mx = 0; mz = 0; }
  inp.mx = mx; inp.mz = mz;
  if (!(e && d < 9) && m > 0.5) inp.yaw = Math.atan2(-mx, -mz);
  return inp;
}

// Kill the King bots stay in their zone: defenders never cross halfway, attackers never
// drop into the deepest 25% of their own half, the King stays near his base. Humans are free.
function clampBotRole(room, p) {
  if (room.mode !== 'ktk' || !p.isBot || !p.role) return;
  const fwd = p.team === 'red' ? 1 : -1;
  if (p.role === 'D' && p.x * fwd > 0) p.x = 0;
  if (p.role === 'A' && p.x * fwd < -G.ATTACKER_LIMIT) p.x = -G.ATTACKER_LIMIT * fwd;
  if (p.isKing) {
    const hx = -fwd * G.KING_HOME, dx = p.x - hx, dz = p.z, dd = Math.hypot(dx, dz);
    if (dd > 8) { p.x = hx + dx / dd * 8; p.z = dz / dd * 8; }
  }
}

// ---------- tick ----------

function applyInput(room, p, inp, frozen, dt = G.DT) {
  const c = G.CLASSES[p.cls];
  let mx = Number(inp.mx) || 0, mz = Number(inp.mz) || 0;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  if (frozen || p.dead) { mx = 0; mz = 0; }
  if (Number.isFinite(inp.yaw)) p.yaw = inp.yaw;
  if (Number.isFinite(inp.pitch)) p.pitch = Math.max(-1.2, Math.min(1.2, inp.pitch));
  if (Number.isFinite(inp.ax) && Number.isFinite(inp.ay) && Number.isFinite(inp.az)) p.aim = { x: inp.ax, y: inp.ay, z: inp.az };
  p.moveX = mx; p.moveZ = mz;
  if (!p.dead) G.stepMove(p, { mx, mz, jump: !frozen && !!inp.jump }, dt, c.speed * (p.spdT > 0 ? G.SPEED_BUFF : 1) * (p.auraT > 0 ? G.KING_AURA.SPEED : 1) * (room.overtime ? G.OVERTIME.SPEED : 1), room.map);
  clampBotRole(room, p);
  if (frozen || p.dead || p.protT > 0) return;
  if (inp.atk && p.atkCd <= 0) doAttack(room, p);
  if (inp.abl && p.ablCd <= 0) doAbility(room, p);
}

function tickRoom(room) {
  // during the finale the whole game runs in slow motion
  const dt = G.DT * (room.finale ? G.FINALE_SLOW : 1);
  room.events = room.pendingEvents || [];
  room.pendingEvents = [];
  if (room.phase === 'draft') {
    room.draftT -= dt;
    const hs = humans(room).filter(p => p.connected);
    if (room.draftT <= 0 || (hs.length && hs.every(p => room.draftReady.has(p.id)))) finalizeDraft(room);
    return;
  }
  const inMatch = room.phase === 'countdown' || room.phase === 'playing' || room.phase === 'sudden';
  if (!inMatch) return;
  room.time += dt;
  const frozen = room.phase === 'countdown' || !!room.finale; // no control during the finale
  if (room.finale) {
    room.finale.t -= G.DT;
    if (room.finale.t <= 0) { const w = room.finale.winner; room.finale = null; endMatch(room, w); return; }
  }

  if (room.finale) {
    // clock stops; physics keeps going slowly
  } else if (frozen) {
    room.timer -= dt;
    if (room.timer <= 0) {
      room.phase = 'playing';
      room.timer = room.mode === 'ktk' ? (Number(process.env.ROUND_TIME) || G.KTK_TIME) : ROUND_TIME;
      for (const p of room.players.values()) p.protT = 0;
      broadcastLobby(room);
    }
  } else {
    room.timer -= dt;
    if (room.mode === 'ktk' && room.phase === 'playing' && room.timer <= G.FRENZY_TIME && !room.frenzy && !room.overtime) {
      room.frenzy = true;
      ev(room, { t: 'frenzy' });
      // anyone already waiting gets the short respawn too
      for (const p of room.players.values()) if (p.dead && !p.isKing) p.respawnT = Math.min(p.respawnT, G.FRENZY_RESPAWN);
    }
    if (room.mode !== 'ktk') {
      room.zoneT -= dt;
      if (room.zoneT <= G.ZONE_WARN && room.nextZoneIdx == null) {
        let n;
        do n = (Math.random() * room.map.zones.length) | 0; while (n === room.zoneIdx);
        room.nextZoneIdx = n;
      }
      if (room.zoneT <= 0) {
        room.zoneIdx = room.nextZoneIdx; room.nextZoneIdx = null; room.zoneT = G.ZONE_PERIOD;
        ev(room, { t: 'zone' });
      }
    }
  }

  const now = Date.now();
  for (const p of room.players.values()) {
    if (!p.inMatch) continue;
    for (const k of ['atkCd', 'ablCd', 'protT', 'invulnT', 'invisT', 'shieldT', 'powT', 'spdT', 'auraT']) if (p[k] > 0) p[k] = Math.max(0, p[k] - dt);
    if (p.dead && !frozen && !p.isKing && !room.finale) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) { spawn(room, p, false); ev(room, { t: 'spawn', id: p.id }); }
    }
    if (p.isBot) {
      applyInput(room, p, botThink(room, p), frozen, dt);
    } else {
      // speed-hack guard: at most 4 inputs per tick, drop a backlog
      if (p.inputs.length > 15) p.inputs.splice(0, p.inputs.length - 15);
      const batch = p.inputs.splice(0, 4);
      for (const inp of batch) { applyInput(room, p, inp, frozen, dt); p.lastSeq = inp.seq; }
      if (!batch.length && now - p.lastInputAt > 250) applyInput(room, p, {}, frozen, dt);
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

  if (room.mode === 'ktk' && !frozen) updateKingAura(room, dt);
  if (!frozen) updateSkill(room, dt);
  if (room.finale) updateProjectiles(room, dt); // arrows and bombs finish their flight in slow motion
  if (!frozen) {
    updateCrowd(room, dt);
    updateProjectiles(room, dt);
    updateMeteors(room, dt);
    updatePickups(room, dt);
    scoreZone(room, dt);
    checkEnd(room);
  }
  sendSnapshot(room);
}

// King's aura: always on. Heal allies close to him, speed up allies a bit further out.
function updateKingAura(room, dt) {
  const A = G.KING_AURA;
  for (const k of room.players.values()) {
    if (!k.isKing || !k.inMatch || k.dead) continue;
    for (const p of room.players.values()) {
      if (p === k || !p.inMatch || p.dead || p.team !== k.team) continue;
      const d = Math.hypot(p.x - k.x, p.z - k.z);
      if (d < A.SPEED_R) p.auraT = 0.25;
      if (d < A.HEAL_R) p.hp = Math.min(p.maxHp, p.hp + A.HEAL * dt);
    }
  }
}

// The Crowd: knocked-out players vote; every CROWD_PERIOD s the top spot gets a bonus power-up
function updateCrowd(room, dt) {
  if (room.phase !== 'playing' && room.phase !== 'sudden') return;
  room.crowdT -= dt;
  if (room.crowdT > 0) return;
  room.crowdT = G.CROWD_PERIOD;
  if (!room.votes.size) return;
  const tally = new Map();
  for (const v of room.votes.values()) tally.set(v, (tally.get(v) || 0) + 1);
  const top = Math.max(...tally.values());
  const winners = [...tally.keys()].filter(k => tally.get(k) === top);
  const idx = winners[(Math.random() * winners.length) | 0];
  const spot = room.map.voteSpots[idx];
  const k = randKind();
  room.pickups.push({ id: nextId++, x: spot.x, z: spot.z + 1.6, k, active: true, crowd: true, respawnT: 0 });
  ev(room, { t: 'crowd', k, spot: idx, votes: room.votes.size });
  room.votes.clear();
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
        x: (Math.random() * 2 - 1) * (room.map.halfX - 2), z: (Math.random() * 2 - 1) * (room.map.halfZ - 2),
      });
    }
  }
  room.meteors = room.meteors.filter(m => {
    m.t += dt;
    m.r = m.maxR * Math.min(1, m.t / G.METEOR_GROW);
    if (m.t < G.METEOR_GROW + G.METEOR_FALL) return true;
    ev(room, { t: 'impact', x: m.x, z: m.z, r: m.maxR });
    for (const p of room.players.values()) {
      if (p.inMatch && !p.dead && !p.isKing && p.protT <= 0 && Math.hypot(p.x - m.x, p.z - m.z) < m.maxR + 0.25) knockOut(room, null, p, 'meteor');
    }
    return false;
  });
}

const randKind = () => G.PICKUP_KINDS[(Math.random() * G.PICKUP_KINDS.length) | 0];

function initPickups(room) {
  return room.map.pickups.map((s, i) => ({ id: nextId++, x: s.x, z: s.z, k: randKind(), active: false, respawnT: 4 + i * 3 }));
}

function updatePickups(room, dt) {
  room.pickups = room.pickups.filter(pk => !pk.gone);
  for (const pk of room.pickups) {
    if (!pk.active) {
      pk.respawnT -= dt * (room.frenzy ? G.FRENZY_PICKUP_RATE : 1);
      if (pk.respawnT <= 0) { pk.active = true; pk.k = randKind(); }
      continue;
    }
    for (const p of room.players.values()) {
      if (!p.inMatch || p.dead) continue;
      if (p.isKing || Math.hypot(p.x - pk.x, p.z - pk.z) > 1.2 || Math.abs(p.y - G.groundHeight(pk.x, pk.z, room.map)) > 1.8) continue;
      if (pk.k === 'heal') p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.5);
      if (pk.k === 'power') p.powT = G.BUFF_TIME;
      if (pk.k === 'speed') p.spdT = G.BUFF_TIME;
      ev(room, { t: 'pick', id: p.id, k: pk.k, x: pk.x, z: pk.z });
      pk.active = false; pk.respawnT = 15 + Math.random() * 8;
      if (pk.crowd) pk.gone = true;
      break;
    }
  }
}

function scoreZone(room, dt) {
  if (room.mode === 'ktk') return;
  const z = room.map.zones[room.zoneIdx];
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
  if (room.finale) return;
  if (room.mode === 'ktk') {
    if (room.kingDown) return startFinale(room, otherTeam(room.kingDown));
    if ((room.phase === 'playing' || room.phase === 'sudden') && room.timer <= 0) {
      // time's up: the King with more health left wins; too close to call = overtime (once)
      const r = kingOf(room, 'red'), b = kingOf(room, 'blue');
      const rf = r ? r.hp / r.maxHp : 0, bf = b ? b.hp / b.maxHp : 0;
      if (room.phase === 'playing' && Math.abs(rf - bf) < G.TIE_MARGIN) return startOvertime(room, G.OVERTIME_TIME);
      return startFinale(room, Math.abs(rf - bf) < 0.005 ? 'draw' : rf > bf ? 'red' : 'blue');
    }
    return;
  }
  if (room.phase === 'playing' && room.timer <= 0) {
    const l = leaders(room);
    if (l.length === 1) return startFinale(room, l[0]);
    room.suddenIds = l;
    startOvertime(room, G.SUDDEN_DEATH_TIME);
  } else if (room.phase === 'sudden') {
    const l = leaders(room);
    if (l.length === 1) return startFinale(room, l[0]);
    if (room.timer <= 0) return startFinale(room, 'draw');
  }
}

// Overtime: health halved, damage and speed doubled
function startOvertime(room, seconds) {
  room.phase = 'sudden'; room.overtime = true; room.frenzy = false; room.timer = seconds;
  for (const p of room.players.values()) {
    if (!p.inMatch) continue;
    p.maxHp = Math.round(p.maxHp * G.OVERTIME.HP);
    p.hp = Math.min(p.maxHp, Math.ceil(p.hp * G.OVERTIME.HP));
    if (p.dead && !p.isKing) p.respawnT = Math.min(p.respawnT, G.FRENZY_RESPAWN);
  }
  ev(room, { t: 'overtime' });
  broadcastLobby(room);
}

// Slow-motion finale: announce the winner, let the moment play out, then show results
function startFinale(room, winner) {
  let focus = null;
  if (room.mode === 'ktk') {
    const fallen = room.kingDown && kingOf(room, room.kingDown);
    focus = fallen ? fallen.id : (winner !== 'draw' && kingOf(room, winner) ? kingOf(room, winner).id : null);
  } else if (room.mode === 'ffa') focus = winner !== 'draw' ? winner : null;
  else if (winner !== 'draw') {
    const best = [...room.players.values()].filter(p => p.inMatch && p.team === winner).sort((x, y) => y.score - x.score)[0];
    focus = best ? best.id : null;
  }
  const reason = room.mode === 'ktk' ? (room.kingDown ? 'king' : 'time') : 'score';
  room.finale = { winner, focus, reason, t: G.FINALE_TIME };
  ev(room, { t: 'finale', w: winner, f: focus, r: reason });
}

const r2 = v => Math.round(v * 100) / 100;

function sendSnapshot(room) {
  const snap = {
    phase: room.phase, timer: r2(Math.max(0, room.timer)), fz: !!room.frenzy, ot: !!room.overtime,
    fin: room.finale ? { w: room.finale.winner, f: room.finale.focus, r: room.finale.reason } : null,
    zone: { i: room.zoneIdx, next: room.nextZoneIdx, t: r2(room.zoneT), contested: room.contested, holder: room.holder },
    ts: Object.fromEntries(Object.entries(room.teamScore).map(([k, v]) => [k, Math.floor(v)])),
    mt: room.meteors.map(m => ({ id: m.id, x: r2(m.x), z: r2(m.z), r: r2(m.r), mr: r2(m.maxR), f: r2(Math.max(0, m.t - G.METEOR_GROW)) })),
    pk: room.pickups.filter(pk => pk.active).map(pk => ({ id: pk.id, k: pk.k, x: pk.x, z: pk.z, c: pk.crowd ? 1 : 0 })),
    cv: { t: r2(Math.max(0, room.crowdT || 0)), n: room.map.voteSpots.map((_, i) => [...room.votes.values()].filter(v => v === i).length) },
    p: [], pr: room.projectiles.map(pr => ({ id: pr.id, k: pr.kind, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z) })),
    ev: room.events,
  };
  if (room.mode === 'ktk') {
    snap.ord = {};
    for (const t of ['red', 'blue']) {
      const o = room.orders && room.orders[t];
      snap.ord[t] = o && o.until > room.time ? { c: o.cmd, by: o.by, t: r2(o.until - room.time), tg: o.targetId } : null;
    }
    snap.kg = {};
    for (const t of ['red', 'blue']) { const k = kingOf(room, t); if (k) snap.kg[t] = { id: k.id, hp: Math.ceil(Math.max(0, k.hp)), mhp: k.maxHp, gd: !k.dead && kingGuarded(room, k) }; }
  }
  for (const p of room.players.values()) {
    if (!p.inMatch) continue;
    snap.p.push({
      id: p.id, c: p.cls, x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), hp: Math.ceil(p.hp), mhp: p.maxHp,
      dead: p.dead, rt: r2(p.respawnT), prot: p.protT > 0, inv: p.invisT > 0, sh: p.shieldT > 0, slow: p.slowT > 0,
      sc: Math.floor(p.score), ko: p.kos, de: p.deaths, au: p.auraT > 0, dm: Math.round(p.dmgDone), kd: Math.round(p.kingDmg), nc: p.nextCls,
      pw: p.powT > 0, sp: p.spdT > 0, pwT: r2(p.powT), spT: r2(p.spdT),
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
      code, hostId: null, players: new Map(), mode: 'ktk', botLevel: 'normal', phase: 'lobby', results: null,
      projectiles: [], events: [], teamScore: Object.fromEntries(G.TEAMS.map(t => [t, 0])), meteors: [], pickups: [], zoneIdx: 0, nextZoneIdx: null, zoneT: G.ZONE_PERIOD,
      map: G.MAPS.field, draft: null, draftT: 0, votes: new Map(), crowdT: 0,
      timer: 0, time: 0, emptySince: null,
    };
    rooms.set(code, r);
    const p = newPlayer(cleanName(name), { socketId: socket.id });
    p.team = 'red';
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
      if (seatCount(r) >= G.MAX_PLAYERS) {
        const bot = [...r.players.values()].find(q => q.isBot);
        if (!bot || r.phase !== 'lobby') return cb && cb({ ok: false, error: 'Room is full.' });
        r.players.delete(bot.id); // a human takes a bot's seat in the lobby
      }
      if ([...r.players.values()].some(q => q.name === n)) return cb && cb({ ok: false, error: 'That name is taken in this room.' });
      p = newPlayer(n, { socketId: socket.id });
      if (teamMode(r)) p.team = smallerTeam(r, p);
      r.players.set(p.id, p);
      assignColor(r, p);
      if (r.phase === 'draft') assignFreeSlot(r.draft[p.team], p);
      if (r.phase === 'countdown' || r.phase === 'playing' || r.phase === 'sudden') {
        if (r.mode === 'ktk') takeOverBot(r, p);
        else initSim(r, p);
      }
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
    if (!me || !teamMode(room) || !G.TEAMS.includes(team) || room.phase !== 'lobby') return;
    if (room.mode === 'ktk' && !['red', 'blue'].includes(team)) return;
    me.team = team; broadcastLobby(room);
  });

  socket.on('ready', val => {
    if (!me) return;
    me.ready = !!val; broadcastLobby(room);
  });

  socket.on('setMode', mode => {
    if (!isHost() || !['ffa', 'teams', 'ktk'].includes(mode) || room.phase !== 'lobby') return;
    room.mode = mode;
    room.map = G.mapFor(mode); room.layout = null;
    if (mode === 'ktk') for (const p of [...room.players.values()]) if (p.isBot) room.players.delete(p.id); // bots fill spots automatically
    if (teamMode(room)) rebalanceTeams(room);
    broadcastLobby(room);
  });

  socket.on('addBot', () => {
    if (!isHost() || room.phase !== 'lobby' || room.mode === 'ktk' || room.players.size >= G.MAX_PLAYERS) return;
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
    if (ps.length < (room.mode === 'ktk' ? 1 : 2) || ps.some(p => !p.ready)) return;
    if (room.mode === 'teams') {
      const teams = new Set(ps.map(p => p.team));
      if (teams.size < 2) return;
    }
    startMatch(room);
  });

  // ---- Kill the King draft: anyone on a team can change its line-up, take a spot, or set a bot's class
  socket.on('draftFormation', f => {
    if (!me || room.phase !== 'draft' || !Array.isArray(f)) return;
    const fm = G.FORMATIONS.find(x => x.join('-') === f.join('-'));
    if (!fm) return;
    const d = room.draft[me.team];
    d.formation = fm.slice();
    d.slots = makeSlots(fm, d.slots);
    for (const p of teamHumans(room, me.team)) if (!d.slots.some(sl => sl.humanId === p.id)) assignFreeSlot(d, p);
    broadcastLobby(room);
  });

  socket.on('draftReady', val => {
    if (!me || room.phase !== 'draft') return;
    if (val) room.draftReady.add(me.id); else room.draftReady.delete(me.id);
    broadcastLobby(room);
  });

  socket.on('draftRole', role => {
    if (!me || room.phase !== 'draft' || !['D', 'M', 'A'].includes(role)) return;
    const d = room.draft[me.team];
    const sl = d.slots.find(x => x.role === role && !x.humanId);
    if (!sl) return;
    for (const o of d.slots) if (o.humanId === me.id) o.humanId = null;
    sl.humanId = me.id; sl.cls = me.cls;
    broadcastLobby(room);
  });

  socket.on('draftTake', idx => {
    if (!me || room.phase !== 'draft') return;
    const d = room.draft[me.team], sl = d.slots[idx];
    if (!sl || (sl.humanId && sl.humanId !== me.id)) return;
    for (const o of d.slots) if (o.humanId === me.id) o.humanId = null;
    sl.humanId = me.id; me.cls = sl.cls;
    broadcastLobby(room);
  });

  socket.on('draftClass', ({ idx, cls } = {}) => {
    if (!me || room.phase !== 'draft' || !G.CLASS_ORDER.includes(cls)) return;
    const d = room.draft[me.team], sl = d.slots[idx];
    if (!sl || (sl.humanId && sl.humanId !== me.id)) return;
    sl.cls = cls;
    if (sl.humanId === me.id) me.cls = cls;
    broadcastLobby(room);
  });

  // emotes: 1 wave, 2 cheer, 3 taunt, 4 dance (2 s cooldown)
  socket.on('emote', k => {
    if (!me || !me.inMatch || me.dead || !['wave', 'cheer', 'taunt', 'dance'].includes(k)) return;
    const now = Date.now();
    if (now - (me.lastEmote || 0) < 2000) return;
    me.lastEmote = now;
    evLater(room, { t: 'emote', id: me.id, e: k });
  });

  // squad commands
  socket.on('order', cmd => {
    if (!me || room.mode !== 'ktk' || !me.inMatch || !G.ORDERS.includes(cmd) || room.finale) return;
    if (!['countdown', 'playing', 'sudden'].includes(room.phase)) return;
    const now = Date.now();
    if (now - (me.lastOrder || 0) < G.ORDER_COOLDOWN * 1000) return;
    room.orders = room.orders || { red: null, blue: null };
    if (cmd === 'clear') {
      room.orders[me.team] = null;
    } else {
      let targetId = null;
      if (cmd === 'focus') {
        // the enemy closest to your crosshair point, else the nearest enemy you're facing
        const foes = enemiesOf(room, me).filter(q => q.invisT <= 0);
        let best = null, bd = 6;
        if (me.aim) for (const q of foes) { const dd = Math.hypot(q.x - me.aim.x, q.z - me.aim.z); if (dd < bd) { bd = dd; best = q; } }
        if (!best) best = lockTarget(room, me, 30, 35);
        if (!best) return;
        targetId = best.id;
      }
      room.orders[me.team] = {
        cmd, by: me.id, targetId, leaderId: cmd === 'follow' ? me.id : null,
        until: room.time + (cmd === 'focus' ? G.FOCUS_TIME : G.ORDER_TIME),
      };
    }
    me.lastOrder = now;
    evLater(room, { t: 'order', team: me.team, c: cmd, by: me.id });
  });

  socket.on('crowdVote', idx => {
    if (!me || !me.inMatch || !me.dead || !room.map.voteSpots[idx]) return;
    room.votes.set(me.id, idx);
  });

  socket.on('respawnClass', cls => {
    if (!me || !me.inMatch || !me.dead || me.isKing || !G.CLASS_ORDER.includes(cls)) return;
    me.nextCls = cls;
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
