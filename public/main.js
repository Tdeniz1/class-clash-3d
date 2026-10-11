import * as THREE from 'three';
import * as G from '/shared/game.js';

const $ = s => document.querySelector(s);
const socket = io();
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('cc_session') || 'null'); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('cc_session', JSON.stringify(v)); } catch {} },
  clear() { try { sessionStorage.removeItem('cc_session'); } catch {} },
};

// ---------- state ----------
let lobby = null;        // latest lobby state from the server
let myId = null;
let myName = store.get('cc_name', '');
let lastSnap = null;
let pred = null;         // predicted own movement state
let pending = [];        // inputs not yet acknowledged by the server
let seq = 0;
let renderOffset = { x: 0, y: 0, z: 0 };
let yaw = 0, pitch = -0.15;
let sens = store.get('cc_sens', 1);
let muted = store.get('cc_mute', false);
let lastPhase = null;

const keys = new Set();
let mouseAtk = false, ablQueued = false, ablHeld = false;
const touchState = { mx: 0, mz: 0, atk: false, jump: false };

// ---------- three.js setup ----------
const canvas = $('#game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.shadowMap.enabled = !isTouch;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0cf95);
scene.fog = new THREE.Fog(0xf0cf95, 45, 110);
const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 250);
camera.position.set(0, 26, 34);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xfff1d6, 0x8a6a45, 0.9));
const sun = new THREE.DirectionalLight(0xffe2b0, 1.4);
sun.position.set(-18, 30, 12);
sun.castShadow = !isTouch;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 22, bottom: -22, near: 1, far: 80 });
scene.add(sun);

const obstacles = []; // meshes the camera should not clip through
const lam = c => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

function buildArena() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 140), lam(0xc9a46a));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true;
  scene.add(ground);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(G.ARENA.halfX * 2 + 1, G.ARENA.halfZ * 2 + 1), lam(0xe2c48c));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  obstacles.push(floor);

  // scuffed floor tiles for texture
  const tileMat = lam(0xd6b57b);
  for (let i = 0; i < 70; i++) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(1 + Math.random() * 2, 1 + Math.random() * 2), tileMat);
    t.rotation.x = -Math.PI / 2; t.rotation.z = Math.random() * 3;
    t.position.set((Math.random() - 0.5) * 38, 0.005, (Math.random() - 0.5) * 28);
    t.receiveShadow = true;
    scene.add(t);
  }

  // outer walls
  const wallMat = lam(0xb98b55);
  const hx = G.ARENA.halfX + 0.5 + 0.6, hz = G.ARENA.halfZ + 0.5 + 0.6;
  for (const [w, d, x, z] of [[hx * 2 + 1.2, 1.2, 0, -hz], [hx * 2 + 1.2, 1.2, 0, hz], [1.2, hz * 2, -hx, 0], [1.2, hz * 2, hx, 0]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), wallMat);
    m.position.set(x, 1.1, z); m.castShadow = m.receiveShadow = true;
    scene.add(m); obstacles.push(m);
  }
  // colosseum stands: stepped tiers with arches
  const tierMat = [lam(0xc89a62), lam(0xb88a52), lam(0xa87a44)];
  for (let t = 0; t < 3; t++) {
    const off = 3 + t * 3.2, h = 3 + t * 2.6;
    for (const [w, d, x, z] of [
      [hx * 2 + off * 2 + 2, 3, 0, -hz - off], [hx * 2 + off * 2 + 2, 3, 0, hz + off],
      [3, hz * 2 + off * 2 - 1, -hx - off, 0], [3, hz * 2 + off * 2 - 1, hx + off, 0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), tierMat[t]);
      m.position.set(x, h / 2, z); m.receiveShadow = true;
      scene.add(m);
    }
  }
  const archMat = lam(0x7a5530);
  for (let i = -8; i <= 8; i++) {
    for (const z of [-hz - 12.7, hz + 12.7]) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.4, 0.3), archMat);
      a.position.set(i * 3.4, 9.6, z); scene.add(a);
    }
  }
  // banners
  const bannerCols = [0xb5302a, 0xe3a857, 0x3a2b1d];
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 3), new THREE.MeshLambertMaterial({ color: bannerCols[i % 3], side: THREE.DoubleSide }));
    const side = i < 5 ? -1 : 1;
    b.position.set(-16 + (i % 5) * 8, 3.4, side * (hz + 2.45));
    scene.add(b);
  }

  // mounds
  const moundMat = lam(0xd2ad72);
  for (const m of G.MOUNDS) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(m.rTop, m.rBot, m.h, 28), moundMat);
    mesh.position.set(m.x, m.h / 2, m.z); mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh); obstacles.push(mesh);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(m.rTop, 0.12, 6, 28), lam(0xa98250));
    rim.rotation.x = Math.PI / 2; rim.position.set(m.x, m.h + 0.02, m.z);
    scene.add(rim);
  }
  // pillars
  const pMat = lam(0xeadcc0), capMat = lam(0xcdbb98);
  G.PILLARS.forEach((p, i) => {
    const h = 2.6 + ((i * 37) % 10) / 4;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.85, p.r, h, 10), pMat);
    col.position.set(p.x, h / 2, p.z); col.castShadow = col.receiveShadow = true;
    scene.add(col); obstacles.push(col);
    const base = new THREE.Mesh(new THREE.BoxGeometry(p.r * 2.4, 0.35, p.r * 2.4), capMat);
    base.position.set(p.x, 0.17, p.z); base.castShadow = true; scene.add(base);
    if (i % 2 === 0) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(p.r * 2.3, 0.4, p.r * 2.3), capMat);
      cap.position.set(p.x, h + 0.2, p.z); cap.castShadow = true; scene.add(cap);
    } else {
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5), pMat);
      chunk.position.set(p.x + 1.1, 0.35, p.z + 0.4); chunk.castShadow = true; scene.add(chunk);
    }
  });
  // low walls
  const lwMat = lam(0xbfa27a);
  for (const w of G.WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.w, w.h, w.d), lwMat);
    m.position.set(w.x, w.h / 2, w.z); m.castShadow = m.receiveShadow = true;
    scene.add(m); obstacles.push(m);
  }
}
buildArena();

// ---------- zone ----------
function groundRing(cx, cz, rIn, rOut, color, opacity) {
  const geo = new THREE.RingGeometry(rIn, rOut, 56, 4);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, G.groundHeight(cx + pos.getX(i), cz + pos.getZ(i)) + 0.06);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  mesh.position.set(cx, 0, cz);
  return mesh;
}

const zoneGroup = new THREE.Group();
scene.add(zoneGroup);
let zoneFill = null, zoneEdge = null, zoneBeam = null, nextZoneMesh = null, zoneShownIdx = -1, nextShownIdx = -2;

function setZone(i) {
  zoneGroup.clear();
  const z = G.ZONES[i];
  zoneFill = groundRing(z.x, z.z, 0, G.ZONE_RADIUS, 0xffffff, 0.22);
  zoneEdge = groundRing(z.x, z.z, G.ZONE_RADIUS - 0.25, G.ZONE_RADIUS, 0xffffff, 0.9);
  zoneBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(G.ZONE_RADIUS * 0.96, G.ZONE_RADIUS, 40, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
  zoneBeam.position.set(z.x, G.groundHeight(z.x, z.z) + 20, z.z);
  zoneGroup.add(zoneFill, zoneEdge, zoneBeam);
  zoneShownIdx = i;
}

function setNextZone(i) {
  if (nextZoneMesh) { scene.remove(nextZoneMesh); nextZoneMesh = null; }
  if (i != null) {
    const z = G.ZONES[i];
    nextZoneMesh = groundRing(z.x, z.z, G.ZONE_RADIUS - 0.35, G.ZONE_RADIUS, 0xfff3c4, 0.6);
    scene.add(nextZoneMesh);
  }
  nextShownIdx = i;
}

// ---------- characters ----------
const BODY_W = { tank: 1.35, archer: 0.8, mage: 0.95, gladiator: 1.05, rogue: 0.82, paladin: 1.2, bomber: 1.1, lancer: 0.95 };

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true;
  return m;
}

function buildWeapon(cls, s) {
  const w = new THREE.Group();
  const metal = lam(0xcfd3d6), wood = lam(0x7a5230), dark = lam(0x2a2a2a), gold = lam(0xe9c46a);
  switch (cls) {
    case 'tank':
      w.add(box(0.12, 1.3, 0.12, wood, 0, 0.35, 0));
      w.add(box(0.55, 0.38, 0.38, dark, 0, 1.0, 0));
      break;
    case 'archer': {
      const bow = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.04, 5, 14, Math.PI), wood);
      bow.rotation.z = Math.PI / 2; bow.position.set(0, 0.25, -0.15);
      w.add(bow);
      w.add(box(0.01, 1.1, 0.01, lam(0xffffff), 0, 0.25, -0.15));
      break;
    }
    case 'mage': {
      w.add(box(0.08, 1.8, 0.08, wood, 0, 0.4, 0));
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17), new THREE.MeshBasicMaterial({ color: 0xc77dff }));
      orb.position.y = 1.4; w.add(orb);
      break;
    }
    case 'gladiator':
      w.add(box(0.1, 0.25, 0.1, wood, 0, 0, 0));
      w.add(box(0.2, 0.06, 0.12, gold, 0, 0.14, 0));
      w.add(box(0.1, 0.85, 0.05, metal, 0, 0.6, 0));
      break;
    case 'rogue':
      w.add(box(0.06, 0.5, 0.04, metal, 0, 0.3, 0));
      break;
    case 'paladin': {
      w.add(box(0.09, 0.9, 0.09, wood, 0, 0.3, 0));
      const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22), gold);
      head.position.y = 0.85; head.castShadow = true; w.add(head);
      break;
    }
    case 'bomber': {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), dark);
      b.position.y = 0.15; w.add(b);
      w.add(box(0.03, 0.15, 0.03, lam(0xffb703), 0, 0.42, 0));
      break;
    }
    case 'lancer': {
      const shaft = box(0.07, 2.6, 0.07, wood, 0, 0.6, 0);
      w.add(shaft);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 6), metal);
      tip.position.y = 2.1; w.add(tip);
      break;
    }
  }
  w.scale.setScalar(s);
  return w;
}

function makeCharacter(cls, ringColor) {
  const c = G.CLASSES[cls] || G.CLASSES.gladiator;
  const s = c.size, bw = (BODY_W[cls] || 1) * s;
  const g = new THREE.Group();
  const mat = lam(c.color), skin = lam(0xe0b48a), dark = lam(0x3b2a1c), trim = lam(0xe9c46a);
  const legL = box(0.26 * bw, 0.55 * s, 0.28 * s, dark, -0.17 * bw, 0.28 * s, 0);
  const legR = box(0.26 * bw, 0.55 * s, 0.28 * s, dark, 0.17 * bw, 0.28 * s, 0);
  const body = box(0.75 * bw, 0.8 * s, 0.45 * s, mat, 0, 0.95 * s, 0);
  const head = box(0.42 * s, 0.42 * s, 0.42 * s, skin, 0, 1.6 * s, 0);
  g.add(legL, legR, body, head);
  // face direction marker (front = -z)
  g.add(box(0.28 * s, 0.07 * s, 0.02, dark, 0, 1.63 * s, -0.215 * s));

  const extras = [];
  switch (cls) {
    case 'tank':
      extras.push(box(0.4 * s, 0.22 * s, 0.55 * s, lam(0x8d99ae), -0.55 * bw, 1.3 * s, 0), box(0.4 * s, 0.22 * s, 0.55 * s, lam(0x8d99ae), 0.55 * bw, 1.3 * s, 0));
      break;
    case 'archer': {
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.33 * s, 0.45 * s, 4), mat);
      hood.position.set(0, 1.95 * s, 0.04); hood.rotation.y = Math.PI / 4; extras.push(hood);
      extras.push(box(0.18 * s, 0.6 * s, 0.18 * s, lam(0x7a5230), 0.15, 1.1 * s, 0.3 * s));
      break;
    }
    case 'mage': {
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.34 * s, 0.75 * s, 6), lam(0x4a2a7a));
      hat.position.set(0, 2.15 * s, 0); hat.rotation.z = 0.15; extras.push(hat);
      break;
    }
    case 'gladiator': {
      extras.push(box(0.46 * s, 0.12 * s, 0.46 * s, trim, 0, 1.84 * s, 0));
      extras.push(box(0.08 * s, 0.32 * s, 0.5 * s, lam(0xb5302a), 0, 2.02 * s, 0));
      const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.42 * s, 0.42 * s, 0.08, 14), trim);
      shield.rotation.z = Math.PI / 2; shield.position.set(-0.55 * bw, 1.0 * s, -0.05); extras.push(shield);
      break;
    }
    case 'rogue': {
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.32 * s, 0.4 * s, 4), lam(0x14141f));
      hood.position.set(0, 1.92 * s, 0.03); hood.rotation.y = Math.PI / 4; extras.push(hood);
      extras.push(box(0.46 * s, 0.12 * s, 0.46 * s, lam(0x8d0801), 0, 1.45 * s, 0));
      const offhand = box(0.05, 0.42, 0.04, lam(0xcfd3d6), -0.5 * bw, 0.95 * s, -0.15);
      extras.push(offhand);
      break;
    }
    case 'paladin': {
      extras.push(box(0.48 * s, 0.24 * s, 0.48 * s, lam(0xcfd3d6), 0, 1.78 * s, 0));
      extras.push(box(0.12, 0.9 * s, 0.7 * s, trim, -0.55 * bw, 1.0 * s, 0));
      extras.push(box(0.04, 0.5 * s, 0.12 * s, lam(0xb5302a), -0.62 * bw, 1.05 * s, 0));
      break;
    }
    case 'bomber':
      extras.push(box(0.6 * bw, 0.6 * s, 0.3 * s, lam(0x6b4f2a), 0, 1.0 * s, 0.35 * s));
      extras.push(box(0.46 * s, 0.1 * s, 0.05, lam(0x222222), 0, 1.66 * s, -0.22 * s));
      break;
    case 'lancer':
      extras.push(box(0.46 * s, 0.14 * s, 0.46 * s, lam(0xcfd3d6), 0, 1.84 * s, 0));
      extras.push(box(0.1 * s, 0.4 * s, 0.1 * s, lam(0x2a9d8f), 0, 2.1 * s, 0.1));
      break;
  }
  extras.forEach(e => { e.castShadow = true; g.add(e); });

  const weapon = buildWeapon(cls, s);
  const pivot = new THREE.Group();
  pivot.position.set(0.5 * bw, 0.85 * s, -0.1);
  pivot.add(weapon);
  if (cls === 'lancer') pivot.rotation.x = -1.1;
  if (cls === 'archer') { pivot.position.x = -0.45 * bw; }
  g.add(pivot);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 28), new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04;
  g.add(ring);

  const mats = [];
  g.traverse(o => { if (o.isMesh && o !== ring && o.material.isMeshLambertMaterial) { o.material = o.material.clone(); mats.push(o.material); } });
  return { group: g, pivot, legL, legR, mats, ring, baseRotX: pivot.rotation.x };
}

const chars = new Map(); // id -> { key, model, buf, state, tag, flashT, atkT, walk, lastPos }
function lobbyPlayer(id) { return lobby && lobby.players.find(p => p.id === id); }
function ringColorFor(lp) {
  if (!lp) return 0xffffff;
  if (lobby.mode === 'teams') return G.TEAM_COLORS[lp.team];
  return G.PLAYER_COLORS[lp.colorIdx] ?? 0xffffff;
}
const hex = c => '#' + c.toString(16).padStart(6, '0');

function ensureChar(id) {
  const lp = lobbyPlayer(id);
  const cls = lp ? lp.cls : 'gladiator';
  const rc = ringColorFor(lp);
  const key = cls + ':' + rc;
  let ch = chars.get(id);
  if (ch && ch.key === key) return ch;
  if (ch) scene.remove(ch.model.group);
  const model = makeCharacter(cls, rc);
  scene.add(model.group);
  if (!ch) {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = '<div><span class="n"></span><span class="icons"></span></div><div class="bar"><i></i></div>';
    $('#tags').appendChild(tag);
    ch = { buf: [], tag, flashT: 0, atkT: 0, walk: 0, lastPos: null, state: null };
    chars.set(id, ch);
  }
  ch.key = key; ch.model = model;
  const n = ch.tag.querySelector('.n');
  n.textContent = lp ? lp.name : '?';
  n.style.color = hex(rc);
  return ch;
}

function removeChar(id) {
  const ch = chars.get(id);
  if (!ch) return;
  scene.remove(ch.model.group);
  ch.tag.remove();
  chars.delete(id);
}

// ---------- projectiles & effects ----------
const projMeshes = new Map();
const projGeo = {
  arrow: [new THREE.BoxGeometry(0.08, 0.08, 0.7), new THREE.MeshBasicMaterial({ color: 0xffe08a })],
  bolt: [new THREE.IcosahedronGeometry(0.28), new THREE.MeshBasicMaterial({ color: 0xc77dff })],
  bomb: [new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshLambertMaterial({ color: 0x222222 })],
  hook: [new THREE.TorusGeometry(0.2, 0.06, 6, 10), new THREE.MeshBasicMaterial({ color: 0xbbbbbb })],
};

function updateProjectiles(list) {
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    let m = projMeshes.get(p.id);
    if (!m) {
      const [geo, mat] = projGeo[p.k] || projGeo.bolt;
      m = new THREE.Mesh(geo, mat);
      m.position.set(p.x, p.y, p.z);
      m.userData.target = new THREE.Vector3(p.x, p.y, p.z);
      scene.add(m); projMeshes.set(p.id, m);
    }
    const t = m.userData.target;
    const dir = new THREE.Vector3(p.x - t.x, p.y - t.y, p.z - t.z);
    if (dir.lengthSq() > 1e-4) m.lookAt(m.position.clone().add(dir));
    t.set(p.x, p.y, p.z);
  }
  for (const [id, m] of projMeshes) if (!seen.has(id)) { scene.remove(m); projMeshes.delete(id); }
}

const effects = [];
function ringFx(x, y, z, r, color, dur = 0.5) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, y + 0.15, z);
  scene.add(m);
  effects.push({ m, t: 0, dur, update(k) { const s = 0.2 + k * r; m.scale.set(s, s, s); m.material.opacity = 0.85 * (1 - k); } });
}
function burstFx(x, y, z, color, n = 10, speed = 6) {
  const geo = new THREE.BoxGeometry(0.22, 0.22, 0.22), mat = new THREE.MeshLambertMaterial({ color, transparent: true });
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + 0.9, z);
    const v = new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed);
    scene.add(m);
    effects.push({ m, t: 0, dur: 0.9, update(k, dt) { v.y -= 18 * dt; m.position.addScaledVector(v, dt); m.rotation.x += dt * 8; mat.opacity = 1 - k; } });
  }
}
function sphereFx(x, y, z, r, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false }));
  m.position.set(x, y, z); scene.add(m);
  effects.push({ m, t: 0, dur: 0.35, update(k) { m.scale.setScalar(0.2 + k * r); m.material.opacity = 0.7 * (1 - k); } });
}
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.t += dt;
    const k = Math.min(1, e.t / e.dur);
    e.update(k, dt);
    if (k >= 1) { scene.remove(e.m); effects.splice(i, 1); }
  }
}

const v3 = new THREE.Vector3();
function screenPos(x, y, z) {
  v3.set(x, y, z).project(camera);
  return { x: (v3.x + 1) / 2 * innerWidth, y: (1 - v3.y) / 2 * innerHeight, behind: v3.z > 1 };
}
function floatText(x, y, z, text, cls) {
  const p = screenPos(x, y, z);
  if (p.behind) return;
  const d = document.createElement('div');
  d.className = 'dmg ' + (cls || '');
  d.textContent = text;
  d.style.left = p.x + 'px'; d.style.top = p.y + 'px';
  $('#tags').appendChild(d);
  setTimeout(() => d.remove(), 800);
}

// ---------- audio ----------
let actx = null;
function tone(freq, dur = 0.1, type = 'square', vol = 0.06, slide = 0) {
  if (muted) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), actx.currentTime + dur);
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}
const sfx = {
  hit: () => tone(180, 0.08, 'square', 0.05, -80),
  hurt: () => tone(110, 0.15, 'sawtooth', 0.07, -50),
  ko: () => { tone(520, 0.12, 'square', 0.06); setTimeout(() => tone(780, 0.2, 'square', 0.06), 90); },
  ability: () => tone(300, 0.25, 'triangle', 0.08, 400),
  boom: () => tone(80, 0.3, 'sawtooth', 0.09, -40),
  tick: () => tone(660, 0.08, 'sine', 0.08),
  go: () => tone(990, 0.3, 'sine', 0.09),
  power: () => { tone(520, 0.1, 'triangle', 0.08); setTimeout(() => tone(880, 0.18, 'triangle', 0.08), 80); },
  zone: () => { tone(440, 0.15, 'triangle', 0.07); setTimeout(() => tone(660, 0.2, 'triangle', 0.07), 120); },
};

// ---------- UI: home ----------
const nameInput = $('#nameInput'), codeInput = $('#codeInput');
nameInput.value = myName;
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  // opened from an invite link: make joining the obvious action
  codeInput.value = urlRoom.toUpperCase().slice(0, 4);
  $('#joinBtn').textContent = 'Join room ' + codeInput.value;
  $('#joinBtn').classList.add('btn-primary');
  $('#createBtn').classList.remove('btn-primary');
  $('#createBtn').textContent = 'Create a new room instead';
  setTimeout(() => nameInput.focus(), 50);
}

// Invite links: when the game runs on this computer, share its Wi-Fi address instead of "localhost".
let inviteBase = location.origin + location.pathname;
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  fetch('/info').then(r => r.json()).then(i => {
    if (i.lan) inviteBase = `${location.protocol}//${i.lan}:${location.port || 80}/`;
    if (lobby && myId) renderLobby();
  }).catch(() => {});
}

function homeError(msg) { $('#homeError').textContent = msg || ''; }
function readName() {
  const n = nameInput.value.trim().slice(0, 12);
  if (!n) { homeError('Enter a name first.'); nameInput.focus(); return null; }
  myName = n; store.set('cc_name', n);
  return n;
}
function enteredRoom(res) {
  if (!res || !res.ok) return homeError(res ? res.error : 'Could not connect.');
  myId = res.you;
  session.set({ code: res.code, name: myName });
  history.replaceState(null, '', '?room=' + res.code);
  homeError('');
  unlockAudio();
}
$('#createBtn').onclick = () => {
  const n = readName(); if (!n) return;
  socket.emit('create', { name: n }, enteredRoom);
};
function doJoin() {
  const n = readName(); if (!n) return;
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) return homeError('Room codes are 4 letters.');
  socket.emit('join', { code, name: n }, enteredRoom);
}
$('#joinBtn').onclick = doJoin;
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') (codeInput.value.trim().length === 4 ? doJoin() : $('#createBtn').click()); });
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} }

// auto-rejoin after a refresh, and after a dropped connection
socket.on('connect', () => {
  const s = session.get();
  if (s && (myId || (urlRoom && urlRoom.toUpperCase() === s.code))) {
    myName = s.name;
    socket.emit('join', { code: s.code, name: s.name }, res => {
      if (res && res.ok) enteredRoom(res);
      else { session.clear(); myId = null; showScreen('home'); homeError(res ? res.error : ''); }
    });
  }
});

// ---------- UI: lobby ----------
const classGrid = $('#classGrid');
for (const id of G.CLASS_ORDER) {
  const c = G.CLASSES[id];
  const b = document.createElement('button');
  b.className = 'class-card'; b.dataset.cls = id;
  b.innerHTML = `<div class="swatch" style="background:${hex(c.color)}"></div>
    <h3>${c.name}</h3><div class="role">${c.role}</div>
    <div class="stats">${c.hp} HP · speed ${c.speed}</div>
    <p><b>Attack:</b> ${c.atkText}</p><p><b>Special:</b> ${c.ablText}</p><p><b>Passive:</b> ${c.passiveText}</p>
    <div class="pickers"></div>`;
  b.onclick = () => socket.emit('setClass', id);
  classGrid.appendChild(b);
}
$('#modeSeg').addEventListener('click', e => { const m = e.target.dataset.mode; if (m) socket.emit('setMode', m); });
$('#botSeg').addEventListener('click', e => { const l = e.target.dataset.lvl; if (l) socket.emit('setBotLevel', l); });
$('#teamPick').addEventListener('click', e => { const t = e.target.closest('[data-team]'); if (t) socket.emit('setTeam', t.dataset.team); });
$('#addBotBtn').onclick = () => socket.emit('addBot');
$('#fillBotsBtn').onclick = () => { const n = G.MAX_PLAYERS - lobby.players.length; for (let i = 0; i < n; i++) socket.emit('addBot'); };
$('#readyBtn').onclick = () => { const me = lobbyPlayer(myId); socket.emit('ready', !(me && me.ready)); };
$('#startBtn').onclick = () => socket.emit('start');
$('#againBtn').onclick = () => socket.emit('backToLobby');
$('#copyLinkBtn').onclick = async () => {
  const url = inviteBase + '?room=' + lobby.code;
  try { await navigator.clipboard.writeText(url); $('#copyLinkBtn').textContent = 'Link copied!'; }
  catch { prompt('Share this link:', url); }
  setTimeout(() => { $('#copyLinkBtn').textContent = 'Copy invite link'; }, 1500);
};
$('#playerList').addEventListener('click', e => {
  const id = e.target.dataset.remove, swap = e.target.dataset.swap;
  if (id) socket.emit('removeBot', id);
  if (swap) { const p = lobbyPlayer(swap); socket.emit('setBotTeam', { id: swap, team: G.TEAMS[(G.TEAMS.indexOf(p.team) + 1) % G.TEAMS.length] }); }
});

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderLobby() {
  const L = lobby, me = lobbyPlayer(myId), host = L.hostId === myId;
  $('#roomCode').textContent = L.code;
  $('#modeSeg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.mode === L.mode); b.disabled = !host; });
  $('#botSeg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.lvl === (L.botLevel || 'normal')); b.disabled = !host; });
  $('#playerCount').textContent = `${L.players.length}/${G.MAX_PLAYERS}`;
  const order = L.mode === 'teams' ? [...L.players].sort((a, b) => G.TEAMS.indexOf(a.team) - G.TEAMS.indexOf(b.team)) : L.players;
  $('#playerList').innerHTML = order.map(p => {
    const c = G.CLASSES[p.cls];
    const color = hex(ringColorFor(p));
    return `<li class="${p.id === myId ? 'me' : ''}">
      <span class="dot" style="background:${color}"></span>
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-cls">${c.name}</span>
      ${L.mode === 'teams' ? `<span class="badge ${p.team}">${G.TEAM_NAMES[p.team]}</span>` : ''}
      ${p.id === L.hostId ? '<span class="badge host">Host</span>' : ''}
      ${!p.connected ? '<span class="badge off">Away</span>' : p.ready ? '<span class="badge ready">Ready</span>' : '<span class="badge">…</span>'}
      ${host && p.isBot && L.mode === 'teams' ? `<button class="swap-btn" data-swap="${p.id}" aria-label="Switch team">⇄</button>` : ''}
      ${host && p.isBot ? `<button class="x-btn" data-remove="${p.id}" aria-label="Remove bot">×</button>` : ''}
    </li>`;
  }).join('');
  $('#hostTools').classList.toggle('hidden', !host);
  $('#addBotBtn').disabled = L.players.length >= G.MAX_PLAYERS;
  $('#fillBotsBtn').disabled = L.players.length >= G.MAX_PLAYERS;
  $('#teamPick').classList.toggle('hidden', L.mode !== 'teams');
  if (L.mode === 'teams') {
    $('#teamPick').innerHTML = G.TEAMS.map(t => {
      const n = L.players.filter(p => p.team === t).length;
      return `<button data-team="${t}" class="btn btn-small team-btn team-${t} ${me && me.team === t ? 'current' : ''}">${me && me.team === t ? 'On' : 'Join'} ${G.TEAM_NAMES[t]} (${n})</button>`;
    }).join('');
  }
  $('#inviteUrl').textContent = inviteBase + '?room=' + L.code;
  classGrid.querySelectorAll('.class-card').forEach(card => {
    card.classList.toggle('selected', me && me.cls === card.dataset.cls);
    card.setAttribute('aria-pressed', me && me.cls === card.dataset.cls ? 'true' : 'false');
    card.querySelector('.pickers').innerHTML = L.players.filter(p => p.cls === card.dataset.cls)
      .map(p => `<span class="dot" title="${esc(p.name)}" style="background:${hex(ringColorFor(p))}"></span>`).join('');
  });
  const ready = me && me.ready;
  $('#readyBtn').textContent = ready ? 'Not ready' : "I'm ready";
  $('#readyBtn').classList.toggle('on', !!ready);
  $('#startBtn').classList.toggle('hidden', !host);
  const notReady = L.players.filter(p => !p.ready && p.connected);
  const teamsOk = L.mode !== 'teams' || new Set(L.players.map(p => p.team)).size >= 2;
  const canStart = L.players.length >= 2 && !notReady.length && teamsOk;
  $('#startBtn').disabled = !canStart;
  $('#startHint').textContent = host
    ? (L.players.length < 2 ? 'Need at least 2 players — share the code or add a bot.'
      : notReady.length ? `Waiting for: ${notReady.map(p => p.name).join(', ')}`
      : !teamsOk ? 'At least 2 teams need players — pick a team above.' : 'Everyone is ready!')
    : 'The host starts the match when everyone is ready.';
}

function renderResults() {
  const R = lobby.results;
  if (!R) return;
  const nameOf = id => (R.players.find(p => p.id === id) || {}).name || '?';
  if (R.winner === 'draw') $('#winnerText').textContent = "It's a draw!";
  else if (R.mode === 'teams') $('#winnerText').textContent = G.TEAM_NAMES[R.winner] + ' team wins!';
  else $('#winnerText').textContent = nameOf(R.winner) + ' wins!';
  $('#teamResult').innerHTML = R.mode === 'teams'
    ? R.teams.map(t => `<span class="ts ${t}">${R.teamScore[t]}</span>`).join(' <span class="ts-sep">vs</span> ') : '';
  $('#resultsBody').innerHTML = R.players.map((p, i) => `<tr class="${p.id === myId ? 'me' : ''}">
    <td>${i + 1}</td><td>${esc(p.name)}${R.mode === 'teams' ? ` <span class="badge ${p.team}">${G.TEAM_NAMES[p.team]}</span>` : ''}</td>
    <td>${G.CLASSES[p.cls].name}</td><td>${p.score}</td><td>${p.kos}</td></tr>`).join('');
  const host = lobby.hostId === myId;
  $('#againBtn').classList.toggle('hidden', !host);
  $('#againHint').textContent = host ? '' : 'Waiting for the host to start another round…';
}

function showScreen(name) {
  for (const id of ['home', 'lobby', 'results']) $('#' + id).classList.toggle('hidden', id !== name);
  const playing = name === 'game';
  $('#hud').classList.toggle('hidden', !playing);
  $('#touch').classList.toggle('hidden', !(playing && isTouch));
  $('#gearBtn').classList.toggle('hidden', name === 'home');
  document.body.classList.toggle('in-match', playing);
  if (!playing && document.pointerLockElement) document.exitPointerLock();
}

socket.on('lobby', L => {
  const prevPhase = lobby && lobby.phase;
  lobby = L;
  if (!myId || !lobbyPlayer(myId)) return;
  const inMatch = ['countdown', 'playing', 'sudden'].includes(L.phase);
  if (L.phase === 'lobby') { renderLobby(); showScreen('lobby'); }
  else if (L.phase === 'ended') { renderResults(); showScreen('results'); resetMatchState(); }
  else if (inMatch) {
    if (prevPhase !== L.phase && L.phase === 'countdown') resetMatchState();
    showScreen('game');
    $('#ablName').textContent = G.CLASSES[lobbyPlayer(myId).cls].ability.name;
    $('#cdAtk .key').textContent = isTouch ? '⚔' : 'Click';
  }
  // rebuild characters whose class/color changed
  for (const id of chars.keys()) if (!lobbyPlayer(id)) removeChar(id);
});

function resetMatchState() {
  pred = null; pending = []; lastSnap = null;
  for (const id of [...chars.keys()]) removeChar(id);
  for (const [, m] of projMeshes) scene.remove(m);
  projMeshes.clear();
  updateMeteorObjs([]); updatePickupObjs([]);
  leaderId = null;
  $('#feed').innerHTML = '';
}

// ---------- settings ----------
$('#sensInput').value = sens;
$('#muteInput').checked = muted;
$('#gearBtn').onclick = () => { $('#settings').classList.toggle('hidden'); if (document.pointerLockElement) document.exitPointerLock(); };
$('#closeSettings').onclick = () => $('#settings').classList.add('hidden');
$('#sensInput').oninput = e => { sens = +e.target.value; store.set('cc_sens', sens); };
$('#muteInput').onchange = e => { muted = e.target.checked; store.set('cc_mute', muted); };
$('#leaveBtn').onclick = () => {
  socket.emit('leave');
  session.clear(); myId = null; lobby = null;
  resetMatchState();
  history.replaceState(null, '', location.pathname);
  $('#settings').classList.add('hidden');
  showScreen('home');
};

// ---------- input: keyboard + mouse ----------
const inMatchNow = () => lobby && ['countdown', 'playing', 'sudden'].includes(lobby.phase);
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyE' || e.code === 'KeyQ') { ablQueued = true; ablHeld = true; }
  if (e.code === 'Space' && inMatchNow()) e.preventDefault();
});
addEventListener('keyup', e => { keys.delete(e.code); if (e.code === 'KeyE' || e.code === 'KeyQ') ablHeld = false; });
addEventListener('blur', () => { keys.clear(); mouseAtk = false; ablHeld = false; });

canvas.addEventListener('mousedown', e => {
  if (!inMatchNow() || isTouch) return;
  if (document.pointerLockElement !== canvas) { canvas.requestPointerLock(); unlockAudio(); return; }
  if (e.button === 0) mouseAtk = true;
  if (e.button === 2) { ablQueued = true; ablHeld = true; }
});
addEventListener('mouseup', e => { if (e.button === 0) mouseAtk = false; if (e.button === 2) ablHeld = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * 0.0025 * sens;
  pitch = Math.max(-0.9, Math.min(0.55, pitch - e.movementY * 0.0025 * sens));
});

// ---------- input: touch ----------
if (isTouch) {
  const joyBase = $('#joyBase'), joyKnob = $('#joyKnob');
  let joyId = null, jx0 = 0, jy0 = 0;
  const homeJoy = () => { joyBase.style.left = '60px'; joyBase.style.top = ''; joyBase.style.bottom = '50px'; };
  $('#joyZone').addEventListener('pointerdown', e => {
    joyId = e.pointerId; jx0 = e.clientX; jy0 = e.clientY;
    joyBase.style.left = (jx0 - 60) + 'px'; joyBase.style.top = (jy0 - 60) + 'px'; joyBase.style.bottom = 'auto';
    unlockAudio();
  });
  addEventListener('pointermove', e => {
    if (e.pointerId === joyId) {
      let dx = e.clientX - jx0, dy = e.clientY - jy0;
      const m = Math.hypot(dx, dy), max = 50;
      if (m > max) { dx = dx / m * max; dy = dy / m * max; }
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      touchState.strafe = dx / max; touchState.fwd = -dy / max;
    }
  });
  const endJoy = e => {
    if (e.pointerId !== joyId) return;
    joyId = null; touchState.strafe = 0; touchState.fwd = 0;
    joyKnob.style.transform = ''; homeJoy();
  };
  addEventListener('pointerup', endJoy); addEventListener('pointercancel', endJoy);

  let lookId = null, lx = 0, ly = 0;
  $('#lookZone').addEventListener('pointerdown', e => { lookId = e.pointerId; lx = e.clientX; ly = e.clientY; });
  addEventListener('pointermove', e => {
    if (e.pointerId !== lookId) return;
    yaw -= (e.clientX - lx) * 0.006 * sens;
    pitch = Math.max(-0.9, Math.min(0.55, pitch - (e.clientY - ly) * 0.006 * sens));
    lx = e.clientX; ly = e.clientY;
  });
  const endLook = e => { if (e.pointerId === lookId) lookId = null; };
  addEventListener('pointerup', endLook); addEventListener('pointercancel', endLook);

  const hold = (el, on, off) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); on(); });
    el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
  };
  hold($('#tAtk'), () => { touchState.atk = true; }, () => { touchState.atk = false; });
  hold($('#tJump'), () => { touchState.jump = true; }, () => { touchState.jump = false; });
  hold($('#tAbl'), () => { ablQueued = true; ablHeld = true; }, () => { ablHeld = false; });
}

document.addEventListener('pointerlockchange', () => {
  $('#lockHint').classList.toggle('hidden', !!document.pointerLockElement || isTouch || !inMatchNow());
});

// ---------- prediction ----------
function myClass() { const lp = lobbyPlayer(myId); return G.CLASSES[lp ? lp.cls : 'gladiator']; }
function mySpeed() { const me = mySnapState(); return myClass().speed * (me && me.sp ? G.SPEED_BUFF : 1); }
function mySnapState() { return lastSnap && lastSnap.p.find(p => p.id === myId); }

function buildInput() {
  let fwd = 0, strafe = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
  fwd += touchState.fwd || 0; strafe += touchState.strafe || 0;
  const f = G.facing(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let mx = f.x * fwd + rx * strafe, mz = f.z * fwd + rz * strafe;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  const inp = {
    seq: ++seq, mx: +mx.toFixed(3), mz: +mz.toFixed(3),
    jump: keys.has('Space') || touchState.jump,
    atk: mouseAtk || touchState.atk || keys.has('KeyF'),
    abl: ablQueued || ablHeld,
    yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3),
  };
  const a = aimPoint();
  if (a) { inp.ax = +a.x.toFixed(2); inp.ay = +a.y.toFixed(2); inp.az = +a.z.toFixed(2); }
  ablQueued = false;
  return inp;
}

function fixedStep() {
  const me = mySnapState();
  if (!me) return;
  const inp = buildInput();
  const frozen = lastSnap.phase === 'countdown';
  if (frozen) { inp.mx = 0; inp.mz = 0; inp.jump = false; }
  inp.skip = me.dead;
  if (pred && !inp.skip) G.stepMove(pred, inp, G.DT, mySpeed());
  pending.push(inp);
  if (pending.length > 90) pending.shift();
  const { skip, ...wire } = inp;
  socket.emit('input', wire);
}

function reconcile(ps) {
  const before = pred ? { x: pred.x, y: pred.y, z: pred.z } : null;
  pred = { x: ps.x, y: ps.y, z: ps.z, vy: ps.vy, kx: ps.kx, kz: ps.kz, dashT: ps.dT, dashVX: ps.dX, dashVZ: ps.dZ, slowT: ps.sT };
  pending = pending.filter(i => i.seq > ps.seq);
  const spd = mySpeed();
  if (!ps.dead) for (const i of pending) if (!i.skip) G.stepMove(pred, i, G.DT, spd);
  if (before) {
    const ex = before.x - pred.x, ey = before.y - pred.y, ez = before.z - pred.z;
    if (Math.hypot(ex, ey, ez) < 3) { renderOffset.x += ex; renderOffset.y += ey; renderOffset.z += ez; }
    else renderOffset = { x: 0, y: 0, z: 0 };
  }
}

// ---------- snapshots ----------
const INTERP_MS = 100;
let lastCountdownNum = null;

socket.on('snap', s => {
  if (!myId || !lobby) return;
  const now = performance.now();
  const prev = lastSnap;
  lastSnap = s;
  const seen = new Set();
  for (const ps of s.p) {
    seen.add(ps.id);
    const ch = ensureChar(ps.id);
    const respawned = ch.state && ch.state.dead && !ps.dead;
    if (respawned) ch.buf = [];
    // face the zone at spawn: take the server's facing on first sight and after each respawn
    if (ps.id === myId && (!pred || respawned)) { yaw = ps.yaw; pitch = -0.15; }
    ch.state = ps;
    if (ps.id === myId) reconcile(ps);
    else {
      ch.buf.push({ t: now, x: ps.x, y: ps.y, z: ps.z, yaw: ps.yaw });
      while (ch.buf.length > 2 && ch.buf[1].t < now - 1000) ch.buf.shift();
    }
  }
  for (const id of [...chars.keys()]) if (!seen.has(id)) removeChar(id);
  updateProjectiles(s.pr);
  updateMeteorObjs(s.mt || []);
  updatePickupObjs(s.pk || []);
  const top = [...s.p].sort((a, b) => b.sc - a.sc);
  leaderId = top.length && top[0].sc > 0 && !(top[1] && top[1].sc === top[0].sc) ? top[0].id : null;
  if (s.zone.i !== zoneShownIdx) setZone(s.zone.i);
  if (s.zone.next !== nextShownIdx) setNextZone(s.zone.next);
  for (const e of s.ev) handleEvent(e);
  if (prev && prev.phase === 'countdown' && s.phase === 'playing') { flashCenter('FIGHT!', 900); sfx.go(); }
  if (s.phase === 'countdown') {
    const n = Math.ceil(s.timer);
    if (n !== lastCountdownNum && n > 0) { lastCountdownNum = n; sfx.tick(); }
  } else lastCountdownNum = null;
});

let centerUntil = 0;
function flashCenter(text, ms) { $('#centerMsg').textContent = text; centerUntil = performance.now() + ms; }

function feed(html) {
  const li = document.createElement('li');
  li.innerHTML = html;
  $('#feed').prepend(li);
  while ($('#feed').children.length > 5) $('#feed').lastChild.remove();
  setTimeout(() => li.remove(), 4000);
}

function nameTag(id) {
  const lp = lobbyPlayer(id);
  return lp ? `<span style="color:${hex(ringColorFor(lp))}">${esc(lp.name)}</span>` : '?';
}

function handleEvent(e) {
  const ch = e.id && chars.get(e.id);
  switch (e.t) {
    case 'hit':
      if (ch) ch.flashT = 0.12;
      floatText(e.x, e.y, e.z, e.amt, e.by === myId ? 'mine' : '');
      if (e.id === myId) sfx.hurt(); else if (e.by === myId) sfx.hit();
      break;
    case 'txt':
      if (ch && ch.state) floatText(ch.state.x, ch.state.y + 2.6, ch.state.z, e.txt, 'txt');
      break;
    case 'ko': {
      const lp = lobbyPlayer(e.id);
      const c = lp ? G.CLASSES[lp.cls].color : 0xffffff;
      burstFx(e.x, e.y, e.z, c, 14, 7);
      feed(e.by ? `${nameTag(e.by)} ⚔ ${nameTag(e.id)}` : e.cause === 'meteor' ? `☄ ${nameTag(e.id)} got hit by a meteor` : `${nameTag(e.id)} was knocked out`);
      if (e.by === myId) { sfx.ko(); flashCenter('+3 KO', 700); }
      if (e.id === myId) sfx.hurt();
      break;
    }
    case 'atk':
      if (ch) ch.atkT = 0.25;
      break;
    case 'abl': {
      const colors = { slam: 0xc9a46a, nova: 0x9be7ff, sanctuary: 0xffe08a, blast: 0xff8c42, shadow: 0x222233, shadow2: 0x222233, roll: 0x9bc53d, lunge: 0xe4572e, hook: 0xbbbbbb };
      const radii = { slam: 4, nova: 5, sanctuary: 6, blast: 3, shadow: 1.5, shadow2: 1.5, roll: 1.2, lunge: 1.5, hook: 1 };
      ringFx(e.x, e.y, e.z, radii[e.a] || 2, colors[e.a] || 0xffffff);
      if (e.a === 'shadow' || e.a === 'shadow2') burstFx(e.x, e.y, e.z, 0x333344, 8, 3);
      if (e.id === myId || e.a === 'slam' || e.a === 'blast') sfx.ability();
      break;
    }
    case 'boom':
      sphereFx(e.x, e.y, e.z, e.r, e.k === 'bomb' ? 0xff8c42 : 0xc77dff);
      if (e.k === 'bomb') { burstFx(e.x, e.y - 0.9, e.z, 0x555555, 6, 5); sfx.boom(); }
      break;
    case 'zone':
      sfx.zone();
      flashCenter('Zone moved!', 900);
      break;
    case 'sudden':
      flashCenter('SUDDEN DEATH', 1600);
      break;
    case 'meteors':
      flashCenter('METEOR SHOWER!', 2000);
      sfx.boom();
      break;
    case 'impact': {
      const gy = G.groundHeight(e.x, e.z);
      sphereFx(e.x, gy, e.z, e.r * 1.3, 0xff5a1f);
      burstFx(e.x, gy - 0.9, e.z, 0x3b2a1c, 12, 9);
      ringFx(e.x, gy, e.z, e.r * 1.6, 0xff8c42, 0.6);
      if (pred && Math.hypot(pred.x - e.x, pred.z - e.z) < 12) shakeT = 0.35;
      sfx.boom();
      break;
    }
    case 'pick': {
      const txt = { heal: '+50% HP', power: '2× DAMAGE', speed: 'SPEED UP' }[e.k];
      const c2 = chars.get(e.id);
      if (c2 && c2.state) floatText(c2.state.x, c2.state.y + 2.6, c2.state.z, txt, 'txt');
      ringFx(e.x, G.groundHeight(e.x, e.z), e.z, 1.5, PICKUP_COLORS[e.k]);
      if (e.id === myId) sfx.power();
      break;
    }
  }
}

// ---------- meteors ----------
let shakeT = 0;
const meteorObjs = new Map();

// A flat disc/ring that hugs the ground (re-fit whenever its radius changes).
function groundDisc(geo, color, opacity) {
  geo.rotateX(-Math.PI / 2);
  geo.userData.base = Float32Array.from(geo.attributes.position.array);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
}
function fitDisc(mesh, cx, cz, r, lift) {
  const pos = mesh.geometry.attributes.position, base = mesh.geometry.userData.base;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3] * r, z = base[i * 3 + 2] * r;
    pos.setXYZ(i, cx + x, G.groundHeight(cx + x, cz + z) + lift, cz + z);
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}

function updateMeteorObjs(list) {
  const seen = new Set();
  for (const m of list) {
    seen.add(m.id);
    let o = meteorObjs.get(m.id);
    if (!o) {
      o = {
        fill: groundDisc(new THREE.CircleGeometry(1, 40), 0xff2a1a, 0.3),
        edge: groundDisc(new THREE.RingGeometry(0.93, 1, 40, 1), 0xff3b1f, 0.95),
        outline: groundDisc(new THREE.RingGeometry(0.97, 1, 40, 1), 0xff3b1f, 0.35),
        rock: new THREE.Mesh(new THREE.DodecahedronGeometry(0.9), new THREE.MeshLambertMaterial({ color: 0x3b2a1c, emissive: 0xff4500, emissiveIntensity: 0.6 })),
      };
      fitDisc(o.outline, m.x, m.z, m.mr, 0.07);
      o.rock.visible = false;
      scene.add(o.fill, o.edge, o.outline, o.rock);
      meteorObjs.set(m.id, o);
    }
    fitDisc(o.fill, m.x, m.z, Math.max(0.05, m.r), 0.08);
    fitDisc(o.edge, m.x, m.z, Math.max(0.05, m.r), 0.09);
    if (m.f > 0) {
      o.rock.visible = true;
      o.rock.position.set(m.x, G.groundHeight(m.x, m.z) + 30 * (1 - m.f / G.METEOR_FALL), m.z);
    }
  }
  for (const [id, o] of meteorObjs) if (!seen.has(id)) { scene.remove(o.fill, o.edge, o.outline, o.rock); meteorObjs.delete(id); }
}

// ---------- power-ups ----------
const PICKUP_COLORS = { heal: 0x4cff7a, power: 0xff5a4a, speed: 0xffd23f };
const pickupObjs = new Map();

function makePickup(k) {
  const g = new THREE.Group(), item = new THREE.Group();
  const glow = c => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.55 });
  if (k === 'heal') {
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshLambertMaterial({ color: 0x4cff7a, emissive: 0x1f8a3a, transparent: true, opacity: 0.55 }));
    item.add(bubble);
    const w = new THREE.MeshBasicMaterial({ color: 0xffffff });
    item.add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.13), w), new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.13), w));
  } else if (k === 'power') {
    item.add(box(0.1, 0.9, 0.04, glow(0xdfe6ea), 0, 0.2, 0));
    item.add(box(0.36, 0.08, 0.12, glow(0xe9c46a), 0, -0.27, 0));
    item.add(box(0.08, 0.26, 0.08, glow(0x7a3020), 0, -0.44, 0));
    item.rotation.z = 0.35;
  } else {
    const sh = new THREE.Shape();
    [[0.1, 0.55], [-0.25, 0], [0, 0], [-0.12, -0.55], [0.28, 0.08], [0.03, 0.08], [0.22, 0.55]].forEach(([x, y], i) => i ? sh.lineTo(x, y) : sh.moveTo(x, y));
    const bolt = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false }), glow(0xffd23f));
    bolt.geometry.center();
    item.add(bolt);
  }
  g.add(item);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 28), new THREE.MeshBasicMaterial({ color: PICKUP_COLORS[k], transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
  g.add(ring);
  g.userData.item = item;
  return g;
}

function updatePickupObjs(list) {
  const seen = new Set();
  for (const pk of list) {
    seen.add(pk.id);
    let o = pickupObjs.get(pk.id);
    if (o && o.userData.k !== pk.k) { scene.remove(o); o = null; }
    if (!o) {
      o = makePickup(pk.k);
      o.userData.k = pk.k;
      o.position.set(pk.x, G.groundHeight(pk.x, pk.z), pk.z);
      scene.add(o); pickupObjs.set(pk.id, o);
    }
  }
  for (const [id, o] of pickupObjs) if (!seen.has(id)) { scene.remove(o); pickupObjs.delete(id); }
}

// ---------- leader star ----------
let leaderId = null;
const starMesh = (() => {
  const sh = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.2 : 0.46, a = i / 10 * Math.PI * 2 + Math.PI / 2;
    i ? sh.lineTo(Math.cos(a) * r, Math.sin(a) * r) : sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.14, bevelEnabled: false }),
    new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0xffb700, emissiveIntensity: 0.7 }));
  m.geometry.center();
  m.visible = false;
  scene.add(m);
  return m;
})();

function animateWorldObjs(now, dt) {
  for (const [, o] of pickupObjs) {
    o.userData.item.position.y = 1.0 + Math.sin(now / 300 + o.position.x) * 0.15;
    o.userData.item.rotation.y += dt * 1.8;
  }
  for (const [, o] of meteorObjs) {
    o.fill.material.opacity = 0.25 + Math.sin(now / 120) * 0.12;
    if (o.rock.visible) o.rock.rotation.x += dt * 6;
  }
  const lc = leaderId && chars.get(leaderId);
  if (lc && lc.model.group.visible && lc.state && !lc.state.dead) {
    const lp = lobbyPlayer(leaderId);
    const size = G.CLASSES[lp ? lp.cls : 'gladiator'].size;
    const g = lc.model.group.position;
    starMesh.visible = true;
    starMesh.position.set(g.x, g.y + 2.75 * size + Math.sin(now / 250) * 0.1, g.z);
    starMesh.rotation.y += dt * 2.5;
  } else starMesh.visible = false;
}

// ---------- aiming ----------
const aimRay = new THREE.Raycaster();
function camDir() {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}
// The world point under the crosshair; ranged attacks fly toward it.
function aimPoint() {
  const myCh = chars.get(myId);
  if (!myCh) return null;
  const dir = camDir();
  aimRay.set(camera.position, dir);
  aimRay.far = 90;
  const targets = obstacles.slice();
  for (const [id, ch] of chars) if (id !== myId && ch.model.group.visible) targets.push(ch.model.group);
  const minD = camera.position.distanceTo(myCh.model.group.position);
  const hit = aimRay.intersectObjects(targets, true).find(h => h.distance > minD);
  return hit ? hit.point : camera.position.clone().addScaledVector(dir, 60);
}

// Light aim assist: the crosshair drifts toward an enemy that is already close to it.
function aimAssist(dt) {
  const me = mySnapState();
  if (!me || me.dead || !pred || lastSnap.phase === 'countdown') return;
  if (!isTouch && document.pointerLockElement !== canvas) return;
  const ranged = myClass().attack.type !== 'melee';
  const maxD = ranged ? 28 : 5, cone = ranged ? 0.18 : 0.45, strength = ranged ? 2.5 : 4;
  const myTeam = (lobbyPlayer(myId) || {}).team;
  let best = null;
  for (const [id, ch] of chars) {
    const st = ch.state;
    if (id === myId || !st || st.dead || st.inv || !ch.model.group.visible) continue;
    const lp = lobbyPlayer(id);
    if (lobby.mode === 'teams' && lp && lp.team === myTeam) continue;
    const g = ch.model.group.position;
    if (Math.hypot(g.x - pred.x, g.z - pred.z) > maxD) continue;
    const from = ranged ? camera.position : new THREE.Vector3(pred.x, pred.y + 1.4, pred.z);
    const size = G.CLASSES[lp ? lp.cls : 'gladiator'].size;
    const vx = g.x - from.x, vy = g.y + 1.0 * size - from.y, vz = g.z - from.z;
    const ty = Math.atan2(-vx, -vz), tp = Math.atan2(vy, Math.hypot(vx, vz));
    const dy = Math.atan2(Math.sin(ty - yaw), Math.cos(ty - yaw)), dp = ranged ? tp - pitch : 0;
    const ang = Math.hypot(dy, dp);
    if (ang < cone && (!best || ang < best.ang)) best = { dy, dp, ang };
  }
  if (!best) return;
  const k = (1 - Math.exp(-strength * dt)) * (1 - 0.5 * best.ang / cone);
  yaw += best.dy * k;
  pitch = Math.max(-0.9, Math.min(0.55, pitch + best.dp * k));
}

// ---------- render loop ----------
const raycaster = new THREE.Raycaster();
let lastFrame = performance.now(), acc = 0;
let camPos = new THREE.Vector3(0, 26, 34);

function interpOther(ch, renderT) {
  const b = ch.buf;
  if (!b.length) return null;
  if (renderT <= b[0].t) return b[0];
  for (let i = 0; i < b.length - 1; i++) {
    const a = b[i], c = b[i + 1];
    if (renderT >= a.t && renderT <= c.t) {
      const k = (renderT - a.t) / (c.t - a.t || 1);
      let dy = c.yaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k, yaw: a.yaw + dy * k };
    }
  }
  return b[b.length - 1];
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (lastSnap && inMatchNow()) {
    aimAssist(dt);
    acc += dt;
    let steps = 0;
    while (acc >= G.DT && steps < 5) { fixedStep(); acc -= G.DT; steps++; }
    if (steps >= 5) acc = 0;
  }
  const decay = Math.exp(-12 * dt);
  renderOffset.x *= decay; renderOffset.y *= decay; renderOffset.z *= decay;

  const renderT = now - INTERP_MS;
  const myTeam = (lobbyPlayer(myId) || {}).team;
  for (const [id, ch] of chars) {
    const st = ch.state;
    if (!st) continue;
    let pos;
    if (id === myId && pred) pos = { x: pred.x + renderOffset.x, y: pred.y + renderOffset.y, z: pred.z + renderOffset.z, yaw };
    else pos = interpOther(ch, renderT);
    if (!pos) continue;
    const g = ch.model.group;
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.y = pos.yaw;

    // walk animation
    const moved = ch.lastPos ? Math.hypot(pos.x - ch.lastPos.x, pos.z - ch.lastPos.z) / Math.max(dt, 1e-3) : 0;
    ch.lastPos = { x: pos.x, z: pos.z };
    ch.walk += dt * Math.min(moved, 8) * 2.2;
    const swing = moved > 0.5 ? Math.sin(ch.walk) * 0.6 : 0;
    ch.model.legL.rotation.x = swing; ch.model.legR.rotation.x = -swing;
    // attack swing
    if (ch.atkT > 0) {
      ch.atkT = Math.max(0, ch.atkT - dt);
      ch.model.pivot.rotation.x = ch.model.baseRotX - Math.sin((1 - ch.atkT / 0.25) * Math.PI) * 1.5;
    } else ch.model.pivot.rotation.x = ch.model.baseRotX;

    // visibility: dead, invisible (rogue), spawn protection blink
    const lp = lobbyPlayer(id);
    const ally = id === myId || (lobby.mode === 'teams' && lp && lp.team === myTeam);
    let visible = !st.dead, opacity = 1;
    if (st.inv) { if (ally) opacity = 0.3; else visible = false; }
    if (st.prot) opacity = Math.sin(now / 70) > 0 ? 0.35 : 0.9;
    g.visible = visible;
    ch.flashT = Math.max(0, ch.flashT - dt);
    for (const m of ch.model.mats) {
      m.transparent = opacity < 1; m.opacity = opacity;
      m.emissive.setHex(ch.flashT > 0 ? 0xffffff : st.sh ? 0x5a4a10 : st.pw ? 0x5a0d0d : st.sp ? 0x4a4200 : st.slow ? 0x103050 : 0x000000);
    }

    // name tag
    const showTag = visible && id !== myId;
    if (showTag) {
      const p = screenPos(pos.x, pos.y + 2.5 * (G.CLASSES[lp ? lp.cls : 'gladiator'].size), pos.z);
      if (p.behind) ch.tag.style.display = 'none';
      else {
        ch.tag.style.display = '';
        ch.tag.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
        ch.tag.style.left = '0'; ch.tag.style.top = '0';
        ch.tag.classList.toggle('ally', ally);
        ch.tag.querySelector('i').style.width = (st.hp / st.mhp * 100) + '%';
        ch.tag.querySelector('.icons').textContent = (id === leaderId ? '★' : '') + (st.pw ? '⚔' : '') + (st.sp ? '⚡' : '');
      }
    } else ch.tag.style.display = 'none';
  }

  for (const [, m] of projMeshes) m.position.lerp(m.userData.target, Math.min(1, dt * 20));
  animateWorldObjs(now, dt);
  updateEffects(dt);
  if (zoneBeam && lastSnap) {
    const z = lastSnap.zone;
    let col = 0xffffff;
    if (z.contested) col = Math.sin(now / 90) > 0 ? 0xff3b30 : 0xffffff;
    else if (z.holder) col = lobby.mode === 'teams' ? G.TEAM_COLORS[z.holder] : ringColorFor(lobbyPlayer(z.holder));
    for (const m of [zoneFill, zoneEdge, zoneBeam]) m.material.color.setHex(col);
    zoneBeam.material.opacity = 0.07 + Math.sin(now / 400) * 0.03;
    if (nextZoneMesh) nextZoneMesh.material.opacity = 0.35 + Math.sin(now / 150) * 0.3;
  }

  updateCamera(dt);
  updateHud(now);
  renderer.render(scene, camera);
}

function updateCamera(dt) {
  const ch = chars.get(myId);
  if (!ch || !pred || !inMatchNow() && !(lobby && lobby.phase === 'ended')) {
    // idle orbit behind menus
    const t = performance.now() / 9000;
    camPos.set(Math.sin(t) * 30, 18, Math.cos(t) * 26);
    camera.position.copy(camPos);
    camera.lookAt(0, 1, 0);
    return;
  }
  const g = ch.model.group;
  const cp = Math.cos(pitch);
  const dir = new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const target = new THREE.Vector3(g.position.x, g.position.y + 1.7, g.position.z).addScaledVector(right, 0.7);
  let dist = 5.2;
  const back = dir.clone().negate();
  raycaster.set(target, back);
  raycaster.far = dist;
  const hit = raycaster.intersectObjects(obstacles, false)[0];
  if (hit) dist = Math.max(0.8, hit.distance - 0.3);
  const want = target.clone().addScaledVector(back, dist);
  want.y = Math.max(want.y, G.groundHeight(want.x, want.z) + 0.3);
  camera.position.copy(want);
  camera.lookAt(camera.position.clone().add(dir));
  if (shakeT > 0) {
    shakeT = Math.max(0, shakeT - dt);
    camera.position.x += (Math.random() - 0.5) * shakeT * 0.8;
    camera.position.y += (Math.random() - 0.5) * shakeT * 0.8;
  }
}

const fmt = t => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

function updateHud(now) {
  if (!lastSnap || !inMatchNow()) return;
  const s = lastSnap, me = mySnapState(), lp = lobbyPlayer(myId);
  if (!me || !lp) return;
  const c = G.CLASSES[lp.cls];
  $('#timer').textContent = s.phase === 'countdown' ? fmt(G.ROUND_TIME) : fmt(s.timer);
  $('#timer').classList.toggle('sudden', s.phase === 'sudden');
  const z = G.ZONES[s.zone.i];
  $('#zoneInfo').textContent = s.zone.next != null
    ? `Zone moving to ${G.ZONES[s.zone.next].name} in ${Math.ceil(s.zone.t)}s`
    : s.zone.contested ? `${z.name} — CONTESTED` : z.name;

  const teams = lobby.mode === 'teams';
  $('#teamScores').classList.toggle('hidden', !teams);
  if (teams) {
    const inPlay = G.TEAMS.filter(t => lobby.players.some(p => p.team === t));
    $('#teamScores').innerHTML = inPlay.map(t => `<span class="ts ${t}">${s.ts[t] || 0}</span>`).join('<span class="ts-sep">vs</span>');
  }
  const sorted = [...s.p].sort((a, b) => b.sc - a.sc);
  $('#scoreList').innerHTML = sorted.map(p => {
    const l = lobbyPlayer(p.id);
    return `<li class="${p.id === myId ? 'me' : ''}"><span class="dot" style="background:${hex(ringColorFor(l))}"></span>${esc(l ? l.name : '?')}${p.id === leaderId ? ' <span class="star">★</span>' : ''}<span class="s">${p.sc}</span></li>`;
  }).join('');

  // center message priority: countdown > respawn > flash
  let msg = '';
  if (s.phase === 'countdown') msg = Math.ceil(s.timer) || 'FIGHT!';
  else if (now < centerUntil) msg = $('#centerMsg').textContent;
  $('#centerMsg').textContent = msg;
  $('#subMsg').textContent = me.dead ? `Knocked out — respawning in ${Math.ceil(me.rt)}…`
    : s.phase === 'countdown' ? `You are the ${c.name}. Get to the glowing zone!`
    : me.prot ? 'Spawn protection' : '';

  $('#meName').textContent = lp.name;
  $('#meClass').textContent = c.name;
  $('#meScore').textContent = me.sc;
  $('#hpFill').style.width = (me.hp / me.mhp * 100) + '%';
  $('#hpFill').style.background = me.hp / me.mhp < 0.3 ? 'linear-gradient(90deg,#e63946,#ff6b5b)' : '';
  $('#hpText').textContent = `${me.hp} / ${me.mhp}`;
  $('#buffs').innerHTML = (me.pw ? `<span class="buff pw">⚔ 2× damage ${Math.ceil(me.pwT)}s</span>` : '') + (me.sp ? `<span class="buff sp">⚡ speed ${Math.ceil(me.spT)}s</span>` : '');
  $('#cdAtk').style.setProperty('--p', Math.min(1, me.aCd / c.attack.cd));
  const ablP = Math.min(1, me.bCd / c.ability.cd);
  $('#cdAbl').style.setProperty('--p', ablP);
  if (isTouch) $('#tAbl').style.setProperty('--p', ablP);
  $('#lockHint').classList.toggle('hidden', !!document.pointerLockElement || isTouch);

  // arrow toward the zone when it's off-screen
  const target = s.zone.next != null && s.zone.t < 3 ? G.ZONES[s.zone.next] : z;
  const p = screenPos(target.x, G.groundHeight(target.x, target.z) + 1, target.z);
  const arrow = $('#zoneArrow');
  const off = p.behind || p.x < 40 || p.x > innerWidth - 40 || p.y < 40 || p.y > innerHeight - 40;
  if (off && pred) {
    const dx = target.x - pred.x, dz = target.z - pred.z;
    const f = G.facing(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const ang = Math.atan2(dx * rx + dz * rz, dx * f.x + dz * f.z);
    const r = Math.min(innerWidth, innerHeight) * 0.38;
    arrow.style.display = 'block';
    arrow.style.transform = `translate(-50%, -50%) translate(${Math.sin(ang) * r}px, ${-Math.cos(ang) * r}px) rotate(${ang}rad)`;
  } else arrow.style.display = 'none';
}

showScreen('home');
requestAnimationFrame(frame);
