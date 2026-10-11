// Shared game rules — imported by the server (Node) and the browser client.
// Movement lives here so the client can predict its own player with the exact
// same math the server uses.

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const ROUND_TIME = 180;
export const SUDDEN_DEATH_TIME = 30;
export const COUNTDOWN_TIME = 3;
export const ZONE_PERIOD = 30;
export const ZONE_WARN = 5;
export const ZONE_RADIUS = 4;
export const RESPAWN_TIME = 4;
export const SPAWN_PROTECT = 2;
export const KO_POINTS = 3;
export const MAX_PLAYERS = 8;
export const PLAYER_RADIUS = 0.5;
export const GRAVITY = 22;
export const JUMP_VELOCITY = 8;
export const ARENA = { halfX: 19.5, halfZ: 14.5 };

// Raised areas: flat top of radius rTop, sloping down to the floor at rBot.
export const MOUNDS = [
  { x: 0, z: 0, rTop: 5.5, rBot: 8.5, h: 2 },
  { x: 14, z: 0, rTop: 2.5, rBot: 4.5, h: 1 },
  { x: -14, z: 0, rTop: 2.5, rBot: 4.5, h: 1 },
];

export const PILLARS = [
  { x: -6, z: 10, r: 0.8 },
  { x: 6, z: 10, r: 0.8 },
  { x: -6, z: -10, r: 0.8 },
  { x: 6, z: -10, r: 0.8 },
  { x: -18, z: 6, r: 0.8 },
  { x: -10, z: 13.2, r: 0.8 },
  { x: 16, z: -11, r: 0.8 },
];

// Low walls (axis-aligned boxes). Players can jump over them.
export const WALLS = [
  { x: 11, z: 8, w: 4, d: 0.8, h: 1.3 },
  { x: -11, z: -8, w: 4, d: 0.8, h: 1.3 },
  { x: 11, z: -6.5, w: 0.8, d: 4, h: 1.3 },
];

export const ZONES = [
  { x: 0, z: 0, name: 'Central hill' },
  { x: 14, z: 0, name: 'East platform' },
  { x: -14, z: 0, name: 'West platform' },
  { x: 0, z: -11, name: 'South floor' },
  { x: -14, z: 10, name: 'West corner' },
];

export const SPAWNS = [
  { x: -15, z: -10.5 }, { x: 15, z: 10.5 }, { x: -15, z: 10.5 }, { x: 13.5, z: -12.5 },
  { x: -8, z: -11.5 }, { x: 8, z: 11.5 }, { x: 8, z: -11.5 }, { x: -2, z: 11.5 },
];

export const PLAYER_COLORS = [0xf2c14e, 0x5bc0eb, 0xe4572e, 0x9bc53d, 0xc879ff, 0xff8fab, 0x2ec4b6, 0xf7f7f7];
export const TEAMS = ['red', 'blue', 'green', 'gold'];
export const TEAM_COLORS = { red: 0xe63946, blue: 0x3a86ff, green: 0x2ecc71, gold: 0xf4b400 };
export const TEAM_NAMES = { red: 'Red', blue: 'Blue', green: 'Green', gold: 'Gold' };

// Meteor shower: starts this many seconds before the end, one new circle every
// METEOR_INTERVAL s; each circle grows for METEOR_GROW s, then the meteor falls.
export const METEOR_START = 45;
export const METEOR_INTERVAL = 2.2;
export const METEOR_GROW = 5;
export const METEOR_FALL = 0.8;

// Power-ups
export const BUFF_TIME = 10;
export const SPEED_BUFF = 1.5;
export const PICKUP_KINDS = ['heal', 'power', 'speed'];
export const PICKUP_SPOTS = [
  { x: -9, z: -3, name: 'West slope' }, { x: 9, z: 3, name: 'East slope' }, { x: 0, z: 12, name: 'North wall' },
  { x: -4, z: -13, name: 'South floor' }, { x: 16, z: 8, name: 'East corner' }, { x: -16, z: -5, name: 'West corner' },
];

export const CLASS_ORDER = ['tank', 'archer', 'mage', 'gladiator', 'rogue', 'paladin', 'bomber', 'lancer'];

export const CLASSES = {
  tank: {
    name: 'Tank', role: 'Zone holder', color: 0x4a78b5, hp: 200, speed: 4.5, size: 1.25,
    attack: { type: 'melee', range: 2.6, arc: 70, dmg: 20, cd: 1.0, kb: 4 },
    ability: { id: 'slam', name: 'Ground Slam', cd: 8 },
    atkText: 'Hammer swing — 20 dmg, short cone',
    ablText: 'Ground Slam — 15 dmg + big knockback around you',
    passiveText: 'Takes 30% less knockback',
  },
  archer: {
    name: 'Archer', role: 'Long-range poke', color: 0x3f8f4f, hp: 90, speed: 6.5, size: 0.9,
    attack: { type: 'arrow', range: 30, dmg: 14, cd: 0.6, speed: 32, life: 1.2 },
    ability: { id: 'roll', name: 'Roll', cd: 6 },
    atkText: 'Arrow — 14 dmg, flies to your crosshair',
    ablText: 'Roll — quick dodge, untouchable while rolling',
    passiveText: 'Arrows that fly past 15 m deal +4 dmg',
  },
  mage: {
    name: 'Mage', role: 'Area control', color: 0x7b4bc4, hp: 100, speed: 5.5, size: 1.0,
    attack: { type: 'bolt', range: 22, dmg: 18, cd: 0.9, speed: 18, life: 1.5, splash: 1.5 },
    ability: { id: 'nova', name: 'Frost Nova', cd: 10 },
    atkText: 'Arcane bolt — 18 dmg with small splash',
    ablText: 'Frost Nova — 10 dmg, slows nearby enemies 50% for 2 s',
    passiveText: 'Heals 2 HP/s while standing in the zone',
  },
  gladiator: {
    name: 'Gladiator', role: 'Aggressive duelist', color: 0xb5472f, hp: 140, speed: 6.0, size: 1.05,
    attack: { type: 'melee', range: 2.5, arc: 80, dmg: 18, cd: 0.7, kb: 3 },
    ability: { id: 'lunge', name: 'Lunge', cd: 7 },
    atkText: 'Sword combo — 18 dmg, wide cone',
    ablText: 'Lunge — dash 7 m, 25 dmg to the first enemy hit',
    passiveText: 'Bloodlust: each knockout heals 30 HP',
  },
  rogue: {
    name: 'Rogue', role: 'Flanker', color: 0x2b2d42, hp: 85, speed: 7.0, size: 0.88,
    attack: { type: 'melee', range: 2.0, arc: 60, dmg: 12, cd: 0.4, kb: 1.5 },
    ability: { id: 'shadow', name: 'Shadow Step', cd: 9 },
    atkText: 'Daggers — 12 dmg, very fast',
    ablText: 'Shadow Step — blink 6 m forward, invisible for 2.5 s',
    passiveText: 'Backstab: hits from behind deal double damage',
  },
  paladin: {
    name: 'Paladin', role: 'Team anchor', color: 0xe9c46a, hp: 160, speed: 5.0, size: 1.15,
    attack: { type: 'melee', range: 2.3, arc: 70, dmg: 16, cd: 0.9, kb: 3 },
    ability: { id: 'sanctuary', name: 'Sanctuary', cd: 12 },
    atkText: 'Mace — 16 dmg, short cone',
    ablText: 'Sanctuary — heal you and nearby allies 35, take 50% less dmg for 3 s',
    passiveText: 'Regenerates 3 HP/s after 4 s without taking damage',
  },
  bomber: {
    name: 'Bomber', role: 'Splash damage', color: 0xf4a261, hp: 100, speed: 5.5, size: 1.0,
    attack: { type: 'bomb', range: 13, dmg: 22, cd: 1.3, speed: 17, life: 3, splash: 2.5, kb: 7 },
    ability: { id: 'blast', name: 'Blast Jump', cd: 8 },
    atkText: 'Bomb — lobbed onto your crosshair, 22 dmg splash + knockback',
    ablText: 'Blast Jump — launch forward, 15 dmg burst where you took off',
    passiveText: 'Bombs knock enemies back',
  },
  lancer: {
    name: 'Lancer', role: 'Reach + pull', color: 0x2a9d8f, hp: 120, speed: 6.0, size: 1.05,
    attack: { type: 'melee', range: 3.8, arc: 30, dmg: 15, cd: 0.75, kb: 2.5 },
    ability: { id: 'hook', name: 'Hook', cd: 9 },
    atkText: 'Spear poke — 15 dmg, long narrow reach',
    ablText: 'Hook — throw a chain, 10 dmg and yank the enemy to you',
    passiveText: 'First Strike: +6 dmg to enemies above 75% HP',
  },
};

// The King in Kill the King: slow, tanky, short sword. Not pickable by players.
CLASSES.king = {
  name: 'King', role: 'Protect him', color: 0xd4a017, hp: 300, speed: 2.6, size: 1.3,
  attack: { type: 'melee', range: 2.3, arc: 100, dmg: 10, cd: 1.0, kb: 3 },
  ability: { id: 'none', name: '—', cd: 999 },
  atkText: 'Short sword — 10 dmg', ablText: '—', passiveText: '—',
};

// ---------- Kill the King ----------
export const KTK_TIME = 300;     // round length; if no King falls, the healthier King wins
export const DRAFT_TIME = 30;    // seconds to pick line-up, spots and classes (ends early when every human is ready)
export const TEAM_SIZE = 8;      // fighters per team (plus the King); bots fill empty spots
// Line-ups as [defenders, midfield, attackers]
export const FORMATIONS = [[3, 3, 2], [2, 4, 2], [4, 2, 2], [2, 3, 3], [3, 2, 3], [2, 2, 4]];
export const ROLE_NAMES = { D: 'Defender', M: 'Midfield', A: 'Attacker' };
// Distance from centre (along the field) where each role spawns, and where the King lives
export const ROLE_SPAWN = { K: 31, D: 25, M: 17, A: 11 };
export const KING_HOME = 31;
// Bot limits: defenders stay in their own half; attackers stay out of the deepest 25% of it
export const ATTACKER_LIMIT = 27;
// Respawning: wait KTK_RESPAWN s (FRENZY_RESPAWN in the frenzy), come back at the 25% mark (halfway into your half)
export const KTK_RESPAWN = 8;
export const RESPAWN_LINE = 18;
// Final frenzy: last FRENZY_TIME s — double damage, power-ups spawn FRENZY_PICKUP_RATE x faster, quick respawns
export const FRENZY_TIME = 30;
export const FRENZY_RESPAWN = 3;
export const FRENZY_PICKUP_RATE = 5;
// King's aura (always on): allies within HEAL_R heal HEAL hp/s, allies within SPEED_R move SPEED x faster
export const KING_AURA = { HEAL_R: 5, HEAL: 4, SPEED_R: 10, SPEED: 1.2 };
// The Crowd: knocked-out players vote where the next bonus power-up drops, every CROWD_PERIOD s
export const CROWD_PERIOD = 12;
// Match finale: the winning moment plays in slow motion before the results screen
export const FINALE_TIME = 4.5;   // real seconds
export const FINALE_SLOW = 0.25;  // game speed during the finale

// ---------- maps ----------
export const MAPS = {
  arena: {
    key: 'arena', halfX: ARENA.halfX, halfZ: ARENA.halfZ, mounds: MOUNDS, pillars: PILLARS, walls: WALLS,
    zones: ZONES, spawns: SPAWNS, pickups: PICKUP_SPOTS,
  },
  // Long pitch for Kill the King (x = length). Red defends x < 0, Blue defends x > 0.
  field: {
    key: 'field', halfX: 36, halfZ: 15,
    mounds: [{ x: -31, z: 0, rTop: 3.5, rBot: 5.5, h: 0.8 }, { x: 31, z: 0, rTop: 3.5, rBot: 5.5, h: 0.8 }],
    pillars: [
      { x: -10, z: 7, r: 0.8 }, { x: -10, z: -7, r: 0.8 }, { x: 10, z: 7, r: 0.8 }, { x: 10, z: -7, r: 0.8 },
      { x: -21, z: 10, r: 0.8 }, { x: -21, z: -10, r: 0.8 }, { x: 21, z: 10, r: 0.8 }, { x: 21, z: -10, r: 0.8 },
      { x: 0, z: 11, r: 0.8 }, { x: 0, z: -11, r: 0.8 },
    ],
    walls: [
      { x: 0, z: 0, w: 0.8, d: 5, h: 1.3 },
      { x: -15, z: 4, w: 4, d: 0.8, h: 1.3 }, { x: -15, z: -4, w: 4, d: 0.8, h: 1.3 },
      { x: 15, z: 4, w: 4, d: 0.8, h: 1.3 }, { x: 15, z: -4, w: 4, d: 0.8, h: 1.3 },
    ],
    zones: [], spawns: [],
    pickups: [{ x: -18, z: 0, name: 'Red half' }, { x: 0, z: 7.5, name: 'Midfield north' }, { x: 0, z: -7.5, name: 'Midfield south' }, { x: 18, z: 0, name: 'Blue half' }],
  },
};
export const mapFor = mode => (mode === 'ktk' ? MAPS.field : MAPS.arena);

export function groundHeight(x, z, map = MAPS.arena) {
  let h = 0;
  for (const m of map.mounds) {
    const r = Math.hypot(x - m.x, z - m.z);
    let mh = 0;
    if (r <= m.rTop) mh = m.h;
    else if (r < m.rBot) mh = m.h * (m.rBot - r) / (m.rBot - m.rTop);
    if (mh > h) h = mh;
  }
  return h;
}

export function resolveCollision(s, map = MAPS.arena) {
  const R = PLAYER_RADIUS;
  for (const p of map.pillars) {
    const dx = s.x - p.x, dz = s.z - p.z;
    const d = Math.hypot(dx, dz), min = p.r + R;
    if (d < min) {
      if (d < 1e-6) { s.x += min; continue; }
      s.x = p.x + dx / d * min;
      s.z = p.z + dz / d * min;
    }
  }
  for (const w of map.walls) {
    if (s.y >= w.h - 0.05) continue;
    const hx = w.w / 2 + R, hz = w.d / 2 + R;
    const dx = s.x - w.x, dz = s.z - w.z;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      const penX = hx - Math.abs(dx), penZ = hz - Math.abs(dz);
      if (penX < penZ) s.x += Math.sign(dx || 1) * penX;
      else s.z += Math.sign(dz || 1) * penZ;
    }
  }
  s.x = Math.max(-map.halfX, Math.min(map.halfX, s.x));
  s.z = Math.max(-map.halfZ, Math.min(map.halfZ, s.z));
}

// True if a point (projectile) is inside solid geometry.
export function isSolid(x, y, z, map = MAPS.arena) {
  if (Math.abs(x) > map.halfX + 0.5 || Math.abs(z) > map.halfZ + 0.5) return true;
  if (y < groundHeight(x, z, map)) return true;
  for (const p of map.pillars) if (Math.hypot(x - p.x, z - p.z) < p.r) return true;
  for (const w of map.walls) {
    if (y < w.h && Math.abs(x - w.x) < w.w / 2 && Math.abs(z - w.z) < w.d / 2) return true;
  }
  return false;
}

export function facing(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

// One fixed movement step. Mutates s: {x,y,z,vy,kx,kz,dashT,dashVX,dashVZ,slowT}.
// inp: {mx,mz,jump} with (mx,mz) a world-space direction of length <= 1.
export function stepMove(s, inp, dt, baseSpeed, map = MAPS.arena) {
  const speed = baseSpeed * (s.slowT > 0 ? 0.5 : 1);
  let vx, vz;
  if (s.dashT > 0) {
    vx = s.dashVX; vz = s.dashVZ;
    s.dashT = Math.max(0, s.dashT - dt);
  } else {
    let mx = inp.mx || 0, mz = inp.mz || 0;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    vx = mx * speed; vz = mz * speed;
  }
  vx += s.kx; vz += s.kz;
  const decay = Math.exp(-5 * dt);
  s.kx *= decay; s.kz *= decay;
  if (Math.abs(s.kx) < 0.05) s.kx = 0;
  if (Math.abs(s.kz) < 0.05) s.kz = 0;
  if (s.slowT > 0) s.slowT = Math.max(0, s.slowT - dt);

  s.x += vx * dt; s.z += vz * dt;
  resolveCollision(s, map);

  const gh = groundHeight(s.x, s.z, map);
  const onGround = s.y <= gh + 0.05 && s.vy <= 0;
  if (inp.jump && onGround && s.dashT <= 0) s.vy = JUMP_VELOCITY;
  s.vy -= GRAVITY * dt;
  s.y += s.vy * dt;
  if (s.y <= gh) { s.y = gh; s.vy = 0; }
  else if (onGround && s.vy <= 0 && s.y - gh < 0.4) { s.y = gh; s.vy = 0; }
}

export function moveState(p) {
  return { x: p.x, y: p.y, z: p.z, vy: p.vy, kx: p.kx, kz: p.kz, dashT: p.dashT, dashVX: p.dashVX, dashVZ: p.dashVZ, slowT: p.slowT };
}
