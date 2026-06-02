// Sistema de HUMANOS (followers de IG). Cada follower = un humano con stats random (signo, personalidad,
// trabajo), hogar asignado, rango por antigüedad y comportamiento día/noche (no todos duermen).
// Persistencia en IndexedDB (escala a miles). El render/ctx lo provee el mundo (builder).
import * as THREE from 'three';
import { dbInit, dbGetAll, dbPut, dbDelete, dbClear, metaGet, metaSet } from './db.js';

const SIGNS = ['Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo', 'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis'];
const PERSONALITIES = ['Trabajador', 'Soñador', 'Líder', 'Tímido', 'Aventurero', 'Sociable', 'Solitario', 'Creativo', 'Pragmático', 'Rebelde', 'Leal', 'Ambicioso', 'Glotón', 'Bromista'];
const JOBS = ['Recolector', 'Pescador', 'Leñador', 'Cazador', 'Agricultor', 'Constructor', 'Comerciante', 'Artesano', 'Minero', 'Marinero', 'Estudiante', 'Cocinero', 'Médico', 'Maestro', 'Capataz'];
const RANKS = ['Recién llegado', 'Poblador', 'Vecino', 'Veterano', 'Notable', 'Pionero'];   // de menos a más antiguo
const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000];
const SHIRTS = [0x2f7fc4, 0xc44f3a, 0x3ab36b, 0xb58b2f, 0x7a4fc4, 0xc43a8e, 0x3ab0c4, 0xc4a23a];
const pick = (a) => a[(Math.random() * a.length) | 0];

// rango por antigüedad: el #1 es Fundador; los más viejos rangos altos, los nuevos bajos
function rankOf(arrival, total) {
  if (arrival === 1) return 'Fundador';
  const seniority = 1 - (arrival - 1) / Math.max(1, total - 1);   // 1 = más viejo, 0 = más nuevo
  return RANKS[Math.min(RANKS.length - 1, Math.floor(seniority * RANKS.length))];
}

export async function createHumanSystem(ctx) {
  // ctx = { scene, heightAt, findReliefSpots, SIZE, getTime, camera, toast, mode }
  const { scene, heightAt, findReliefSpots, SIZE, getTime, camera, toast } = ctx;
  await dbInit();
  const group = new THREE.Group(); scene.add(group);
  const tentGroup = new THREE.Group(); scene.add(tentGroup);
  const humans = [];                       // {data, mesh, tent, px, pz, tx, tz, t}
  let villageCenter = null;
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.7 });
  const tentMat = new THREE.MeshStandardMaterial({ color: 0xb9824f, roughness: 0.85, flatShading: true });

  function buildHumanMesh(shirt, h) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.85, 6, 12), m);
    body.position.y = 0.675; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 12), skinMat);
    head.position.y = 1.56; head.castShadow = true;
    g.add(body, head); g.scale.setScalar(h);
    return g;
  }
  function buildTent() {                    // choza/carpa simple (cono)
    const t = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.4, 5), tentMat);
    t.castShadow = true; t.receiveShadow = true;
    return t;
  }

  // elige una posición de hogar en tierra (cluster que crece con la población)
  function pickHome() {
    if (!villageCenter) {
      const spots = findReliefSpots('llano', 4).concat(findReliefSpots('playa', 4));
      villageCenter = spots[0] ? { x: spots[0].x, z: spots[0].z } : { x: 0, z: 0 };
    }
    const spread = SIZE * (0.03 + 0.02 * Math.sqrt(humans.length + 1));
    for (let tryN = 0; tryN < 24; tryN++) {
      const a = Math.random() * 6.283, r = Math.random() * spread;
      const x = villageCenter.x + Math.cos(a) * r, z = villageCenter.z + Math.sin(a) * r;
      if (heightAt(x, z) > 0.5) return { x, z };       // sobre tierra firme
    }
    return { x: villageCenter.x, z: villageCenter.z };
  }
  function workNear(home) {
    const a = Math.random() * 6.283, r = SIZE * (0.02 + Math.random() * 0.05);
    let x = home.x + Math.cos(a) * r, z = home.z + Math.sin(a) * r;
    if (heightAt(x, z) <= 0.5) { x = home.x; z = home.z; }
    return { x, z };
  }

  function spawn(data) {
    const mesh = buildHumanMesh(data.shirt, data.height);
    group.add(mesh);
    const tent = buildTent();
    tent.position.set(data.home.x, Math.max(0, heightAt(data.home.x, data.home.z)) + 0.7, data.home.z);
    tentGroup.add(tent);
    const h = { data, mesh, tent, px: data.home.x, pz: data.home.z, tx: data.home.x, tz: data.home.z, t: Math.random() * 6.283, retarget: 0 };
    humans.push(h);
    return h;
  }

  async function addFollower(name) {
    const total = humans.length + 1;
    const home = pickHome();
    const data = {
      id: 'h' + total + '-' + Date.now() + '-' + ((Math.random() * 1e6) | 0),
      name: (name || 'Follower ' + total).trim(),
      arrival: total,
      sign: pick(SIGNS), personality: pick(PERSONALITIES), job: pick(JOBS),
      shirt: pick(SHIRTS), height: 0.92 + Math.random() * 0.22, nightOwl: Math.random() < 0.25,
      home, work: workNear(home),
    };
    await dbPut('humans', data);
    spawn(data);
    refreshPanel();
    // logro por hito
    if (MILESTONES.includes(total)) {
      toast(total === 1 ? '🏆 ¡El primero en tocar tierra! 🌴' : '🏆 ¡Follower nº ' + total + '!');
      metaSet('milestone', total);
    } else {
      toast('👤 ' + data.name + ' llegó a la isla (' + total + ')');
    }
    return data;
  }

  async function removeHuman(id) {
    const i = humans.findIndex((h) => h.data.id === id);
    if (i < 0) return;
    const h = humans[i];
    group.remove(h.mesh); tentGroup.remove(h.tent);
    h.mesh.traverse((o) => o.geometry?.dispose?.());
    h.tent.geometry.dispose();
    humans.splice(i, 1);
    await dbDelete('humans', id);
    refreshPanel();
  }
  async function reroll(id) {                 // "cambiar características"
    const h = humans.find((x) => x.data.id === id); if (!h) return;
    h.data.sign = pick(SIGNS); h.data.personality = pick(PERSONALITIES); h.data.job = pick(JOBS);
    await dbPut('humans', h.data); refreshPanel();
  }
  async function resetAll() {
    for (const h of humans) { group.remove(h.mesh); tentGroup.remove(h.tent); }
    humans.length = 0; villageCenter = null;
    await dbClear('humans'); refreshPanel();
  }

  // ---- comportamiento día/noche ----
  function update(dt) {
    const time = getTime();
    const night = time < 6 || time > 20.5;
    const cx = camera.position.x, cz = camera.position.z;
    const cull2 = (ctx.cullDist || SIZE * 0.6) ** 2;
    for (const h of humans) {
      const dxc = h.px - cx, dzc = h.pz - cz;
      if (dxc * dxc + dzc * dzc > cull2) { h.mesh.visible = false; h.tent.visible = false; continue; }   // lejos → no render
      h.mesh.visible = true; h.tent.visible = true;
      // destino según hora
      h.retarget -= dt;
      const sleeping = night && !h.data.nightOwl;
      if (sleeping) { h.tx = h.data.home.x; h.tz = h.data.home.z; }
      else if (h.retarget <= 0) {                         // de día va al trabajo / deambula cerca
        h.retarget = 3 + Math.random() * 4;
        const base = (night ? h.data.home : h.data.work);
        const a = Math.random() * 6.283, r = SIZE * 0.015 * Math.random();
        h.tx = base.x + Math.cos(a) * r; h.tz = base.z + Math.sin(a) * r;
      }
      // mover hacia el destino
      const dx = h.tx - h.px, dz = h.tz - h.pz, d = Math.hypot(dx, dz);
      const spd = sleeping ? 0 : (0.6 + (h.data.personality === 'Aventurero' ? 0.5 : 0));
      if (d > 0.2 && spd > 0) {
        h.px += dx / d * spd * dt; h.pz += dz / d * spd * dt;
        h.mesh.rotation.y = Math.atan2(dx, dz);
      }
      const gy = Math.max(0, heightAt(h.px, h.pz));
      h.mesh.position.set(h.px, gy, h.pz);
      // cabeceo sutil al caminar / quietos al dormir
      h.t += dt; h.mesh.position.y = gy + (spd > 0 && d > 0.2 ? Math.abs(Math.sin(h.t * 6)) * 0.04 : 0);
      if (sleeping) h.mesh.visible = false;               // durmiendo dentro de la carpa
    }
  }

  // ---- panel de gestión (DOM, izquierda) ----
  const panel = document.createElement('div');
  panel.id = 'sim-panel';
  panel.style.cssText = 'position:fixed;top:64px;left:16px;z-index:26;width:250px;max-height:calc(100vh - 84px);' +
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
  function refreshPanel() {
    if (panel.style.display === 'none') return;
    const n = humans.length, nm = nextMilestone(n);
    let html = '<div class="ap-head"><span>🏝️ Isla · Followers</span><button id="sim-close">✕</button></div>';
    html += `<div class="stat">Población: <b>${n}</b>${nm ? ' · próximo hito: ' + nm : ''}</div>`;
    html += '<button class="full" id="sim-add">➕ Agregar follower</button>';
    html += '<div id="sim-list">';
    // muestra hasta 60 (los más nuevos primero) para no saturar el DOM
    const list = humans.slice().sort((a, b) => b.data.arrival - a.data.arrival).slice(0, 60);
    for (const h of list) {
      const d = h.data;
      html += `<div class="h-item"><div class="hn">#${d.arrival} ${escapeHtml(d.name)}</div>` +
        `<div class="hr">${rankOf(d.arrival, n)} · ${d.job} · ${d.sign} · ${d.personality}${d.nightOwl ? ' · 🌙' : ''}</div>` +
        `<div class="acts"><button data-reroll="${d.id}" title="Cambiar características">🎲</button>` +
        `<button data-del="${d.id}" title="Quitar">✕</button></div></div>`;
    }
    if (n > 60) html += `<div class="stat">… y ${n - 60} más</div>`;
    html += '</div>';
    if (n) html += '<button class="full" id="sim-reset" style="margin-top:8px;background:rgba(140,50,55,.5)">🗑 Reiniciar isla</button>';
    panel.innerHTML = html;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
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
  for (const d of saved) { if (d.arrival === 1 && d.home) villageCenter = villageCenter || { x: d.home.x, z: d.home.z }; spawn(d); }

  function dispose() { scene.remove(group); scene.remove(tentGroup); panel.remove(); styleEl.remove(); }

  return { addFollower, removeHuman, resetAll, update, showPanel, hidePanel, togglePanel, dispose, count: () => humans.length };
}
