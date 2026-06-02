import * as THREE from 'three';

// --- App shell: menú + cambio entre mundos ---------------------------------
const WORLDS = {
  3: { title: 'Constructor', subtitle: 'Constructor de terreno', module: () => import('./src/worlds/builder.js'), mode: 'build' },
  cine: { title: 'Cinemática', subtitle: 'Escenas y video', module: () => import('./src/worlds/builder.js'), mode: 'cinematic' },
  manage: { title: 'Isla', subtitle: 'Gestión de followers', module: () => import('./src/worlds/builder.js'), mode: 'manage' },
  view: { title: 'Ver Mundo', subtitle: 'Observar y seguir', module: () => import('./src/worlds/builder.js'), mode: 'view' },
};

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);
renderer.domElement.style.display = 'none';

const menu = document.getElementById('menu');
const backBtn = document.getElementById('back');
const hint = document.getElementById('hint');
const hud = document.getElementById('hud');

let current = null;
let loading = false;
const clock = new THREE.Clock();

async function enterWorld(id) {
  if (loading) return;
  loading = true;
  try {
    if (current?.dispose) current.dispose();
    current = null;
    const mod = await WORLDS[id].module();
    // reset de estado del renderer entre mundos
    renderer.shadowMap.enabled = false;
    current = await mod.create({ renderer, hud, mode: WORLDS[id].mode });
    menu.classList.add('hidden');
    renderer.domElement.style.display = 'block';
    backBtn.style.display = 'block';
    hud.style.display = current.showHud ? 'block' : 'none';
    hint.textContent = current.hint || '';
    hint.style.display = current.hint ? 'block' : 'none';
    current.onResize?.(innerWidth, innerHeight);
  } catch (e) {
    console.error(e);
    alert('Error al cargar el mundo: ' + e.message);
    showMenu();
  } finally {
    loading = false;
  }
}

function showMenu() {
  if (current?.dispose) current.dispose();
  current = null;
  renderer.domElement.style.display = 'none';
  backBtn.style.display = 'none';
  hint.style.display = 'none';
  hud.style.display = 'none';
  menu.classList.remove('hidden');
}

document.querySelectorAll('[data-world]').forEach((el) => {
  el.addEventListener('click', () => enterWorld(el.dataset.world));
});
backBtn.addEventListener('click', showMenu);

addEventListener('keydown', (e) => { if (e.code === 'Escape' && current) showMenu(); });

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  current?.onResize?.(innerWidth, innerHeight);
});

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (current) {
    current.update(dt);
    if (current.render) current.render();            // mundos con post-proceso (filtros) dibujan ellos mismos
    else renderer.render(current.scene, current.camera);
  }
}
loop();
