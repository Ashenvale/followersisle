// Sistema de HUMANOS (followers de IG). Cada follower = un humano con stats random (signo, personalidad),
// trabajo y rango por ANTIGÜEDAD (al llegar uno nuevo, los anteriores ascienden), hogar que mejora con el
// rango (carpa→choza→cabaña→casa), y comportamiento día/noche con actividad según el oficio.
// Persistencia en IndexedDB (escala a miles). El render/ctx lo provee el mundo (builder).
import * as THREE from 'three';
import { dbInit, dbGetAll, dbPut, dbDelete, dbClear, metaSet } from './db.js';

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
  const { scene, heightAt, findReliefSpots, SIZE, getTime, camera, toast } = ctx;
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
  };

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
  const BUILD_TIME = [4, 8, 14, 20];
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
    const one = (cls, fb) => { const s = findReliefSpots(cls, 3); return s[0] ? { x: s[0].x, z: s[0].z } : fb; };
    anchors = {
      shore: one('orilla', one('playa', c)),
      forest: one('llano', one('meseta', c)),
      mine: one('ladera', one('cima', c)),
      plaza: c,
    };
    const boat = buildBoat();               // barca en la orilla
    boat.position.set(anchors.shore.x, Math.max(0, heightAt(anchors.shore.x, anchors.shore.z)) + 0.15, anchors.shore.z);
    homeGroup.add(boat);
    return anchors;
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
  function spawn(data, animateBuild) {
    const mesh = buildHumanMesh(data.shirt, data.height);
    group.add(mesh);
    const h = { data, mesh, home: null, tool: null, px: data.home.x, pz: data.home.z, tx: data.home.x, tz: data.home.z, t: Math.random() * 6.283, retarget: 0, building: false, buildT: 0, stage: -1 };
    attachTool(h);
    if (animateBuild) startBuild(h); else rebuildHome(h);   // recién llegado: obra por fases · carga: ya construida
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
        if (d.homeTier !== ht) { d.homeTier = ht; startBuild(h); }   // re-construye la vivienda mejorada por fases
        dbPut('humans', d);
        if (announcePrevId && d.id === announcePrevId) toast('⬆️ ' + d.name + ' ascendió a ' + d.job + ' · construyendo nueva casa');
      }
    }
  }

  async function addFollower(name) {
    const total = humans.length + 1;
    const prevId = humans.length ? humans[humans.length - 1].data.id : null;
    const home = pickHome(), tier = tierOf(total, total);
    const data = {
      id: 'h' + total + '-' + Date.now() + '-' + ((Math.random() * 1e6) | 0),
      name: (name || 'Follower ' + total).trim(), arrival: total,
      sign: pick(SIGNS), personality: pick(PERSONALITIES), tier, job: pick(TIERS[tier]), homeTier: Math.min(3, tier),
      shirt: pick(SHIRTS), height: 0.92 + Math.random() * 0.22, nightOwl: Math.random() < 0.25, home,
    };
    await dbPut('humans', data);
    spawn(data, true);                      // llega y construye su carpa por fases
    recomputeTiers(prevId);                 // el anterior puede ascender
    refreshPanel();
    if (MILESTONES.includes(total)) { toast(total === 1 ? '🏆 ¡El primero en tocar tierra! 🌴' : '🏆 ¡Follower nº ' + total + '!'); metaSet('milestone', total); }
    else toast('👤 ' + data.name + ' llegó a la isla (' + total + ')');
    return data;
  }
  async function removeHuman(id) {
    const i = humans.findIndex((h) => h.data.id === id); if (i < 0) return;
    const h = humans[i];
    group.remove(h.mesh); h.mesh.traverse((o) => o.geometry?.dispose?.());
    if (h.home) { homeGroup.remove(h.home); h.home.traverse((o) => o.geometry?.dispose?.()); }
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
    for (const h of humans) { group.remove(h.mesh); if (h.home) homeGroup.remove(h.home); }
    humans.length = 0; villageCenter = null; anchors = null;
    await dbClear('humans'); refreshPanel();
  }

  // ---- comportamiento día/noche + actividad según oficio ----
  function update(dt) {
    const time = getTime();
    const night = time < 6 || time > 20.5;
    const cx = camera.position.x, cz = camera.position.z;
    const cull2 = (ctx.cullDist || SIZE * 0.6) ** 2;
    for (const h of humans) {
      // progreso de obra (avanza siempre, aunque esté lejos o de noche)
      if (h.building) {
        const tt = h.data.homeTier || 0, stages = STAGES[tt], total = BUILD_TIME[tt];
        h.buildT += dt;
        const pr = Math.min(1, h.buildT / total), st = Math.min(stages - 1, Math.floor(pr * stages));
        if (st !== h.stage) { h.stage = st; rebuildHome(h, st); }
        if (pr >= 1) { h.building = false; rebuildHome(h, stages - 1); }
      }
      const dxc = h.px - cx, dzc = h.pz - cz;
      const far = dxc * dxc + dzc * dzc > cull2;
      if (h.home) h.home.visible = !far;
      if (far) { h.mesh.visible = false; continue; }
      const sleeping = night && !h.data.nightOwl && !h.building;   // si construye, no duerme
      if (sleeping) { h.mesh.visible = false; continue; }   // durmiendo dentro de su casa
      h.mesh.visible = true;
      h.retarget -= dt;
      if (h.retarget <= 0) {
        h.retarget = 3 + Math.random() * 4;
        const base = h.building ? h.data.home : (night ? h.data.home : anchorFor(h.data.job));   // construye en su lote · de día al trabajo
        const a = Math.random() * 6.283, r = SIZE * 0.012 * Math.random();
        h.tx = base.x + Math.cos(a) * r; h.tz = base.z + Math.sin(a) * r;
      }
      const dx = h.tx - h.px, dz = h.tz - h.pz, d = Math.hypot(dx, dz);
      const spd = 0.6 + (h.data.personality === 'Aventurero' ? 0.5 : 0);
      h.t += dt;
      if (d > 0.4) {                                    // caminando
        h.px += dx / d * spd * dt; h.pz += dz / d * spd * dt;
        h.mesh.rotation.y = Math.atan2(dx, dz);
        const gy = Math.max(0, heightAt(h.px, h.pz));
        h.mesh.position.set(h.px, gy + Math.abs(Math.sin(h.t * 6)) * 0.04, h.pz);
      } else {                                          // trabajando en el sitio (pequeña animación)
        const gy = Math.max(0, heightAt(h.px, h.pz));
        h.mesh.position.set(h.px, gy + Math.abs(Math.sin(h.t * 4)) * 0.02, h.pz);
        h.mesh.rotation.y += Math.sin(h.t * 3) * 0.04;
      }
    }
  }

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
  function refreshPanel() {
    if (panel.style.display === 'none') return;
    const n = humans.length, nm = nextMilestone(n);
    let html = '<div class="ap-head"><span>🏝️ Isla · Followers</span><button id="sim-close">✕</button></div>';
    html += `<div class="stat">Población: <b>${n}</b>${nm ? ' · próximo hito: ' + nm : ''}</div>`;
    html += '<button class="full" id="sim-add">➕ Agregar follower</button>';
    html += '<div id="sim-list">';
    const list = humans.slice().sort((a, b) => b.data.arrival - a.data.arrival).slice(0, 60);
    for (const h of list) {
      const d = h.data, rank = RANK_NAMES[d.tier ?? 0];
      html += `<div class="h-item"><div class="hn">#${d.arrival} ${escapeHtml(d.name)}</div>` +
        `<div class="hr">${rank} · ${d.job} · ${d.sign} · ${d.personality}${d.nightOwl ? ' · 🌙' : ''}</div>` +
        `<div class="acts"><button data-reroll="${d.id}" title="Cambiar signo/personalidad">🎲</button>` +
        `<button data-del="${d.id}" title="Quitar">✕</button></div></div>`;
    }
    if (n > 60) html += `<div class="stat">… y ${n - 60} más</div>`;
    html += '</div>';
    if (n) html += '<button class="full" id="sim-reset" style="margin-top:8px;background:rgba(140,50,55,.5)">🗑 Reiniciar isla</button>';
    panel.innerHTML = html;
  }
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'sim-close') { hidePanel(); return; }
    if (b.id === 'sim-add') { const name = prompt('Nombre / @handle del follower:', 'Follower ' + (humans.length + 1)); if (name !== null) await addFollower(name); return; }
    if (b.id === 'sim-reset') { if (confirm('¿Borrar todos los followers de la isla?')) await resetAll(); return; }
    if (b.dataset.del) { await removeHuman(b.dataset.del); return; }
    if (b.dataset.reroll) { await reroll(b.dataset.reroll); return; }
  });
  function showPanel() { panel.style.display = 'block'; refreshPanel(); }
  function hidePanel() { panel.style.display = 'none'; }
  function togglePanel() { panel.style.display === 'none' ? showPanel() : hidePanel(); }

  // carga inicial desde la DB
  const saved = (await dbGetAll('humans')).sort((a, b) => a.arrival - b.arrival);
  for (const d of saved) { if (d.arrival === 1 && d.home) villageCenter = villageCenter || { x: d.home.x, z: d.home.z }; spawn(d, false); }
  if (saved.length) recomputeTiers(null);   // normaliza niveles/viviendas de datos viejos

  function dispose() { scene.remove(group); scene.remove(homeGroup); panel.remove(); styleEl.remove(); }
  return { addFollower, removeHuman, resetAll, update, showPanel, hidePanel, togglePanel, dispose, count: () => humans.length };
}
