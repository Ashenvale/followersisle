// Sistema de HUMANOS (followers de IG). Cada follower = un humano con stats random (signo, personalidad),
// trabajo y rango por ANTIGÜEDAD (al llegar uno nuevo, los anteriores ascienden), hogar que mejora con el
// rango (carpa→choza→cabaña→casa), y comportamiento día/noche con actividad según el oficio.
// Persistencia en IndexedDB (escala a miles). El render/ctx lo provee el mundo (builder).
import * as THREE from 'three';
import { dbInit, dbGetAll, dbPut, dbDelete, dbClear, metaGet, metaSet } from './db.js';

const SIGNS = ['Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo', 'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis'];
const PERSONALITIES = ['Trabajador', 'Soñador', 'Líder', 'Tímido', 'Aventurero', 'Sociable', 'Solitario', 'Creativo', 'Pragmático', 'Rebelde', 'Leal', 'Ambicioso', 'Glotón', 'Bromista'];
// oficios por nivel (de recién llegado a fundador); al ascender se pasa al nivel siguiente
const TIERS = [
  ['Recolector', 'Pescador'],
  ['Leñador', 'Cazador', 'Agricultor'],
  ['Constructor', 'Artesano', 'Minero', 'Marinero'],
  ['Comerciante', 'Cocinero', 'Estudiante'],
  ['Médico', 'Maestro'],
  ['Capataz'],
  ['Alcalde'],
];
const RANK_NAMES = ['Recién llegado', 'Poblador', 'Vecino', 'Veterano', 'Notable', 'Pionero', 'Fundador'];
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000];
const SHIRTS = [0x2f7fc4, 0xc44f3a, 0x3ab36b, 0xb58b2f, 0x7a4fc4, 0xc43a8e, 0x3ab0c4, 0xc4a23a];
const pick = (a) => a[(Math.random() * a.length) | 0];

// nivel por antigüedad: 0 = recién llegado … TIERS.length-1 = fundador. El #1 siempre es el máximo.
function tierOf(arrival, total) {
  if (arrival === 1) return TIERS.length - 1;
  const seniority = 1 - (arrival - 1) / Math.max(1, total - 1);   // 1 = más viejo, 0 = más nuevo
  return Math.min(TIERS.length - 1, Math.floor(seniority * TIERS.length));
}

export async function createHumanSystem(ctx) {
  // ctx = { scene, heightAt, findReliefSpots, SIZE, getTime, camera, toast, cullDist }
  const { scene, heightAt, findReliefSpots, terrainClassAt, zoneSpots, SIZE, getTime, camera, controls, toast } = ctx;
  const groundAt = ctx.groundAt || heightAt;   // altura EXACTA de la superficie (bilineal) → no se hunden
  let followId = null, searchQ = '', _followPrev = null;
  const _ft = new THREE.Vector3();   // scratch para seguir (3ra persona)
  await dbInit();
  const group = new THREE.Group(); scene.add(group);
  const homeGroup = new THREE.Group(); scene.add(homeGroup);
  const humans = [];
  let villageCenter = null, anchors = null;
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.7 });
  const M = {
    tent: new THREE.MeshStandardMaterial({ color: 0xb9824f, roughness: 0.85, flatShading: true }),
    thatch: new THREE.MeshStandardMaterial({ color: 0x9a7b3e, roughness: 0.9, flatShading: true }),
    mud: new THREE.MeshStandardMaterial({ color: 0xa9885f, roughness: 0.95, flatShading: true }),
    wood: new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.85, flatShading: true }),
    roof: new THREE.MeshStandardMaterial({ color: 0x70392a, roughness: 0.8, flatShading: true }),
    house: new THREE.MeshStandardMaterial({ color: 0xcdbfa6, roughness: 0.8, flatShading: true }),
    stone: new THREE.MeshStandardMaterial({ color: 0x8d8f96, roughness: 0.95, flatShading: true }),
    fire: new THREE.MeshStandardMaterial({ color: 0xff7a2a, emissive: 0xb83a00, emissiveIntensity: 0.8, roughness: 0.6 }),
  };

  // ---- ECONOMÍA: producción por oficio (por segundo de jornada) y recursos de la isla ----
  // producción pasiva por oficio (simple, Fase 1). El pipeline realista (talar→aserradero) vendrá después.
  const PROD = {
    Leñador: { madera: 0.5 }, Recolector: { comida: 0.4 }, Agricultor: { comida: 0.6 }, Cazador: { comida: 0.5 },
    Pescador: { pescado: 0.6 }, Marinero: { pescado: 0.4 }, Minero: { piedra: 0.5 },
    Artesano: { oro: 0.2 }, Comerciante: { oro: 0.5 }, Cocinero: { comida: 0.3 },
    Capataz: { oro: 0.3 }, Alcalde: { oro: 0.4 },
  };
  const resources = { madera: 0, comida: 0, piedra: 0, pescado: 0, oro: 0 };
  const RES_ICON = { madera: '🪵', comida: '🍎', piedra: '🪨', pescado: '🐟', oro: '🪙' };
  const WALK = 1.3;                          // m/s realista caminando
  // ====== ÁNIMO + DIÁLOGOS (globitos con sonido al tipear) ======
  let audioCtx = null, talkT = 3;
  function initAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {} }
  function blip() {                          // bip electrónico corto por letra
    if (!audioCtx || audioCtx.state !== 'running') return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
    o.type = 'square'; o.frequency.value = 620 + Math.random() * 220;
    g.gain.setValueAtTime(0.035, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.045);
    o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + 0.05);
  }
  const LINES = {
    happy: ['¡Qué linda isla!', 'Me encanta esto', '¡A trabajar! 💪', 'Hoy rindo bien', '¡Buen día!'],
    hungry: ['Tengo hambre…', '¿Hay algo de comer?', 'Me comería un pescado', 'Necesito comida'],
    tired: ['Estoy agotado…', 'Qué sueño…', 'Necesito dormir', 'No doy más'],
    lonely: ['Me siento solo', '¿Alguien para charlar?', 'Qué tranquilo todo…'],
  };
  const REPLIES = ['Jaja, sí', 'Totalmente', 'Dale', '¿En serio?', 'Cierto', 'Y sí…', 'Buenísimo'];
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function drawBubble(b) {
    const ctx = b.ctx, cv = b.cv; ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(14,20,32,0.88)'; roundRect(ctx, 4, 4, cv.width - 8, cv.height - 20, 14); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cv.width / 2 - 12, cv.height - 18); ctx.lineTo(cv.width / 2, cv.height - 2); ctx.lineTo(cv.width / 2 + 12, cv.height - 18); ctx.fill();
    ctx.fillStyle = '#eaf1ff'; ctx.font = '22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(b.text.substring(0, b.shown), cv.width / 2, (cv.height - 16) / 2);
    b.tex.needsUpdate = true;
  }
  function say(h, text, delay) {
    if (h.say) { h.mesh.remove(h.say.sp); h.say.tex.dispose(); h.say.sp.material.dispose(); }
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 80;
    const tex = new THREE.CanvasTexture(cv.getContext('2d').canvas);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(3.4, 1.06, 1); sp.position.set(0, 2.4, 0); sp.renderOrder = 12;
    h.mesh.add(sp);
    h.say = { cv, ctx: cv.getContext('2d'), tex, sp, text, shown: 0, t: -(delay || 0) };
    drawBubble(h.say);
  }
  function updateSpeech(h, dt) {
    const b = h.say; if (!b) return;
    b.t += dt;
    const tgt = Math.max(0, Math.min(b.text.length, Math.floor(b.t / 0.05)));
    if (tgt > b.shown) { b.shown = tgt; drawBubble(b); blip(); }
    if (b.shown >= b.text.length && b.t > b.text.length * 0.05 + 2.6) { h.mesh.remove(b.sp); b.tex.dispose(); b.sp.material.dispose(); h.say = null; }
  }
  function needKey(h) {                       // necesidad dominante → ánimo
    const mx = Math.max(h.hunger || 0, h.energy || 0, h.social || 0);
    if (mx < 0.4) return 'happy';
    if ((h.hunger || 0) >= mx) return 'hungry';
    if ((h.energy || 0) >= mx) return 'tired';
    return 'lonely';
  }
  const MOOD_EMOJI = { happy: '😀', hungry: '🍽️', tired: '😴', lonely: '🙁' };
  // ETAPAS de construcción (las habilita el usuario): 0 sin construir · 1 carpas · 2 chozas · 3 cabañas · 4 casas
  let buildEra = 0;
  const ERA_TIER = [0, 0, 1, 2, 3];          // tier de vivienda según la etapa elegida
  const HOME_CAP = [1, 2, 3, 5];             // capacidad de humanos por vivienda (carpa→casa)
  const HOME_KEY = ['carpa', 'choza', 'cabaña', 'casa'];
  // assets DISPONIBLES por etapa (el usuario elige cuáles permitir)
  const ERA_ASSETS = {
    1: ['carpa', 'fogata'],
    2: ['choza', 'fogata', 'aserradero', 'muelle'],
    3: ['cabaña', 'fogata', 'aserradero', 'muelle', 'granja', 'mina'],
    4: ['casa', 'fogata', 'aserradero', 'muelle', 'granja', 'mina', 'mercado'],
  };
  const ASSET_LABEL = { carpa: '⛺ Carpa', choza: '🛖 Choza', 'cabaña': '🏚️ Cabaña', casa: '🏠 Casa', fogata: '🔥 Fogata', aserradero: '🪚 Aserradero', muelle: '⚓ Muelle', granja: '🌾 Granja', mina: '⛏️ Mina', mercado: '🏪 Mercado' };
  const allowed = new Set();                 // assets que el usuario permite construir
  function homeAllowed() { return allowed.has(HOME_KEY[ERA_TIER[buildEra]]); }
  const homesReg = [];                       // viviendas reales {tier,x,z,cap,occ,group,model,scaffold,building,...}
  const HALF = SIZE * 0.5 * 0.96;
  function isLand(x, z) {                     // tierra firme caminable (ni agua, ni acantilado/barranco)
    if (Math.abs(x) >= HALF || Math.abs(z) >= HALF || heightAt(x, z) <= 0.4) return false;
    if (terrainClassAt) { const c = terrainClassAt(x, z); if (c === 'acantilado' || c === 'barranco') return false; }
    return true;
  }
  function toLand(x, z) {                     // si cae en agua/fuera, busca el punto de tierra más cercano
    if (isLand(x, z)) return { x, z };
    for (let r = 5; r < SIZE * 0.5; r += 6) for (let a = 0; a < 10; a++) { const an = a / 10 * 6.283, nx = x + Math.cos(an) * r, nz = z + Math.sin(an) * r; if (isLand(nx, nz)) return { x: nx, z: nz }; }
    return villageCenter || { x: 0, z: 0 };
  }
  let prodSaveT = 0;
  const civicGroup = new THREE.Group(); scene.add(civicGroup);
  const builtCivic = new Set();
  const civicPos = {};                       // posición de cada construcción (para que la fauna/humanos la usen)
  const civicBuilds = [];                    // obras comunitarias en curso (se levantan, no aparecen solas)
  // construcciones comunitarias: aparecen al alcanzar la población indicada
  const CIVIC = [
    { id: 'fogata', label: '🔥 Fogata', pop: 1, at: 'plaza', off: [0, 0], make: makeFogata },
    { id: 'aserradero', label: '🪚 Aserradero', pop: 3, at: 'forest', off: [7, 0], make: makeSawmill },
    { id: 'muelle', label: '⚓ Muelle', pop: 5, at: 'shore', off: [0, 0], make: makeDock },
    { id: 'granja', label: '🌾 Granja', pop: 10, at: 'forest', off: [0, 0], make: makeFarm },
    { id: 'mina', label: '⛏️ Mina', pop: 14, at: 'mine', off: [0, 0], make: makeMine },
    { id: 'mercado', label: '🏪 Mercado', pop: 20, at: 'plaza', off: [4, 2], make: makeMarket },
  ];
  function makeSawmill() {
    const g = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.15, 2.0), M.wood); floor.position.y = 0.08; g.add(floor);
    const logPile = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.8, 6), M.wood); logPile.rotation.z = Math.PI / 2; logPile.position.set(-0.8, 0.4, 0.6); g.add(logPile);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 16), M.stone); blade.rotation.x = Math.PI / 2; blade.position.set(0.4, 0.62, 0); g.add(blade);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 2.2), M.roof); roof.position.y = 1.15; g.add(roof);
    for (const sx of [-1.2, 1.2]) for (const sz of [-0.9, 0.9]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), M.wood); p.position.set(sx, 0.55, sz); g.add(p); }
    return g;
  }
  function makeFogata() {
    const g = new THREE.Group();
    for (let i = 0; i < 6; i++) { const a = i / 6 * 6.283, s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18), M.stone); s.position.set(Math.cos(a) * 0.5, 0.1, Math.sin(a) * 0.5); g.add(s); }
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 5), M.wood); log.rotation.z = 1.4; log.position.y = 0.18; g.add(log);
    const fire = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 6), M.fire); fire.position.y = 0.45; g.add(fire);
    return g;
  }
  function makeDock() {                                  // muelle de tablones sobre postes
    const g = new THREE.Group();
    for (let i = 0; i < 5; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 5), M.wood); p.position.set(i * 0.9 - 1.8, -0.3, 0); g.add(p); }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(5, 0.15, 1.4), M.wood); deck.position.set(0.4, 0.3, 0); g.add(deck);
    return g;
  }
  function makeFarm() {                                  // parcela cercada con surcos
    const g = new THREE.Group();
    const soil = new THREE.Mesh(new THREE.BoxGeometry(3, 0.1, 3), M.mud); soil.position.y = 0.05; g.add(soil);
    for (let i = 0; i < 4; i++) { const row = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.25), M.thatch); row.position.set(0, 0.16, i * 0.7 - 1.05); g.add(row); }
    return g;
  }
  function makeMine() {                                  // entrada de mina (marco de madera)
    const g = new THREE.Group();
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.6, 0.25), M.wood); l.position.set(-0.8, 0.8, 0);
    const r = l.clone(); r.position.x = 0.8;
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.3, 0.3), M.wood); top.position.y = 1.65;
    const mound = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6, 0, 6.283, 0, 1.0), M.stone); mound.position.set(0, 0, -1.0); mound.scale.set(1, 0.8, 1);
    g.add(mound, l, r, top); return g;
  }
  function makeMarket() {                                // puesto con toldo
    const g = new THREE.Group();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.4, 5), M.wood); p.position.set(sx, 0.7, sz * 0.7); g.add(p); }
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 0.5), M.wood); counter.position.set(0, 0.55, 0.7); g.add(counter);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.8), M.roof); canopy.position.y = 1.5; canopy.rotation.x = 0.06; g.add(canopy);
    return g;
  }
  function buildScaffold() {                            // andamios mientras se construye
    const g = new THREE.Group();
    for (const sx of [-1.5, 1.5]) for (const sz of [-1.3, 1.3]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5), M.wood); p.position.set(sx, 1.1, sz); g.add(p); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.08, 0.08), M.wood); beam.position.y = 2.0; g.add(beam);
    return g;
  }
  // coloca una obra comunitaria EN CONSTRUCCIÓN (se levanta con andamios; no aparece de golpe)
  function placeCivic(def, instant) {
    if (builtCivic.has(def.id)) return;
    const A = getAnchors(); const base = A[def.at] || A.plaza;
    const x = base.x + def.off[0], z = base.z + def.off[1];
    const gy = Math.max(0, heightAt(x, z)) + (def.id === 'muelle' ? 0.1 : 0.02);
    const group = new THREE.Group(); group.position.set(x, gy, z); civicGroup.add(group);
    const model = def.make(); model.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    group.add(model);
    civicPos[def.id] = { x, z };
    builtCivic.add(def.id);
    if (instant) return;                                // al recargar: ya construida
    model.scale.y = 0.02;
    const scaffold = buildScaffold(); group.add(scaffold);
    civicBuilds.push({ def, group, model, scaffold, t: 0, total: 60 + def.pop * 3 });   // las obras llevan su tiempo
  }
  function updateCivicBuilds(dt) {
    for (let i = civicBuilds.length - 1; i >= 0; i--) {
      const b = civicBuilds[i]; b.t += dt; const p = Math.min(1, b.t / b.total);
      b.model.scale.y = 0.02 + 0.98 * p;                // se levanta del suelo
      if (p >= 1) {
        if (b.scaffold) { b.group.remove(b.scaffold); b.scaffold.traverse((o) => o.geometry?.dispose?.()); }
        b.model.scale.y = 1; civicBuilds.splice(i, 1);
        if (b.def) toast(b.def.label + ' terminado');
        addBuildingPoint(b.group.position.x, b.group.position.z);   // une con un camino a la más cercana
      }
    }
  }
  // ---- CAMINOS que se forman entre construcciones ----
  const pathGroup = new THREE.Group(); scene.add(pathGroup);
  const pathMat = new THREE.MeshStandardMaterial({ color: 0x9c7b52, roughness: 1 });
  const buildingPts = [], pathGrows = [];
  function addBuildingPoint(x, z) {
    let nb = null, bd = Infinity;
    for (const p of buildingPts) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; nb = p; } }
    buildingPts.push({ x, z });
    if (nb && bd > 6 && bd < (SIZE * 0.25) ** 2) {       // conecta con una construcción cercana razonable
      const mx = (nb.x + x) / 2, mz = (nb.z + z) / 2, len = Math.sqrt(bd);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.8), pathMat);
      m.position.set(mx, Math.max(0, heightAt(mx, mz)) + 0.05, mz);
      m.rotation.y = -Math.atan2(z - nb.z, x - nb.x);
      m.scale.x = 0.02; m.receiveShadow = true; pathGroup.add(m);
      pathGrows.push({ m, t: 0 });
    }
  }
  function updatePaths(dt) { for (let i = pathGrows.length - 1; i >= 0; i--) { const p = pathGrows[i]; p.t += dt; p.m.scale.x = Math.min(1, p.t / 6); if (p.t >= 6) pathGrows.splice(i, 1); } }
  // ---- FOGATAS: 1 cada ~5 humanos (dan luz al pueblo) ----
  const fires = [];
  function ensureFires() {
    if (!allowed.has('fogata')) return;        // la fogata se construye si está permitida
    const needed = Math.ceil(humans.length / 5);
    while (fires.length < needed) {
      const c = villageCenter || { x: 0, z: 0 };
      const s = toLand(c.x + (Math.random() - 0.5) * SIZE * 0.06, c.z + (Math.random() - 0.5) * SIZE * 0.06);
      const gy = Math.max(0, heightAt(s.x, s.z));
      const g = makeFogata(); g.position.set(s.x, gy + 0.02, s.z); g.scale.y = 0.02; civicGroup.add(g);
      const light = new THREE.PointLight(0xff8a3a, 1.3, 24, 2); light.position.set(s.x, gy + 1.3, s.z); scene.add(light);
      civicBuilds.push({ group: g, model: g, scaffold: null, t: 0, total: 7 });
      fires.push({ x: s.x, z: s.z, light });
    }
  }
  // ---- VIVIENDAS por etapa: se construyen por fases y tienen capacidad de humanos ----
  function freeOf(x, z) { for (const hm of homesReg) if ((hm.x - x) ** 2 + (hm.z - z) ** 2 < 25) return false; return true; }
  function homeLot() {                        // si hay ZONA RESIDENCIAL, solo ahí; si no, cerca del pueblo
    const res = zoneSpots ? zoneSpots(1) : [];
    if (res && res.length) {
      for (let n = 0; n < 40; n++) { const s = res[(Math.random() * res.length) | 0], x = s.x + (Math.random() - 0.5) * 4, z = s.z + (Math.random() - 0.5) * 4; if (isLand(x, z) && freeOf(x, z)) return { x, z }; }
      return res[(Math.random() * res.length) | 0];
    }
    for (let n = 0; n < 30; n++) { const p = pickHome(); if (isLand(p.x, p.z) && freeOf(p.x, p.z)) return p; }
    return pickHome();
  }
  function startHome(tier) {
    const lot = homeLot();
    const group = new THREE.Group(); group.position.set(lot.x, Math.max(0, heightAt(lot.x, lot.z)) + 0.02, lot.z); civicGroup.add(group);
    const model = buildHome(tier, 0); group.add(model);
    const scaffold = buildScaffold(); group.add(scaffold);
    const hm = { tier, x: lot.x, z: lot.z, cap: HOME_CAP[tier], occ: new Set(), group, model, scaffold, building: true, buildT: 0, stage: 0, total: BUILD_TIME[tier] };
    homesReg.push(hm); return hm;
  }
  function updateHomeBuilds(dt) {
    for (const hm of homesReg) {
      if (!hm.building) continue;
      hm.buildT += dt; const stages = STAGES[hm.tier], p = Math.min(1, hm.buildT / hm.total), st = Math.min(stages - 1, Math.floor(p * stages));
      if (st !== hm.stage) { hm.stage = st; hm.group.remove(hm.model); hm.model.traverse((o) => o.geometry?.dispose?.()); hm.model = buildHome(hm.tier, st); hm.group.add(hm.model); }
      hm.model.scale.y = 0.02 + 0.98 * p;
      if (p >= 1) { hm.building = false; hm.group.remove(hm.scaffold); hm.scaffold.traverse((o) => o.geometry?.dispose?.()); hm.model.scale.y = 1; addBuildingPoint(hm.x, hm.z); }
    }
  }
  function assignHome(h) {                     // se muda a una con lugar; si no, construye una nueva (si está permitida)
    if (h.homeRef) return;
    for (const hm of homesReg) if (hm.occ.size < hm.cap) { hm.occ.add(h.data.id); h.homeRef = hm; return; }
    if (!homeAllowed()) return;                // el usuario aún no permitió ese tipo de vivienda
    const hm = startHome(ERA_TIER[buildEra]); hm.occ.add(h.data.id); h.homeRef = hm; h.builderOf = hm;
  }
  function checkCivic(instant) {
    if (buildEra < 1) return;
    const n = humans.length; let changed = false;
    for (const def of CIVIC) if (!builtCivic.has(def.id) && allowed.has(def.id) && n >= def.pop) { placeCivic(def, instant); if (!instant) toast(def.label + ' en construcción'); changed = true; }   // solo los permitidos
    if (changed) metaSet('civic', [...builtCivic]);
  }

  function buildHumanMesh(shirt, scale) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.85, 6, 12), m);
    body.position.y = 0.675; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 12), skinMat);
    head.position.y = 1.56; head.castShadow = true;
    g.add(body, head); g.scale.setScalar(scale);
    return g;
  }
  // nº de fases de obra y duración (s) por tipo de vivienda
  const STAGES = [2, 3, 4, 4];
  const BUILD_TIME = [18, 45, 90, 150];      // s por vivienda: construir lleva tiempo (se ve el proceso por fases)
  const post = (x, z, h) => { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h, 5), M.wood); p.position.set(x, h / 2, z); return p; };
  // construye la vivienda del nivel `tier` en la FASE `stage` (0..STAGES-1; la última = terminada)
  function buildHome(tier, stage) {
    const g = new THREE.Group();
    const last = STAGES[tier] - 1; if (stage == null) stage = last;
    if (tier <= 0) {                                   // CARPA: palos → lona
      g.add(post(-0.5, 0, 1.3), post(0.5, 0, 1.3));
      if (stage >= 1) { const t = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.4, 5), M.tent); t.position.y = 0.7; g.add(t); }
    } else if (tier === 1) {                            // CHOZA: aro de barro → muro → techo de paja
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, stage >= 1 ? 1.0 : 0.3, 7), M.mud); base.position.y = (stage >= 1 ? 1.0 : 0.3) / 2; g.add(base);
      if (stage >= 2) { const roof = new THREE.Mesh(new THREE.ConeGeometry(1.35, 1.0, 7), M.thatch); roof.position.y = 1.5; g.add(roof); }
    } else if (tier === 2) {                            // CABAÑA: postes → piso → muros → techo
      g.add(post(-1, -0.9, 1.4), post(1, -0.9, 1.4), post(-1, 0.9, 1.4), post(1, 0.9, 1.4));
      if (stage >= 1) { const fl = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 2.0), M.wood); fl.position.y = 0.1; g.add(fl); }
      if (stage >= 2) { const w = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 2.0), M.wood); w.position.y = 0.75; g.add(w); }
      if (stage >= 3) { const roof = new THREE.Mesh(new THREE.ConeGeometry(1.8, 1.0, 4), M.roof); roof.position.y = 1.9; roof.rotation.y = Math.PI / 4; g.add(roof); }
    } else {                                            // CASA: cimientos → medio muro → muro → techo+chimenea
      const slab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.2, 2.4), M.mud); slab.position.y = 0.1; g.add(slab);
      g.add(post(-1.3, -1.1, 1.0), post(1.3, -1.1, 1.0), post(-1.3, 1.1, 1.0), post(1.3, 1.1, 1.0));
      if (stage >= 1) { const w = new THREE.Mesh(new THREE.BoxGeometry(2.8, stage >= 2 ? 1.9 : 0.9, 2.4), M.house); w.position.y = (stage >= 2 ? 1.9 : 0.9) / 2 + 0.2; g.add(w); }
      if (stage >= 3) {
        const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.1, 4), M.roof); roof.position.y = 2.45; roof.rotation.y = Math.PI / 4;
        const chim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.3), M.house); chim.position.set(0.85, 2.45, 0.6);
        g.add(roof, chim);
      }
    }
    g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    return g;
  }
  // ---- herramientas/assets que lleva el humano según el oficio ----
  function buildTool(job) {
    const g = new THREE.Group();
    const handle = (len) => new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 5), M.wood);
    if (job === 'Leñador') { const h = handle(0.9); h.position.y = 0.45; const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.05), M.roof); head.position.set(0.06, 0.86, 0); g.add(h, head); }
    else if (job === 'Minero') { const h = handle(0.9); h.position.y = 0.45; const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.06), M.roof); head.position.y = 0.88; head.rotation.z = 0.4; g.add(h, head); }
    else if (job === 'Pescador' || job === 'Marinero') { const rod = handle(1.3); rod.position.y = 0.6; rod.rotation.z = -0.5; g.add(rod); }
    else if (job === 'Constructor' || job === 'Artesano') { const h = handle(0.7); h.position.y = 0.35; const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.1), M.wood); head.position.y = 0.7; g.add(h, head); }
    else if (job === 'Recolector' || job === 'Agricultor' || job === 'Cazador') { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.22, 7), M.thatch); b.position.y = 0.3; g.add(b); }
    else if (job === 'Estudiante' || job === 'Maestro') { const bk = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.05), M.house); bk.position.y = 0.5; g.add(bk); }
    else return null;
    g.position.set(0.3, 0, 0.05);                       // en la "mano"
    g.traverse((o) => { o.castShadow = true; });
    return g;
  }
  function buildBoat() {                                // barca en la orilla (Pescadores/Marineros)
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.35, 3.2, 7, 1, false, 0, Math.PI), M.wood);
    hull.rotation.set(Math.PI / 2, 0, Math.PI / 2); hull.scale.set(1, 1, 0.6);
    g.add(hull); g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    return g;
  }

  function pickHome() {
    if (!villageCenter) {
      const spots = findReliefSpots('llano', 4).concat(findReliefSpots('playa', 4));
      villageCenter = spots[0] ? { x: spots[0].x, z: spots[0].z } : { x: 0, z: 0 };
    }
    const spread = SIZE * (0.03 + 0.02 * Math.sqrt(humans.length + 1));
    for (let n = 0; n < 24; n++) {
      const a = Math.random() * 6.283, r = Math.random() * spread;
      const x = villageCenter.x + Math.cos(a) * r, z = villageCenter.z + Math.sin(a) * r;
      if (heightAt(x, z) > 0.5) return { x, z };
    }
    return { x: villageCenter.x, z: villageCenter.z };
  }
  // anclas de trabajo por tipo (se calculan una vez según el relieve)
  function getAnchors() {
    if (anchors) return anchors;
    const c = villageCenter || { x: 0, z: 0 };
    // elige el sitio de la clase MÁS CERCANO al pueblo (distancias caminables)
    const one = (cls, fb) => {
      const s = findReliefSpots(cls, 16); let best = null, bd = Infinity;
      for (const p of s) { const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2; if (d < bd) { bd = d; best = { x: p.x, z: p.z }; } }
      return best || fb;
    };
    const rawShore = one('orilla', one('playa', c));
    anchors = {
      shore: toLand(rawShore.x, rawShore.z),  // los humanos pescan desde tierra (la barca sí va al agua)
      forest: toLand(one('llano', one('meseta', c)).x, one('llano', one('meseta', c)).z),
      mine: toLand(one('ladera', one('cima', c)).x, one('ladera', one('cima', c)).z),
      plaza: toLand(c.x, c.z),
    };
    const boat = buildBoat();               // barca en la orilla (sobre el agua, frente a la costa)
    boat.position.set(rawShore.x, Math.max(0, heightAt(rawShore.x, rawShore.z)) + 0.15, rawShore.z);
    homeGroup.add(boat);
    return anchors;
  }
  // rutina diaria según la hora: dormir / trabajar / comer / socializar
  function dayActivity(time) {
    if (time < 6 || time >= 21.5) return 'sleep';
    if ((time >= 12.5 && time < 13.5) || (time >= 19 && time < 21)) return 'eat';
    if (time >= 6 && time < 8) return 'social';        // despierta, ronda la plaza
    return 'work';
  }
  // ---- PUNTO DE LLEGADA: dónde aparecen/llegan los nuevos (vienen desde lejos por el mar) ----
  const BOAT = 8;                              // m/s acercándose por el agua
  let arrivalPoint = null, arrivalMarker = null;
  function setArrival(x, z) {
    arrivalPoint = { x, z }; metaSet('arrival', arrivalPoint);
    if (!arrivalMarker) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 5), M.wood); pole.position.y = 1.3;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x50a0ff, side: THREE.DoubleSide })); flag.position.set(0.55, 2.2, 0);
      g.add(pole, flag); arrivalMarker = g; scene.add(g);
    }
    arrivalMarker.position.set(x, Math.max(0, heightAt(x, z)) + 0.02, z);
  }
  function arrivalSpot() { return arrivalPoint || getAnchors().shore; }
  function farOffshore(p) {                    // punto mar adentro frente al de llegada (para verlos venir)
    const c = villageCenter || { x: 0, z: 0 }; let dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz) || 1;
    const D = Math.min(SIZE * 0.45, 320); return { x: p.x + dx / d * D, z: p.z + dz / d * D };
  }
  // destino de un recién llegado: con otros → va donde ellos; primero → a los árboles
  function gatherTarget() {
    const others = humans.filter((x) => !x.arriving && x.data.home);
    if (others.length) { const o = others[(Math.random() * others.length) | 0], a = Math.random() * 6.283, r = 3 + Math.random() * 4; return toLand(o.data.home.x + Math.cos(a) * r, o.data.home.z + Math.sin(a) * r); }
    const f = getAnchors().forest; return toLand(f.x, f.z);
  }
  // paso de caminata que NO entra al agua (si el siguiente paso es agua, replantea destino)
  const STEP_ANGLES = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9];   // recto y desvíos para rodear obstáculos
  function stepLand(h, tx, tz, spd, dt) {
    const dx = tx - h.px, dz = tz - h.pz, d = Math.hypot(dx, dz);
    h.t += dt;
    if (d > 0.5) {
      const dirx = dx / d, dirz = dz / d, step = spd * dt;
      let moved = false;
      for (const a of STEP_ANGLES) {                          // intenta recto; si hay agua/acantilado, esquiva
        const ca = Math.cos(a), sa = Math.sin(a);
        const ox = dirx * ca - dirz * sa, oz = dirx * sa + dirz * ca;
        const nx = h.px + ox * step, nz = h.pz + oz * step;
        if (isLand(nx, nz)) { h.px = nx; h.pz = nz; h.mesh.rotation.y = Math.atan2(ox, oz); moved = true; break; }
      }
      h.stuck = moved ? 0 : (h.stuck || 0) + dt;
      if (!moved) { h.retarget = 0; h._gather = null; }       // bloqueado → replantea
    }
    const gy = Math.max(0, groundAt(h.px, h.pz));   // superficie real (bilineal) → los pies no se hunden
    h.mesh.position.set(h.px, gy + (d > 0.5 ? Math.abs(Math.sin(h.t * 5)) * 0.05 : 0), h.pz);
    return d <= 0.5;
  }
  function attachTool(h) {
    if (h.tool) { h.mesh.remove(h.tool); h.tool.traverse((o) => o.geometry?.dispose?.()); h.tool = null; }
    const t = buildTool(h.data.job);
    if (t) { h.mesh.add(t); h.tool = t; }
  }
  function startBuild(h) { h.building = true; h.buildT = 0; h.stage = -1; rebuildHome(h, 0); }
  function anchorFor(job) {
    const A = getAnchors();
    if (job === 'Pescador' || job === 'Marinero') return A.shore;
    if (job === 'Leñador' || job === 'Recolector' || job === 'Cazador' || job === 'Agricultor') return A.forest;
    if (job === 'Minero') return A.mine;
    return A.plaza;   // Constructor, Artesano, Comerciante, Cocinero, Estudiante, Médico, Maestro, Capataz, Alcalde
  }

  function rebuildHome(h, stage) {
    if (h.home) { homeGroup.remove(h.home); h.home.traverse((o) => o.geometry?.dispose?.()); }
    h.home = buildHome(h.data.homeTier || 0, stage);
    h.home.position.set(h.data.home.x, Math.max(0, heightAt(h.data.home.x, h.data.home.z)) + 0.02, h.data.home.z);
    homeGroup.add(h.home);
  }
  function spawn(data, arriving) {
    const mesh = buildHumanMesh(data.shirt, data.height);
    group.add(mesh);
    let sx, sz;
    if (arriving) { const off = farOffshore(arrivalSpot()); sx = off.x; sz = off.z; }   // aparece lejos en el mar y se acerca
    else { const hp = data.home ? toLand(data.home.x, data.home.z) : toLand(0, 0); data.home = hp; sx = hp.x; sz = hp.z; }
    const h = { data, mesh, home: null, homeRef: null, builderOf: null, tool: null, px: sx, pz: sz, tx: sx, tz: sz, t: Math.random() * 6.283, retarget: 0, arriving: !!arriving, incoming: !!arriving, _gather: null };
    attachTool(h);
    humans.push(h);
    return h;
  }

  // recalcula nivel/oficio/vivienda de todos por antigüedad (ascensos); persiste los que cambian
  function recomputeTiers(announcePrevId) {
    const n = humans.length;
    for (const h of humans) {
      const d = h.data, tier = tierOf(d.arrival, n);
      if (d.tier !== tier) {
        d.tier = tier; d.job = pick(TIERS[tier]);
        attachTool(h);                                 // nueva herramienta del oficio
        const ht = Math.min(3, tier);
        if (d.homeTier !== ht) d.homeTier = ht;   // (las viviendas se gestionan por el registro/etapas)
        dbPut('humans', d);
        if (announcePrevId && d.id === announcePrevId) toast('⬆️ ' + d.name + ' ascendió a ' + d.job);
      }
    }
  }

  async function addFollower(name) {
    const total = humans.length + 1;
    const prevId = humans.length ? humans[humans.length - 1].data.id : null;
    const tier = tierOf(total, total);
    const data = {
      id: 'h' + total + '-' + Date.now() + '-' + ((Math.random() * 1e6) | 0),
      name: (name || 'Follower ' + total).trim(), arrival: total,
      sign: pick(SIGNS), personality: pick(PERSONALITIES), tier, job: pick(TIERS[tier]), homeTier: Math.min(3, tier),
      shirt: pick(SHIRTS), height: 0.92 + Math.random() * 0.22, nightOwl: Math.random() < 0.25, home: null,   // el hogar se fija al asentarse
    };
    await dbPut('humans', data);
    spawn(data, true);                      // llega y se asienta
    recomputeTiers(prevId);                 // el anterior puede ascender
    checkCivic();                           // ¿se desbloquea alguna construcción comunitaria?
    ensureFires();                          // 1 fogata cada ~5 humanos (luz)
    refreshPanel();
    if (MILESTONES.includes(total)) { toast(total === 1 ? '🏆 ¡El primero en tocar tierra! 🌴' : '🏆 ¡Follower nº ' + total + '!'); metaSet('milestone', total); }
    else toast('👤 ' + data.name + ' llegó a la isla (' + total + ')');
    return data;
  }
  async function removeHuman(id) {
    const i = humans.findIndex((h) => h.data.id === id); if (i < 0) return;
    const h = humans[i];
    if (h.homeRef) h.homeRef.occ.delete(id);   // libera lugar en la vivienda
    group.remove(h.mesh); h.mesh.traverse((o) => o.geometry?.dispose?.());
    humans.splice(i, 1);
    await dbDelete('humans', id);
    recomputeTiers(null); refreshPanel();
  }
  async function reroll(id) {
    const h = humans.find((x) => x.data.id === id); if (!h) return;
    h.data.sign = pick(SIGNS); h.data.personality = pick(PERSONALITIES);
    await dbPut('humans', h.data); refreshPanel();
  }
  async function resetAll() {
    for (const h of humans) group.remove(h.mesh);
    humans.length = 0; villageCenter = null; anchors = null;
    homesReg.length = 0; builtCivic.clear(); civicBuilds.length = 0;
    while (civicGroup.children.length) civicGroup.remove(civicGroup.children[0]);
    for (const f of fires) scene.remove(f.light); fires.length = 0;
    while (pathGroup.children.length) pathGroup.remove(pathGroup.children[0]); buildingPts.length = 0; pathGrows.length = 0;
    if (arrivalMarker) { scene.remove(arrivalMarker); arrivalMarker = null; } arrivalPoint = null; metaSet('arrival', null);
    if (ctx.onReset) ctx.onReset();           // limpia zonas pintadas (lado builder)
    await dbClear('humans'); refreshPanel();
  }

  // ---- comportamiento día/noche + actividad según oficio ----
  function update(dt) {
    const time = getTime();
    const night = time < 6 || time > 20.5;
    const cx = camera.position.x, cz = camera.position.z;
    const cull2 = (ctx.cullDist || SIZE * 0.6) ** 2;
    updateCivicBuilds(dt);                              // obras comunitarias se levantan
    updateHomeBuilds(dt);                               // viviendas se levantan por fases
    updatePaths(dt);                                    // caminos se van marcando
    for (const h of humans) {
      if (h.arriving) {
        h.mesh.visible = true; h.t += dt;
        if (h.incoming) {                               // viene desde lejos por el mar hacia el punto de llegada
          const ap = arrivalSpot(), dx = ap.x - h.px, dz = ap.z - h.pz, d = Math.hypot(dx, dz);
          if (d > 1.5 && !isLand(h.px, h.pz)) { h.px += dx / d * BOAT * dt; h.pz += dz / d * BOAT * dt; h.mesh.rotation.y = Math.atan2(dx, dz); h.mesh.position.set(h.px, 0.35 + Math.sin(h.t * 2) * 0.08, h.pz); }
          else { h.incoming = false; h._gather = null; h.stuck = 0; }   // tocó tierra → camina al pueblo
          continue;
        }
        if (!h._gather) h._gather = gatherTarget();
        if (stepLand(h, h._gather.x, h._gather.z, WALK, dt) || (h.stuck || 0) > 6) { h.arriving = false; h.stuck = 0; h.data.home = toLand(h.px, h.pz); dbPut('humans', h.data); }
        continue;
      }
      if (buildEra > 0 && !h.homeRef) assignHome(h);     // ¿hay etapa activa? consigue/levanta vivienda
      if (h.builderOf && !h.builderOf.building) h.builderOf = null;   // terminó de construir
      const building = !!h.builderOf;
      const act = building ? 'build' : dayActivity(time);            // rutina del día
      if (act === 'work') { const p = PROD[h.data.job]; if (p) for (const k in p) resources[k] += p[k] * dt; }   // produce mientras trabaja
      const dxc = h.px - cx, dzc = h.pz - cz;
      const far = dxc * dxc + dzc * dzc > cull2 && h.data.id !== followId;
      if (far) { h.mesh.visible = false; continue; }
      // NECESIDADES (suben con el tiempo) → ánimo
      h.hunger = Math.min(1, (h.hunger || 0) + dt * 0.004);
      h.energy = Math.min(1, (h.energy || 0) + dt * 0.003);
      h.social = Math.min(1, (h.social || 0) + dt * 0.0035);
      const canSleep = h.homeRef && !h.homeRef.building;    // solo duerme quien tiene vivienda terminada
      const sleeping = act === 'sleep' && canSleep && !h.data.nightOwl && !building && h.data.id !== followId;
      if (sleeping) { h.energy = Math.max(0, h.energy - dt * 0.06); h.mesh.visible = false; if (h.say) { h.mesh.remove(h.say.sp); h.say = null; } continue; }   // descansa
      h.mesh.visible = true;
      if (act === 'eat') h.hunger = Math.max(0, h.hunger - dt * 0.04);                 // comiendo
      if (act === 'social' || act === 'eat' || h.say) h.social = Math.max(0, h.social - dt * 0.03);   // acompañado
      h.retarget -= dt;
      if (h.retarget <= 0 || building) {
        h.retarget = 3 + Math.random() * 4;
        let base;
        if (building) base = h.builderOf;                                          // levanta su casa
        else if (act === 'eat') base = civicPos.mercado || civicPos.fogata || getAnchors().plaza;   // comer en mercado/fogata
        else if (act === 'work') base = anchorFor(h.data.job);                     // a su oficio
        else base = h.homeRef || h.data.home || getAnchors().plaza;                // dormir/socializar cerca de casa/plaza
        const a = Math.random() * 6.283, r = building ? 1.5 : SIZE * 0.012 * Math.random();
        const t = toLand(base.x + Math.cos(a) * r, base.z + Math.sin(a) * r);
        h.tx = t.x; h.tz = t.z;
      }
      const spd = WALK + (h.data.personality === 'Aventurero' ? 0.4 : 0);   // caminata realista, sin pisar agua
      if (stepLand(h, h.tx, h.tz, spd, dt)) h.mesh.rotation.y += Math.sin(h.t * 3) * 0.03;   // en el sitio → actividad
      updateSpeech(h, dt);   // globito de diálogo (tipeo + sonido)
    }
    // seguir a un humano: trasladamos TODO el rig (cámara + objetivo) lo que se movió él → seguimiento suave,
    // y el usuario puede girar/zoom alrededor con el mouse (no le peleamos el control).
    if (followId && controls) {
      const h = humans.find((x) => x.data.id === followId);
      if (h) {
        const p = h.mesh.position;
        if (_followPrev) {
          const dx = p.x - _followPrev.x, dy = p.y - _followPrev.y, dz = p.z - _followPrev.z;
          controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
          camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
          _followPrev.copy(p);
        } else _followPrev = p.clone();
      } else { followId = null; _followPrev = null; }
    }
    // diálogos: cada tanto alguien dice algo según su ánimo; si hay alguien cerca, le responde
    talkT -= dt;
    if (talkT <= 0) {
      talkT = 1.6 + Math.random() * 2.8;
      const cands = humans.filter((h) => h.mesh.visible && !h.say && !h.arriving);
      if (cands.length) {
        const sp = cands[(Math.random() * cands.length) | 0], set = LINES[needKey(sp)];
        say(sp, set[(Math.random() * set.length) | 0]);
        let nb = null, bd = 36;
        for (const o of cands) { if (o === sp || o.say) continue; const dx = o.px - sp.px, dz = o.pz - sp.pz, d = dx * dx + dz * dz; if (d < bd) { bd = d; nb = o; } }
        if (nb) { sp.mesh.rotation.y = Math.atan2(nb.px - sp.px, nb.pz - sp.pz); nb.mesh.rotation.y = Math.atan2(sp.px - nb.px, sp.pz - nb.pz); say(nb, REPLIES[(Math.random() * REPLIES.length) | 0], 1.2); }
      }
    }
    // guarda recursos y refresca el marcador cada ~4s
    prodSaveT += dt;
    if (prodSaveT > 4) { prodSaveT = 0; metaSet('resources', resources); updateResLine(); }
  }
  function setFollow(id) {
    followId = id; const h = humans.find((x) => x.data.id === id);
    if (h && controls) {                       // zoom inicial a 3ra persona (detrás); luego el usuario gira/zoom libre
      const p = h.mesh.position, ry = h.mesh.rotation.y, dist = 6, hgt = 3;
      controls.target.set(p.x, p.y + 1.2, p.z);
      camera.position.set(p.x - Math.sin(ry) * dist, p.y + hgt, p.z - Math.cos(ry) * dist);
      if (controls.update) controls.update();
      _followPrev = p.clone();
      toast('🎥 Siguiendo a ' + h.data.name + ' · girá alrededor con clic-DER');
    }
    refreshPanel();
  }
  function clearFollow() { followId = null; _followPrev = null; refreshPanel(); }

  // ---- panel de gestión (DOM, izquierda) ----
  const panel = document.createElement('div');
  panel.id = 'sim-panel';
  panel.style.cssText = 'position:fixed;top:64px;left:16px;z-index:26;width:255px;max-height:calc(100vh - 84px);' +
    'overflow-y:auto;display:none;background:rgba(10,16,28,.66);border:1px solid rgba(160,190,255,.25);' +
    'border-radius:12px;padding:10px;backdrop-filter:blur(6px);font-family:system-ui,sans-serif;color:#e7eefc;';
  document.body.appendChild(panel);
  const styleEl = document.createElement('style');
  styleEl.textContent =
    '#sim-panel .ap-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}' +
    '#sim-panel .ap-head span{color:#cfe0ff;font-size:13px;letter-spacing:.5px;text-transform:uppercase;font-weight:600;opacity:.85;}' +
    '#sim-panel button{cursor:pointer;background:rgba(40,60,95,.5);color:#e7eefc;border:1px solid transparent;border-radius:8px;padding:7px 10px;font-size:13px;}' +
    '#sim-panel .full{display:block;width:100%;margin:5px 0;text-align:left;}' +
    '#sim-panel .stat{font-size:12px;color:#b9c8e0;margin:6px 2px;}' +
    '#sim-panel .h-item{background:rgba(40,60,95,.4);border-radius:8px;padding:6px 8px;margin:4px 0;font-size:12px;}' +
    '#sim-panel .h-item .hn{font-weight:600;color:#eaf1ff;}' +
    '#sim-panel .h-item .hr{color:#9fb4d4;}' +
    '#sim-panel .h-item .acts{display:flex;gap:4px;justify-content:flex-end;margin-top:4px;}' +
    '#sim-panel .h-item .acts button{padding:3px 7px;}';
  document.head.appendChild(styleEl);

  function nextMilestone(n) { return MILESTONES.find((m) => m > n) || null; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function resText() { return Object.keys(RES_ICON).map((k) => RES_ICON[k] + ' ' + Math.floor(resources[k])).join('   '); }
  function updateResLine() { const el = panel.querySelector('#sim-res'); if (el) el.textContent = resText(); }
  function refreshPanel() {
    if (panel.style.display === 'none') return;
    const n = humans.length, nm = nextMilestone(n);
    let html = '<div class="ap-head"><span>🏝️ Isla · Followers</span><button id="sim-close">✕</button></div>';
    html += `<div class="stat">Población: <b>${n}</b>${nm ? ' · próximo hito: ' + nm : ''}</div>`;
    html += `<div class="stat" id="sim-res">${resText()}</div>`;
    html += '<button class="full" id="sim-add">➕ Agregar follower</button>';
    html += `<input id="sim-search" placeholder="🔍 buscar @nombre" value="${escapeHtml(searchQ)}" style="width:100%;margin:5px 0;padding:6px 8px;border-radius:8px;border:1px solid rgba(160,190,255,.2);background:rgba(40,60,95,.5);color:#e7eefc;font-size:13px;">`;
    if (followId) { const fh = humans.find((x) => x.data.id === followId); if (fh) html += `<div class="stat" style="display:flex;justify-content:space-between;align-items:center;">🎥 Siguiendo a <b>${escapeHtml(fh.data.name)}</b> <button id="sim-unfollow">⏹</button></div>`; }
    html += '<div id="sim-list">';
    const list = humans.slice().sort((a, b) => b.data.arrival - a.data.arrival).slice(0, 200);
    for (const h of list) {
      const d = h.data, rank = RANK_NAMES[d.tier ?? 0];
      html += `<div class="h-item" data-name="${escapeHtml(('#' + d.arrival + ' ' + d.name).toLowerCase())}"><div class="hn">${MOOD_EMOJI[needKey(h)]} #${d.arrival} ${escapeHtml(d.name)}</div>` +
        `<div class="hr">${rank} · ${d.job} · ${d.sign} · ${d.personality}${d.nightOwl ? ' · 🌙' : ''}</div>` +
        `<div class="acts"><button data-follow="${d.id}" title="Seguir con la cámara">👁</button>` +
        `<button data-reroll="${d.id}" title="Cambiar signo/personalidad">🎲</button>` +
        `<button data-del="${d.id}" title="Quitar">✕</button></div></div>`;
    }
    if (n > 200) html += `<div class="stat">… y ${n - 200} más (usá el buscador)</div>`;
    html += '</div>';
    if (n) html += '<button class="full" id="sim-reset" style="margin-top:8px;background:rgba(140,50,55,.5)">🗑 Reiniciar isla</button>';
    panel.innerHTML = html;
    applyFilter();
  }
  function applyFilter() { const q = searchQ.trim().toLowerCase(); panel.querySelectorAll('.h-item').forEach((el) => { el.style.display = (!q || el.dataset.name.includes(q)) ? '' : 'none'; }); }
  panel.addEventListener('input', (e) => { if (e.target.id === 'sim-search') { searchQ = e.target.value; applyFilter(); } });
  panel.addEventListener('click', async (e) => {
    initAudio();                               // habilita el sonido de los diálogos (gesto del usuario)
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'sim-close') { hidePanel(); return; }
    if (b.id === 'sim-add') { const name = prompt('Nombre / @handle del follower:', 'Follower ' + (humans.length + 1)); if (name !== null) await addFollower(name); return; }
    if (b.id === 'sim-reset') { if (confirm('¿Borrar todos los followers de la isla?')) await resetAll(); return; }
    if (b.id === 'sim-unfollow') { clearFollow(); return; }
    if (b.dataset.follow) { setFollow(b.dataset.follow); return; }
    if (b.dataset.del) { await removeHuman(b.dataset.del); return; }
    if (b.dataset.reroll) { await reroll(b.dataset.reroll); return; }
  });
  function showPanel() { panel.style.display = 'block'; refreshPanel(); }
  function hidePanel() { panel.style.display = 'none'; }
  function togglePanel() { panel.style.display === 'none' ? showPanel() : hidePanel(); }

  // carga inicial desde la DB
  const savedRes = await metaGet('resources', null); if (savedRes) Object.assign(resources, savedRes);
  buildEra = await metaGet('buildEra', 0);
  for (const k of await metaGet('allowed', [])) allowed.add(k);
  const savedArr = await metaGet('arrival', null); if (savedArr) setArrival(savedArr.x, savedArr.z);
  const saved = (await dbGetAll('humans')).sort((a, b) => a.arrival - b.arrival);
  for (const d of saved) { if (d.arrival === 1 && d.home) villageCenter = villageCenter || { x: d.home.x, z: d.home.z }; spawn(d, false); }
  if (saved.length) { recomputeTiers(null); checkCivic(true); ensureFires(); }   // normaliza, reconstruye lo comunitario y las fogatas

  function setEra(n) {
    buildEra = n; metaSet('buildEra', buildEra);
    const list = ERA_ASSETS[n] || [];
    if (n > 0 && !list.some((k) => allowed.has(k))) { allowed.add(HOME_KEY[ERA_TIER[n]]); allowed.add('fogata'); metaSet('allowed', [...allowed]); }   // por defecto: vivienda + fogata
    checkCivic(); ensureFires();
  }
  function setAllowed(key, on) { if (on) allowed.add(key); else allowed.delete(key); metaSet('allowed', [...allowed]); checkCivic(); ensureFires(); }
  function eraAssets() { return (ERA_ASSETS[buildEra] || []).map((k) => ({ key: k, label: ASSET_LABEL[k], on: allowed.has(k) })); }
  function dispose() { scene.remove(group); scene.remove(homeGroup); scene.remove(civicGroup); scene.remove(pathGroup); for (const f of fires) scene.remove(f.light); panel.remove(); styleEl.remove(); }
  return { addFollower, removeHuman, resetAll, update, showPanel, hidePanel, togglePanel, setEra, getEra: () => buildEra, setAllowed, eraAssets, setArrival, dispose, count: () => humans.length };
}
