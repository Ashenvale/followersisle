import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createHumanSystem } from '../sim/humans.js';

// MUNDO 3 — Constructor de terreno con tamaño elegible (hasta varios km).
// El lienzo es el océano: levantas tierra con el pincel y se forman playas/acantilados.
//   Clic-izq = esculpir/colocar · clic-DER = orbitar · arrastrar rueda = mover · girar rueda = zoom
export async function create({ renderer, mode }) {
  const CINE_MODE = mode === 'cinematic';   // sección dedicada: oculta edición, enfoca clima/tiempo/escenas
  const MANAGE_MODE = mode === 'manage';    // sección Isla/Gestión: followers, trabajos, ciclos
  const VIEW_MODE = mode === 'view';        // sección Ver Mundo: solo observar y seguir
  const params = {
    sizeKm: 1,              // tamaño del mapa (km)
    coverage: 35,           // % del mapa cubierto por tierra al generar
    erosion: 0.5,           // erosión hidráulica al generar (0 = ninguna)
    rivers: 3,              // nº de ríos al generar (nacen en lo alto y bajan al mar)
    lakes: 1,               // nº de lagos al generar
    vegDensity: 1.0,        // densidad de vegetación al pintar biomas
    vegDist: 900,           // distancia (m) a la que se deja de dibujar vegetación
    mode: 'Subir',          // Subir | Bajar | Suavizar | Aplanar
    brushSize: 25,          // radio del pincel (m)
    strength: 0.9,          // fuerza por pasada
    mar: true,
    wireframe: false,
    heatmap: false,         // vista de clasificación de relieve (playa/acantilado/barranco/…)
    showZones: true,        // mostrar el coloreado de zonas (residencia/servicios)
    timeOfDay: 13,          // hora del día (0-24); por defecto MEDIODÍA y congelada
    dayCycle: false,        // por defecto NO avanza (la última selección queda fija)
    daySeconds: 120,        // duración de un día completo (s)
    moonPhase: 0.5,         // 0 luna nueva · 0.5 llena · 1 nueva otra vez
    moonCycle: false,       // por defecto NO avanza
    season: 0.2,            // verano por defecto
    seasonCycle: false,     // por defecto NO avanza
    seasonSeconds: 240,     // duración de un año completo (s)
    weather: true,          // clima localizado (nubes/lluvia/niebla por zonas)
    weatherAmount: 0.5,     // 0 despejado … 1 muy cubierto (densidad de celdas)
    shoreWaves: true,       // olas/espuma rompiendo en la orilla
    windSpeed: 0.4,         // 0 calma … 1 vendaval; mece árboles cercanos y olas, y arrastra el clima
    sceneSegSecs: 5,        // segundos por plano en las escenas scripted de cinemática
    cineFormat: '1080p 16:9', // formato/resolución de grabación
    cineW: 1920, cineH: 1080, // resolución personalizada
    filter: 'Ninguno',      // filtro de color (look): Realista, Cinemático, etc.
  };
  // persistencia: la ÚLTIMA selección (hora, clima, etc.) queda guardada y se restaura en todos lados
  const SETTINGS_KEY = 'evermark_settings_v1';
  const SETTINGS_KEYS = ['timeOfDay', 'dayCycle', 'daySeconds', 'moonPhase', 'moonCycle', 'season', 'seasonCycle', 'seasonSeconds', 'weather', 'weatherAmount', 'windSpeed', 'shoreWaves', 'filter', 'sceneSegSecs', 'cineFormat'];
  function loadSettings() { try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); if (s) for (const k of SETTINGS_KEYS) if (k in s) params[k] = s[k]; } catch (e) {} }
  function saveSettings() { try { const o = {}; for (const k of SETTINGS_KEYS) o[k] = params[k]; localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch (e) {} }
  loadSettings();
  // en la sección Cinemática los ciclos arrancan APAGADOS (el guion los maneja con keyframes)
  if (CINE_MODE) { params.dayCycle = false; params.moonCycle = false; params.seasonCycle = false; }

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 200000);

  // ===== POST-PROCESO: filtros de color (look) que se hornean también en la grabación =====
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());                 // tonemapping ACES + sRGB
  const gradePass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uSat: { value: 1 }, uCon: { value: 1 }, uBri: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) }, uVig: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform float uSat; uniform float uCon; uniform float uBri; uniform vec3 uTint; uniform float uVig; varying vec2 vUv;\n' +
      'void main(){ vec4 c = texture2D(tDiffuse, vUv); vec3 col = c.rgb * uBri * uTint;\n' +
      '  float l = dot(col, vec3(0.299,0.587,0.114)); col = mix(vec3(l), col, uSat);\n' +
      '  col = (col - 0.5) * uCon + 0.5;\n' +
      '  col *= 1.0 - uVig * smoothstep(0.30, 0.85, distance(vUv, vec2(0.5)));\n' +
      '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a); }',
  });
  composer.addPass(gradePass);                         // grading sobre la imagen final
  const GRADE_PRESETS = {
    'Ninguno':    { sat: 1.0, con: 1.0,  bri: 1.0,  tint: [1, 1, 1],          vig: 0.0 },
    'Realista':   { sat: 1.12, con: 1.08, bri: 1.0,  tint: [1.0, 1.0, 1.0],   vig: 0.15 },
    'Cinemático': { sat: 1.05, con: 1.16, bri: 0.98, tint: [1.04, 1.0, 0.94], vig: 0.38 },
    'Cálido':     { sat: 1.12, con: 1.06, bri: 1.02, tint: [1.12, 1.02, 0.9], vig: 0.22 },
    'Frío':       { sat: 1.0,  con: 1.06, bri: 1.0,  tint: [0.9, 0.98, 1.14], vig: 0.22 },
    'Vintage':    { sat: 0.7,  con: 0.95, bri: 1.03, tint: [1.12, 1.0, 0.82], vig: 0.42 },
    'Blanco y negro': { sat: 0.0, con: 1.22, bri: 1.0, tint: [1, 1, 1],       vig: 0.36 },
    'Vívido':     { sat: 1.42, con: 1.12, bri: 1.0,  tint: [1, 1, 1],         vig: 0.1 },
  };
  function applyFilter() {
    const g = GRADE_PRESETS[params.filter] || GRADE_PRESETS['Ninguno'];
    const u = gradePass.uniforms;
    u.uSat.value = g.sat; u.uCon.value = g.con; u.uBri.value = g.bri; u.uVig.value = g.vig;
    u.uTint.value.setRGB(g.tint[0], g.tint[1], g.tint[2]);
    // 'Ninguno' = valores identidad → el pass queda activo pero deja la imagen igual (no deshabilitar: rompe la salida)
  }
  applyFilter();
  function renderFrame() { composer.render(); }        // el shell y el render offline dibujan por acá

  // ===== CICLO DÍA/NOCHE: sol, luna con fases y estrellas, todo en función de params.timeOfDay =====
  const TWO_PI = Math.PI * 2;
  const SKY_TILT = 0.35;                 // inclinación del arco diurno (da deriva norte-sur al recorrido)
  function celestialDir(A, out) {        // dirección en el cielo para un ángulo de arco A (0=sale E · π/2=cenit · π=se pone O · 3π/2=bajo tierra)
    return out.set(Math.cos(A), Math.sin(A) * Math.cos(SKY_TILT), Math.sin(A) * Math.sin(SKY_TILT));
  }

  // cielo
  const sky = new Sky(); sky.scale.setScalar(90000); scene.add(sky);
  sky.material.uniforms.turbidity.value = 5;
  sky.material.uniforms.rayleigh.value = 1.4;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.mieDirectionalG.value = 0.85;
  const sun = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  celestialDir((params.timeOfDay / 24 - 0.25) * TWO_PI, sun);
  sky.material.uniforms.sunPosition.value.copy(sun);

  // sol (luz direccional con sombras) + relleno hemisférico
  const sunLight = new THREE.DirectionalLight(0xfff2dd, 2.1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0004;
  scene.add(sunLight, sunLight.target);
  const hemiLight = new THREE.HemisphereLight(0xcfe0ff, 0x55633f, 0.7);
  scene.add(hemiLight);
  const _warmLow = new THREE.Color(0xff8a3c), _warmHigh = new THREE.Color(0xfff2dd);

  // luna: esfera iluminada por la dirección REAL del sol → el terminador dibuja la fase correcta sola
  const moonLight = new THREE.DirectionalLight(0x9fb6e0, 0.0);   // ilumina suavemente el terreno de noche
  scene.add(moonLight, moonLight.target);
  const moonMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uLit: { value: new THREE.Color(0xf2f0e6) },
      uDark: { value: new THREE.Color(0x222a3a) },
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec3 vN;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uSun; uniform vec3 uLit; uniform vec3 uDark; uniform float uOpacity;
      varying vec3 vN;
      void main() {
        float d = dot(normalize(vN), normalize(uSun));
        float lit = smoothstep(-0.08, 0.12, d);     // terminador suave → media luna / gibosa / llena
        gl_FragColor = vec4(mix(uDark, uLit, lit), uOpacity);
      }`,
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(2300, 32, 24), moonMat);
  moon.renderOrder = 1;
  scene.add(moon);

  // estrellas: puntos repartidos por la bóveda alta; se desvanecen de día
  const starGeo = new THREE.BufferGeometry();
  const STAR_N = 1600, starPos = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    const th = Math.acos(Math.random()), ph = Math.random() * TWO_PI;   // solo hemisferio superior (cielo)
    const r = 82000;
    starPos[i * 3]     = r * Math.sin(th) * Math.cos(ph);
    starPos[i * 3 + 1] = r * Math.cos(th);
    starPos[i * 3 + 2] = r * Math.sin(th) * Math.sin(ph);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  // sprite redondo y suave → puntitos en vez de cuadros duros (también en el reflejo del agua)
  const starCanvas = document.createElement('canvas'); starCanvas.width = starCanvas.height = 32;
  const sctx = starCanvas.getContext('2d');
  const sgrad = sctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  sgrad.addColorStop(0.0, 'rgba(255,255,255,1)');
  sgrad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  sgrad.addColorStop(1.0, 'rgba(255,255,255,0)');
  sctx.fillStyle = sgrad; sctx.fillRect(0, 0, 32, 32);
  const starTex = new THREE.CanvasTexture(starCanvas);
  const starMat = new THREE.PointsMaterial({ color: 0xdfe8ff, map: starTex, size: 6, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // recalcula sol/luna/luces/cielo a partir de params.timeOfDay y params.moonPhase
  function updateSky() {
    const As = (params.timeOfDay / 24 - 0.25) * TWO_PI;   // hora → ángulo de arco del sol
    celestialDir(As, sun);
    const elong = params.moonPhase * TWO_PI;              // separación luna-sol → fase
    celestialDir(As - elong, moonDir);                    // la luna sigue al sol con un retraso = elongación
    const dayF = THREE.MathUtils.smoothstep(sun.y, -0.06, 0.20);     // 0 noche · 1 día
    const moonUp = THREE.MathUtils.smoothstep(moonDir.y, -0.05, 0.18);
    const fullness = 0.5 * (1 - Math.cos(elong));         // 0 nueva … 1 llena
    const SZ = SIZE || 1000;
    // CIELO + SOL
    sky.material.uniforms.sunPosition.value.copy(sun);
    sunLight.intensity = 2.3 * dayF;
    sunLight.color.copy(_warmLow).lerp(_warmHigh, THREE.MathUtils.smoothstep(sun.y, 0.02, 0.5));
    sunLight.position.copy(sun).multiplyScalar(SZ * 1.5);
    sunLight.target.position.set(0, 0, 0);
    // LUNA
    moon.position.copy(moonDir).multiplyScalar(60000);
    moonMat.uniforms.uSun.value.copy(sun).normalize();
    moonMat.uniforms.uOpacity.value = moonUp;             // se oculta bajo el horizonte
    moonLight.position.copy(moonDir).multiplyScalar(SZ * 1.5);
    moonLight.target.position.set(0, 0, 0);
    moonLight.intensity = 0.45 * moonUp * fullness * (1 - dayF * 0.85);
    // RELLENO + ESTRELLAS + EXPOSICIÓN + BRILLO DEL AGUA
    hemiLight.intensity = THREE.MathUtils.lerp(0.10, 0.7, dayF);
    starMat.opacity = (1 - dayF) * 0.9;
    renderer.toneMappingExposure = THREE.MathUtils.lerp(0.55, 1.0, dayF);
    water.material.uniforms.sunDirection.value.copy(dayF > 0.12 ? sun : moonDir).normalize();
  }

  // mar (enorme y fijo; cubre cualquier tamaño de mapa)
  const water = new Water(new THREE.PlaneGeometry(120000, 120000), {
    textureWidth: 512, textureHeight: 512,
    waterNormals: new THREE.TextureLoader().load('./assets/waternormals.jpg',
      (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; }),
    sunDirection: sun.clone().normalize(), sunColor: 0xffffff,
    waterColor: 0x1f6b86, distortionScale: 3.0, fog: false,
  });
  water.rotation.x = -Math.PI / 2; water.position.y = 0;
  scene.add(water);

  // anillo del pincel
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.05, 48),
    new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
  ring.rotation.x = -Math.PI / 2; ring.renderOrder = 5; ring.visible = false;
  scene.add(ring);
  function resizeRing() {
    ring.geometry.dispose();
    const r = params.brushSize;
    ring.geometry = new THREE.RingGeometry(r * 0.97, r, 64);
  }

  // ---- RNG sembrable: la isla se genera de forma DETERMINISTA a partir de una semilla,
  // así que basta guardar la semilla (+ ajustes) para reconstruirla idéntica al recargar ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = Math.random;        // se reemplaza por mulberry32(semilla) al generar
  let currentSeed = null;       // semilla de la isla actual (para guardar)
  const SAVE_KEY = 'evermark_island_v1';      // slot rápido (autocarga al entrar)
  const LIB_KEY = 'evermark_islands_lib_v1';  // biblioteca de mapas guardados con nombre

  // ---- estado del terreno (depende del tamaño) ----
  let SIZE, SEG, N, CELL, LAND_MAX, SEA_FLOOR, STRENGTH_SCALE, BEACH_TOP;
  let geo = null, mesh = null, height = null, colors = null, posAttr = null, biomes = null, waterMask = null;
  let relief = null;            // clase de relieve por celda (playa/acantilado/barranco/… → terrainClassAt)
  let zones = null;             // zonificación por celda: 0 ninguna · 1 residencia · 2 servicios (dónde se permite construir)
  let seasonSnowY = 1e9;        // cota de la línea de nieve (cambia con la estación; nieve solo por encima)
  let lakeMask = null;          // 1 en celdas de LAGO (agua dulce) → humedad más fuerte que los ríos
  let wetField = null;          // 0..1 proximidad al agua (alto cerca de agua, decae con la distancia)
  let lakeField = null, riverField = null;   // influencia separada de lagos (→bosque) y ríos (→selva)
  let lakeInfo = [];            // {x,z,level,r} por lago → peces de lago (varios tamaños)
  let riverPts = [];            // {x,z,y} puntos de cauce a BAJA altura (no montaña) → peces chiquitos de río

  // grupo y materiales para ríos/lagos/cascadas
  const waterGroup = new THREE.Group(); scene.add(waterGroup);
  const lakeNormals = new THREE.TextureLoader().load('./assets/waternormals.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; });
  // normal map propio del río (se desplaza río abajo → sensación de flujo)
  const riverNormals = new THREE.TextureLoader().load('./assets/waternormals.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; });
  const riverMat = new THREE.MeshStandardMaterial({
    color: 0x3f86b8, transparent: true, opacity: 0.86, roughness: 0.18, metalness: 0.2,
    normalMap: riverNormals, normalScale: new THREE.Vector2(0.5, 0.5), side: THREE.DoubleSide,
  });
  const fallMat = new THREE.MeshStandardMaterial({ color: 0xdfeefc, transparent: true, opacity: 0.72, roughness: 0.1, emissive: 0x223344, side: THREE.DoubleSide });
  const lakeWaters = [];   // instancias Water (espejo) de los lagos, para animar

  // ---- biomas (color + qué se siembra al pintar) ----
  // cada bioma: color + qué planta(s) crecen al pintar (keys de assetDefs; se reparten al azar)
  // El SUELO va en tonos tierra/roca/seco: el VERDE lo aportan las plantas (densas), no el piso pintado.
  const BIOMES = {
    bosque:   { label: '🌲 Bosque',   color: [62, 56, 40],    scatter: { keys: ['arbol', 'arbol', 'arbol', 'pino', 'pino', 'arbusto', 'hierba', 'frutal'], prob: 0.92, hMin: 0.45 } },
    selva:    { label: '🌴 Selva',    color: [46, 52, 36],    scatter: { keys: ['palmera', 'arbol', 'palmera', 'arbol', 'arbol', 'arbusto', 'hierba', 'frutal'], prob: 0.97, hMin: 0.35 } },
    taiga:    { label: '🌲 Taiga',    color: [58, 56, 44],    scatter: { keys: ['pino', 'pino', 'arbol', 'arbusto'], prob: 0.88, hMin: 0.45 } },
    pradera:  { label: '🌿 Pradera',  color: [86, 92, 58],    scatter: { keys: ['hierba', 'hierba', 'hierba', 'hierba', 'arbusto', 'arbol', 'frutal'], prob: 0.88, hMin: 0.45 } },
    sabana:   { label: '🌾 Sabana',   color: [150, 138, 90],  scatter: { keys: ['hierba', 'hierba', 'arbol', 'arbusto'], prob: 0.55, hMin: 0.45 } },
    matorral: { label: '🌵 Matorral', color: [120, 104, 72],  scatter: { keys: ['arbusto', 'arbusto', 'hierba', 'rocas'], prob: 0.6, hMin: 0.45 } },
    desierto: { label: '🏜️ Desierto', color: [214, 196, 146], scatter: { keys: ['cactus', 'cactus', 'rocas'], prob: 0.3, hMin: 0.5 } },
    tundra:   { label: '🍂 Tundra',   color: [112, 112, 96],  scatter: { keys: ['arbusto', 'hierba', 'rocas'], prob: 0.42, hMin: 0.5 } },
    pantano:  { label: '🌳 Manglar',  color: [56, 58, 44],    scatter: { keys: ['palmera', 'arbol', 'arbusto', 'palmera', 'hierba'], prob: 0.78, hMin: 0.05 } },
    playa:    { label: '🏖️ Playa',    color: [231, 216, 168], scatter: null },
    roca:     { label: '⛰️ Roca',     color: [120, 110, 86],  scatter: { keys: ['formacion', 'rocas'], prob: 0.4, hMin: 0.6 } },
    nieve:    { label: '❄️ Nieve',    color: [244, 246, 250], scatter: null },
  };
  const biomeKeys = Object.keys(BIOMES);          // índice 0..n-1 ; en el array se guarda id = índice+1 (0 = ninguno)
  const propGrid = new Map();                     // celda -> { plant, id, biome } (props instanciados al pintar)
  function clearPropGrid() { resetInstances(); propGrid.clear(); }
  // separación FIJA (no depende de la densidad → la rejilla es estable y borrar/repintar
  // siempre encuentra las instancias). La densidad controla la probabilidad de sembrar.
  // espaciado de siembra: crece con el mapa pero con TOPE → islas grandes no quedan ralas (antes SIZE/440 = ~11 m en 5 km)
  function propSpacing() { return Math.max(2.4, Math.min(5.5, SIZE / 800)); }

  function configureForSize() {
    SIZE = params.sizeKm * 1000;
    SEG = THREE.MathUtils.clamp(Math.round(SIZE / 13), 160, 400); // presupuesto de vértices
    N = SEG + 1;
    CELL = SIZE / SEG;
    LAND_MAX = Math.min(400, Math.max(60, SIZE * 0.12)); // altura típica de montaña (con tope)
    SEA_FLOOR = -Math.max(8, SIZE * 0.05);    // profundidad del lecho marino
    STRENGTH_SCALE = LAND_MAX / 36;           // el pincel escala con la altura del mapa
    BEACH_TOP = Math.max(3, LAND_MAX * 0.05); // cota superior de la franja de playa (arena, sin árboles)
  }

  // ---- color por altura (escala con LAND_MAX / SEA_FLOOR) ----
  // rampa por altura en tonos TIERRA (sin verde): el verde lo ponen las plantas
  const LAND_STOPS = [
    [0.00, [228, 214, 168]], [0.04, [214, 198, 150]], [0.10, [150, 140, 96]],
    [0.45, [120, 108, 78]], [0.70, [134, 124, 100]], [0.88, [176, 172, 164]], [1.00, [252, 252, 255]],
  ];
  const SEA_STOPS = [[0.00, [214, 200, 160]], [0.05, [70, 120, 150]], [0.35, [45, 90, 120]], [1.00, [26, 58, 90]]];
  function lerpStops(stops, f) {
    for (let i = 0; i < stops.length - 1; i++) {
      if (f <= stops[i + 1][0]) {
        const [a, ca] = stops[i], [b, cb] = stops[i + 1];
        const k = Math.max(0, Math.min(1, (f - a) / ((b - a) || 1)));
        return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
      }
    }
    return stops[stops.length - 1][1];
  }
  function rampColor(h, out, o) {
    const c = h >= 0
      ? lerpStops(LAND_STOPS, Math.min(1, h / LAND_MAX))
      : lerpStops(SEA_STOPS, Math.min(1, h / SEA_FLOOR));
    out[o] = c[0] / 255; out[o + 1] = c[1] / 255; out[o + 2] = c[2] / 255;
  }

  // color de un vértice: bajo el agua = mar; si tiene bioma = color del bioma; si no = por altura.
  // En ambos casos la PENDIENTE vira a roca y oscurece (acantilados/laderas → menos plastilina).
  const ROCK_COL = [120, 110, 86];
  function colorVert(idx) {
    const h = height[idx], o = idx * 3;
    if (params.heatmap && relief) {                 // vista de relieve: color por clase geomorfológica
      const c = RELIEF_COLORS[relief[idx]];
      colors[o] = c[0] / 255; colors[o + 1] = c[1] / 255; colors[o + 2] = c[2] / 255; return;
    }
    if (waterMask && waterMask[idx]) { colors[o] = 0.13; colors[o + 1] = 0.28; colors[o + 2] = 0.38; return; } // lecho de río/lago
    if (h < 0) { rampColor(h, colors, o); return; }
    const i = idx % N, j = (idx / N) | 0;
    const b = biomes[idx];
    let r, g, bl;
    if (b > 0) { const c = BIOMES[biomeKeys[b - 1]].color; r = c[0]; g = c[1]; bl = c[2]; }
    else { const c = lerpStops(LAND_STOPS, Math.min(1, h / LAND_MAX)); r = c[0]; g = c[1]; bl = c[2]; }
    const rk = Math.min(1, Math.max(0, (slopeAt(i, j) - 0.5) / 0.8));   // 0 llano .. 1 acantilado
    r = r * (1 - rk) + ROCK_COL[0] * rk; g = g * (1 - rk) + ROCK_COL[1] * rk; bl = bl * (1 - rk) + ROCK_COL[2] * rk;
    if (h > seasonSnowY) {                                      // nieve dinámica: solo por encima de la línea de nieve estacional
      let sa = Math.min(1, (h - seasonSnowY) / (LAND_MAX * 0.10 + 1));
      sa *= 1 - rk * 0.7;                                       // apenas cuaja en paredes muy escarpadas
      r = r * (1 - sa) + 252 * sa; g = g * (1 - sa) + 252 * sa; bl = bl * (1 - sa) + 255 * sa;
    }
    const jit = 0.9 + 0.2 * hash(idx * 0.137, idx * 0.911);     // grano natural
    const shade = (1 - rk * 0.22) * jit;                        // laderas algo más oscuras
    colors[o] = (r / 255) * shade; colors[o + 1] = (g / 255) * shade; colors[o + 2] = (bl / 255) * shade;
    if (params.showZones && zones && zones[idx]) {       // tinte de zona (residencia azul · servicios naranja)
      const zc = zones[idx] === 1 ? [80, 150, 230] : [230, 160, 60], k = 0.42;
      colors[o] = colors[o] * (1 - k) + (zc[0] / 255) * k; colors[o + 1] = colors[o + 1] * (1 - k) + (zc[1] / 255) * k; colors[o + 2] = colors[o + 2] * (1 - k) + (zc[2] / 255) * k;
    }
  }
  function recolorAll() {
    for (let i = 0; i < N * N; i++) colorVert(i);
    geo.attributes.color.needsUpdate = true;
  }
  // muestreo de altura (vecino más cercano) en coords de mundo
  function heightAt(wx, wz) {
    const c = worldToIndex(wx, wz);
    if (c.i < 0 || c.j < 0 || c.i >= N || c.j >= N) return SEA_FLOOR;
    return height[c.j * N + c.i];
  }
  // muestreo BILINEAL: altura exacta sobre la superficie de la malla (no el vértice más cercano)
  // → los assets se apoyan en el terreno y no flotan en las laderas
  function heightBilinear(wx, wz) {
    const fx = (wx / SIZE + 0.5) * SEG, fz = (0.5 + wz / SIZE) * SEG;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    if (i0 < 0 || j0 < 0 || i0 >= N - 1 || j0 >= N - 1) return heightAt(wx, wz);
    const tx = fx - i0, tz = fz - j0;
    const h00 = height[j0 * N + i0], h10 = height[j0 * N + i0 + 1];
    const h01 = height[(j0 + 1) * N + i0], h11 = height[(j0 + 1) * N + i0 + 1];
    const a = h00 * (1 - tx) + h10 * tx, b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - tz) + b * tz;
  }

  function refresh() {
    for (let i = 0; i < N * N; i++) posAttr.setZ(i, height[i]);
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    computeRelief();        // clasifica el relieve final → terrainClassAt / heatmap
    recolorAll();
  }

  // índice <-> mundo (mesh rotado -90° X: local x=wx, local y=-wz)
  function worldToIndex(wx, wz) {
    return { i: Math.round((wx / SIZE + 0.5) * SEG), j: Math.round((0.5 + wz / SIZE) * SEG) };
  }
  function vertWorld(i, j) {
    return { x: (i / SEG - 0.5) * SIZE, z: (j / SEG - 0.5) * SIZE };
  }

  // ---- ruido (fbm) en coords normalizadas: misma forma a cualquier tamaño ----
  function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  function fbm(x, y) {
    let s = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < 6; o++) { s += amp * vnoise(x * freq, y * freq); norm += amp; amp *= 0.5; freq *= 2.05; }
    return s / norm;
  }
  // relieve fractal con crestas (cordilleras y valles → orgánico, no domo)
  function ridgedFbm(x, y) {
    let s = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < 6; o++) {
      const n = 1 - Math.abs(vnoise(x * freq, y * freq) * 2 - 1);
      s += amp * n * n; norm += amp; amp *= 0.5; freq *= 2.05;
    }
    return s / norm;
  }
  // Genera una ISLA PRINCIPAL centrada con una MONTAÑA en el medio (nieve en la cima),
  // rodeada de varios ISLOTES, y biomas variados (desierto↔bosque↔selva por humedad).
  // % tierra = params.coverage (percentil sobre el campo tierra/mar).
  function generateRandom(seed) {
    // semilla: si llega un número la usamos (carga); si no (botón GUI pasa un evento) → aleatoria
    currentSeed = (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0) : ((Math.random() * 4294967296) >>> 0);
    rng = mulberry32(currentSeed);
    const ox = rng() * 200, oy = rng() * 200;
    const eox = rng() * 200, eoy = rng() * 200;
    const sizeFactor = Math.max(0.8, SIZE / 600);
    const freq = Math.min((2.2 + rng() * 1.6) * sizeFactor, SEG / 7);
    const efreq = freq * (0.5 + rng() * 0.5);   // baja frecuencia → macizos anchos
    const ridgeMix = 0.4 + rng() * 0.3;
    const warp = 0.18 + rng() * 0.16;           // costa sinuosa pero isla reconocible
    const Rmain = 0.30 + rng() * 0.05;          // radio de la isla principal (normalizado)
    const Rmtn = Rmain * (0.85 + rng() * 0.12); // alcance de la montaña central
    // costa por LADO: unos flancos serán playa (rampa suave) y otros acantilado (pared rocosa)
    const caK1 = 1 + (rng() * 2 | 0), caPh1 = rng() * Math.PI * 2;
    const caK2 = 2 + (rng() * 3 | 0), caPh2 = rng() * Math.PI * 2;
    const caBias = -0.12 + rng() * 0.24;        // sesga cuánto del perímetro es acantilado
    // ARISTAS/ESPOLONES de la montaña: crestas radiales que bajan del pico (relieve realista, no domo)
    const nSpur = 4 + (rng() * 4 | 0);          // nº de espolones
    const spurPh = rng() * Math.PI * 2;
    const spurAmp = 0.16 + rng() * 0.10;        // qué tan marcadas son las aristas

    // islotes alrededor de la isla principal (centros en un anillo, dentro del mapa)
    const nSat = 3 + (rng() * 4 | 0);
    const sats = [];
    for (let k = 0; k < nSat; k++) {
      const a = rng() * Math.PI * 2;
      const dist = Rmain + 0.06 + rng() * 0.10;
      const sx = THREE.MathUtils.clamp(0.5 + Math.cos(a) * dist, 0.15, 0.85);
      const sy = THREE.MathUtils.clamp(0.5 + Math.sin(a) * dist, 0.15, 0.85);
      sats.push({ x: sx, y: sy, r: 0.045 + rng() * 0.055 });
    }

    const f = new Float32Array(N * N);             // campo tierra/mar (>0 = tierra tras umbral)
    const eArr = new Float32Array(N * N);          // elevación 0..1 (cono central + colinas)
    let minF = Infinity, maxF = -Infinity;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / SEG, v = j / SEG;
      // coordenadas deformadas → contornos sinuosos
      const wx = u + warp * (fbm(u * 2 + ox, v * 2 + oy) - 0.5);
      const wy = v + warp * (fbm(u * 2 + ox + 5.2, v * 2 + oy + 1.7) - 0.5);
      const dC = Math.hypot(wx - 0.5, wy - 0.5);           // distancia al centro (deformada, para la costa)
      const dCpure = Math.hypot(u - 0.5, v - 0.5);          // distancia al centro REAL (para la montaña)
      const coast = (fbm(u * freq + ox, v * freq + oy) - 0.5) * 0.16;   // ondula la costa
      // isla principal centrada; los islotes se suman con MAX → masas separadas
      let val = (Rmain - dC) + coast;
      for (const s of sats) {
        const ds = Math.hypot(wx - s.x, wy - s.y);
        val = Math.max(val, (s.r - ds) + coast * 0.5);
      }
      // elevación: macizo central que domina el medio (cima SIEMPRE centrada, distancia REAL)
      // pero con CONTORNO IRREGULAR (crestas/entrantes) y cumbre PICUDA, no un cono de helado
      const radNoise = 0.70 + 0.55 * fbm(u * 1.8 + eox + 3.1, v * 1.8 + eoy + 8.4);  // deforma el radio → no es un círculo
      const cen = Math.max(0, Math.min(1, 1 - dCpure / (Rmtn * radNoise)));
      const cone = Math.pow(cen, 1.7);                      // masa principal: ladera empinada
      const tip = Math.pow(cen, 4.5);                       // cúspide afilada y alta (pico, no domo)
      const hills = fbm(wx * efreq + eox, wy * efreq + eoy);
      const ridges = ridgedFbm(wx * efreq * 0.8 + eox + 2.3, wy * efreq * 0.8 + eoy + 7.1);
      const rough = hills * (1 - ridgeMix) + ridges * ridgeMix;
      // crestas escarpadas concentradas en la cima → cumbre rugosa/irregular (sin agujas en el llano)
      const crag = ridgedFbm(wx * efreq * 1.8 + eox + 12.7, wy * efreq * 1.8 + eoy + 2.9);
      // ARISTAS radiales: espolones afilados que bajan del pico (ángulo perturbado con ruido → irregulares)
      const angC = Math.atan2(v - 0.5, u - 0.5);
      const spurN = fbm(u * 2.4 + eox + 4.4, v * 2.4 + eoy + 6.6) - 0.5;
      const spur = Math.pow(0.5 + 0.5 * Math.cos(angC * nSpur + spurPh + 3.0 * spurN), 2.2);
      let elev = cone * (0.62 + 0.30 * crag)                // masa principal rugosa
               + tip * 0.30                                  // pico afilado dominante
               + cen * spurAmp * spur * (0.6 + 0.4 * crag)   // aristas radiales (fuertes cerca de la cima)
               + rough * 0.44 * (1 - cone);                  // colinas fuera del macizo
      elev = Math.max(0, Math.min(1.15, elev));
      const idx = j * N + i;
      f[idx] = val; eArr[idx] = elev;
      if (val < minF) minF = val; if (val > maxF) maxF = val;
    }

    // umbral por percentil → cobertura exacta
    const cov = THREE.MathUtils.clamp(params.coverage / 100, 0.02, 0.7);
    const sorted = Float32Array.from(f).sort();
    const T = sorted[Math.floor((1 - cov) * (sorted.length - 1))];
    const landRange = (maxF - T) || 1;
    const seaRange = (T - minF) || 1;

    // perfil costa→interior: según el LADO, PLAYA (rampa suave de arena) o ACANTILADO (pared rocosa)
    const COAST = 0.6;
    const beachEnd = 0.10;                 // frac de la rampa de arena en los lados de playa
    const plainEnd = 0.38;                 // frac donde acaba la llanura y empieza a subir
    const plainTop = BEACH_TOP * 1.7;      // cota de la llanura (baja)
    const cliffTop = LAND_MAX * 0.30;      // cota del borde superior del acantilado (pared alta)
    for (let idx = 0; idx < N * N; idx++) {
      const val = f[idx];
      if (val > T) {
        const i = idx % N, j = (idx / N) | 0;
        const ang = Math.atan2(j / SEG - 0.5, i / SEG - 0.5);
        // cliffiness 0..1 según la DIRECCIÓN: dos senos de baja frecuencia → lados alternos
        let cliff = (0.5 + 0.5 * Math.sin(ang * caK1 + caPh1)) * 0.6
                  + (0.5 + 0.5 * Math.sin(ang * caK2 + caPh2)) * 0.4 + caBias;
        cliff = THREE.MathUtils.clamp(cliff, 0, 1);
        cliff = cliff * cliff * (3 - 2 * cliff);                       // smoothstep
        const coastTop = BEACH_TOP + (cliffTop - BEACH_TOP) * cliff;   // playa baja ↔ borde alto
        const localBeachEnd = Math.max(0.008, beachEnd * (1 - 0.94 * cliff)); // acantilado = rampa casi nula
        const localPlainTop = Math.max(plainTop, coastTop);
        const frac = (val - T) / landRange;               // 0 costa .. 1 interior
        let h;
        if (frac < localBeachEnd) {
          h = (frac / localBeachEnd) * coastTop;          // arena (playa) o pared vertical (acantilado)
        } else if (frac < plainEnd) {
          const t = (frac - localBeachEnd) / (plainEnd - localBeachEnd);
          h = coastTop + (localPlainTop - coastTop) * t + eArr[idx] * LAND_MAX * 0.04 * t;
        } else {
          const t = THREE.MathUtils.clamp((frac - plainEnd) / (1 - plainEnd), 0, 1);
          const ease = t * t * (3 - 2 * t);               // subida suave al interior
          h = localPlainTop + ease * (eArr[idx] * LAND_MAX - localPlainTop);
        }
        height[idx] = h;
      } else {
        height[idx] = -COAST - Math.sqrt((T - val) / seaRange) * (Math.abs(SEA_FLOOR) - COAST);
      }
    }
    if (params.erosion > 0) erode(params.erosion);   // talla valles/cárcavas (realismo)
    smoothHeights(0.35);                              // quita artefactos pero conserva crestas/irregularidad
    clearPropGrid();
    generateWaterFeatures();        // ríos, lagos y cascadas (siguen los valles erosionados)
    computeWetField();              // proximidad al agua → modula densidad de vegetación
    autoBiome();                    // biomas por altura + humedad + pendiente (sobre el relieve final)
    scatterVegetationAll();         // siembra la vegetación de cada bioma por todo el mapa
    refresh();
    spawnFauna();                   // aves, ballenas y peces acordes al agua generada
    buildShoreFoam();               // olas/espuma a lo largo de la costa generada
  }

  // ---- biomas automáticos: clasifica cada vértice de tierra por altura, humedad y pendiente ----
  function slopeAt(i, j) {
    const idx = j * N + i;
    const hl = height[j * N + Math.max(0, i - 1)], hr = height[j * N + Math.min(N - 1, i + 1)];
    const hd = height[Math.max(0, j - 1) * N + i], hu = height[Math.min(N - 1, j + 1) * N + i];
    return Math.hypot(hr - hl, hu - hd) / (2 * CELL || 1);   // rise/run (adimensional)
  }
  // ¿hay mar (cota<0) dentro de R celdas? → marca costa (para manglares)
  function seaWithin(i, j, R) {
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= N || y >= N) return true;
      if (height[y * N + x] < 0) return true;
    }
    return false;
  }
  // ====== CLASIFICACIÓN DE RELIEVE (por forma del terreno, no por vegetación) ======
  // Deriva de altura + pendiente + curvatura + cercanía al mar. Consultable con terrainClassAt(x,z)
  // para colocar fauna/assets por geomorfología (p.ej. un ave que solo anida en acantilados).
  const RELIEF_CLASSES = ['río/lago', 'mar', 'orilla', 'playa', 'llano', 'meseta', 'ladera', 'acantilado', 'barranco', 'cima'];
  const RELIEF_COLORS = [
    [60, 140, 200],   // 0 río/lago
    [30, 70, 120],    // 1 mar
    [225, 205, 150],  // 2 orilla
    [240, 225, 170],  // 3 playa
    [150, 200, 110],  // 4 llano
    [120, 170, 90],   // 5 meseta
    [185, 160, 90],   // 6 ladera
    [205, 85, 65],    // 7 acantilado (pared escarpada)
    [150, 60, 145],   // 8 barranco (quebrada/cárcava cóncava)
    [245, 245, 255],  // 9 cima
  ];
  function classifyRelief(i, j) {
    const idx = j * N + i, h = height[idx];
    if (waterMask && waterMask[idx]) return 0;     // cauce de río o lago
    if (h < 0) return 1;                           // mar
    const slope = slopeAt(i, j);
    const hl = height[j * N + Math.max(0, i - 1)], hr = height[j * N + Math.min(N - 1, i + 1)];
    const hd = height[Math.max(0, j - 1) * N + i], hu = height[Math.min(N - 1, j + 1) * N + i];
    const curv = ((hl + hr + hu + hd) / 4 - h) / (CELL || 1);   // >0 cóncavo (valle/quebrada) · <0 convexo (cresta)
    const coast = seaWithin(i, j, 2), e = h / LAND_MAX;
    if (h < BEACH_TOP * 0.5 && coast) return 2;    // orilla (línea de costa)
    if (h < BEACH_TOP * 1.3 && slope < 0.5) return 3;            // playa
    if (slope > 1.0) return curv > 0.18 ? 8 : 7;   // pared escarpada: cóncava=barranco · si no=acantilado
    if (slope > 0.45) return 6;                    // ladera
    if (e > 0.62 && curv < -0.12) return 9;        // cima/cresta convexa alta
    if (e > 0.32) return 5;                         // meseta / tierra media plana
    return 4;                                       // llano bajo
  }
  function computeRelief() {
    if (!relief) return;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) relief[j * N + i] = classifyRelief(i, j);
  }
  // API: clase de relieve en coords de mundo (string), p.ej. 'acantilado'
  function terrainClassAt(wx, wz) {
    const c = worldToIndex(wx, wz);
    if (!relief || c.i < 0 || c.j < 0 || c.i >= N || c.j >= N) return 'mar';
    return RELIEF_CLASSES[relief[c.j * N + c.i]];
  }
  // API: hasta n posiciones {x,z,y} de una clase de relieve (para sembrar fauna por geomorfología)
  function findReliefSpots(className, n = 1) {
    const want = RELIEF_CLASSES.indexOf(className);
    const out = [];
    if (want < 0 || !relief) return out;
    const total = N * N, start = (Math.random() * total) | 0;   // recorrido desde un offset aleatorio
    for (let s = 0; s < total && out.length < n; s++) {
      const idx = (start + s * 9973) % total;                   // salto coprimo → muestreo disperso
      if (relief[idx] !== want) continue;
      const i = idx % N, j = (idx / N) | 0, w = vertWorld(i, j);
      out.push({ x: w.x, z: w.z, y: height[idx] });
    }
    return out;
  }

  function autoBiome() {
    const moff = rng() * 100, mfreq = 2.2 + rng() * 1.6;   // humedad: parches grandes
    // gradiente de humedad: un lado de la isla seco (desierto) y otro húmedo (selva)
    const mAng = rng() * Math.PI * 2, mgx = Math.cos(mAng), mgy = Math.sin(mAng);
    // gradiente de TEMPERATURA (otra dirección): zonas cálidas vs frías + enfriamiento por altura
    const tAng = rng() * Math.PI * 2, tgx = Math.cos(tAng), tgy = Math.sin(tAng);
    const tfreq = 1.6 + rng() * 1.2, toff = rng() * 100;
    const idxOf = (k) => biomeKeys.indexOf(k) + 1;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const idx = j * N + i, h = height[idx];
      if (h < 0 || (waterMask && waterMask[idx])) { biomes[idx] = 0; continue; }
      const e = h / LAND_MAX;                         // elevación normalizada 0..1
      const slope = slopeAt(i, j);
      const u = i / SEG, v = j / SEG;
      const grad = 0.62 + ((u - 0.5) * mgx + (v - 0.5) * mgy) * 0.85;        // seco ↔ húmedo (base húmeda: menos desierto)
      // humedad RIBEREÑA: cerca de lagos/ríos/mar la tierra es húmeda → orillas frondosas (no desierto
      // pegado al agua). wetField alto junto al agua → empuja el bioma a bosque/selva/pradera.
      const wetb = wetField ? wetField[idx] : 0;
      const m = Math.max(0, Math.min(1, grad * 0.7 + fbm(u * mfreq + moff, v * mfreq + moff + 3.7) * 0.55 + wetb * 0.6));
      const warm = 0.5 + ((u - 0.5) * tgx + (v - 0.5) * tgy) * 1.0;          // cálido ↔ frío a lo ancho
      // temperatura: gradiente + ruido, enfriando con la altura → cumbres y un flanco frío
      const temp = Math.max(0, Math.min(1, warm * 0.6 + fbm(u * tfreq + toff, v * tfreq + toff + 9.1) * 0.4 - e * 0.55));
      let b;
      if (slope > 1.1) b = 'roca';                    // acantilado / pared escarpada (a cualquier altura)
      else if (h < BEACH_TOP * 1.05) b = 'playa';     // franja de arena junto al mar (más angosta)
      else if (e > 0.72) b = 'nieve';                 // cumbre nevada
      else if (e > 0.55) b = temp < 0.32 ? 'nieve' : 'roca';   // alta montaña: nieve si fría, si no roca alpina
      // MANGLAR: tierra muy baja, llana, húmeda y pegada al mar → bosque costero anegado
      else if (h < LAND_MAX * 0.07 && slope < 0.35 && m > 0.5 && seaWithin(i, j, 3)) b = 'pantano';
      else if (temp < 0.32) {                         // FRÍO: coníferas / tundra
        b = (e > 0.42 && m > 0.4) ? 'taiga' : 'tundra';
      } else if (temp < 0.62) {                        // TEMPLADO
        if (m > 0.55) b = 'bosque';
        else if (m > 0.38) b = 'pradera';
        else b = 'matorral';
      } else {                                         // CÁLIDO
        if (m > 0.6) b = 'selva';
        else if (m > 0.42) b = 'pradera';
        else if (m > 0.28) b = 'sabana';
        else b = 'desierto';
      }
      // INFLUENCIA DEL AGUA DULCE: cerca de RÍOS → selva (galería); cerca de LAGOS → bosque frondoso.
      // Solo sobre tierra plantable (no roca/nieve/playa/manglar/cumbre).
      if (b !== 'roca' && b !== 'nieve' && b !== 'playa' && b !== 'pantano' && e <= 0.55 && slope < 1.0) {
        const rv = riverField ? riverField[idx] : 0, lk = lakeField ? lakeField[idx] : 0;
        if (rv > 0.5 && rv >= lk && temp > 0.42) b = 'selva';        // ribera fluvial cálida → selva
        else if (lk > 0.5 && temp >= 0.3) b = 'bosque';              // entorno de lago → bosque
      }
      biomes[idx] = idxOf(b);
    }
  }
  function flat() { clearWater(); height.fill(SEA_FLOOR); biomes.fill(0); refresh(); clearFoam(); }   // vacía a océano

  // ===== EROSIÓN HIDRÁULICA (gotas) — talla valles/cárcavas y deposita sedimento =====
  function heightGrad(px, py) {
    const x = Math.floor(px), y = Math.floor(py), fx = px - x, fy = py - y, i = y * N + x;
    const a = height[i], b = height[i + 1], c = height[i + N], d = height[i + N + 1];
    const gx = (b - a) * (1 - fy) + (d - c) * fy;
    const gy = (c - a) * (1 - fx) + (d - b) * fx;
    const h = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    return { h, gx, gy };
  }
  function erode(strength) {
    const er = 2, brush = []; let wsum = 0;
    for (let dy = -er; dy <= er; dy++) for (let dx = -er; dx <= er; dx++) {
      const d = Math.hypot(dx, dy); if (d <= er) { const w = 1 - d / er; brush.push([dx, dy, w]); wsum += w; }
    }
    for (const b of brush) b[2] /= wsum;
    const drops = Math.floor(N * N * 0.6 * strength);
    const inertia = 0.05, capF = 5, minSlope = 0.01, erRate = 0.35, depRate = 0.3, evap = 0.02, grav = 6;
    const maxLife = Math.min(70, N);
    for (let n = 0; n < drops; n++) {
      let px = 1 + rng() * (N - 3), py = 1 + rng() * (N - 3);
      let dx = 0, dy = 0, vel = 1, water = 1, sed = 0;
      for (let life = 0; life < maxLife; life++) {
        const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
        const o = heightGrad(px, py);
        dx = dx * inertia - o.gx * (1 - inertia);
        dy = dy * inertia - o.gy * (1 - inertia);
        const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
        px += dx; py += dy;
        if (px < 1 || px >= N - 2 || py < 1 || py >= N - 2) break;
        const dh = heightGrad(px, py).h - o.h;
        const cap = Math.max(-dh, minSlope) * vel * water * capF;
        if (sed > cap || dh > 0) {
          const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depRate;
          sed -= dep; const i = y0 * N + x0;
          height[i] += dep * (1 - fx) * (1 - fy); height[i + 1] += dep * fx * (1 - fy);
          height[i + N] += dep * (1 - fx) * fy; height[i + N + 1] += dep * fx * fy;
        } else {
          const ero = Math.min((cap - sed) * erRate, -dh);
          for (const [bx, by, bw] of brush) {
            const ii = (y0 + by) * N + (x0 + bx);
            if (ii >= 0 && ii < N * N) height[ii] -= ero * bw;
          }
          sed += ero;
        }
        vel = Math.sqrt(Math.max(0, vel * vel - dh * grav));
        water *= (1 - evap);
        if (water < 0.01) break;
      }
    }
  }

  // ===== RÍOS / LAGOS / CASCADAS =====
  function clearWater() {
    while (waterGroup.children.length) { const c = waterGroup.children.pop(); c.geometry?.dispose(); }
    lakeWaters.length = 0;
    if (waterMask) waterMask.fill(0);
    if (lakeMask) lakeMask.fill(0);
  }
  function blurField(src, passes) {
    let a = src.slice();
    for (let p = 0; p < passes; p++) {
      const b = new Float32Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          s += a[ny * N + nx]; c++;
        }
        b[y * N + x] = s / c;
      }
      a = b;
    }
    return a;
  }
  // campo de "humedad": fuerte sobre los LAGOS (agua dulce → más vida), medio en ríos y mar; decae con
  // la distancia. Al sembrar los lagos más alto, su influencia llega MÁS LEJOS que la de los ríos.
  // difunde un campo 0..1 desde sus semillas (decae con la distancia) → zonas de influencia
  function spreadField(seed, passes) {
    const f = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) f[k] = seed(k);
    const decay = 0.9;
    for (let p = 0; p < passes; p++) {
      const b = f.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const idx = y * N + x;
        let m = f[idx];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const v = f[ny * N + nx] * decay;
          if (v > m) m = v;
        }
        b[idx] = m;
      }
      f.set(b);
    }
    return f;
  }
  function computeWetField() {
    // humedad general (vegetación) + influencia separada de LAGOS y de RÍOS (para sesgar el bioma)
    wetField = spreadField((k) => lakeMask[k] ? 1.0 : waterMask[k] ? 0.72 : (height[k] < 0 ? 0.55 : 0), 26);
    lakeField = spreadField((k) => lakeMask[k] ? 1.0 : 0, 22);                       // cerca de lagos → bosque
    riverField = spreadField((k) => (waterMask[k] && !lakeMask[k]) ? 1.0 : 0, 22);   // cerca de ríos → selva
  }
  // mezcla el relieve con una versión difuminada (amount 0..1) → suaviza picos sin aplanar los macizos
  function smoothHeights(amount) {
    const b = blurField(height, 1);
    for (let k = 0; k < N * N; k++) height[k] = height[k] * (1 - amount) + b[k] * amount;
  }
  // suaviza SOLO un recuadro de la malla (para limar escalones de una cuenca de lago recién tallada)
  function smoothRegion(ci, cj, R, passes) {
    for (let p = 0; p < passes; p++) {
      const upd = [];
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 1 || j < 1 || i >= N - 1 || j >= N - 1) continue;
        const idx = j * N + i;
        upd.push([idx, height[idx] * 0.4 + (height[idx - 1] + height[idx + 1] + height[idx - N] + height[idx + N]) * 0.15]);
      }
      for (const [idx, v] of upd) height[idx] = v;
    }
  }
  function carveDisc(ci, cj, rCells, fn) {
    for (let dj = -rCells; dj <= rCells; dj++) for (let di = -rCells; di <= rCells; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const d = Math.hypot(di, dj); if (d > rCells) continue;
      fn(j * N + i, 1 - d / rCells);
    }
  }
  // como carveDisc pero el radio VARÍA con el ángulo → contorno irregular/orgánico en vez de círculo.
  // Usa RUIDO 2D muestreado a lo largo del círculo (periódico, así cierra sin costura) en lugar de
  // senos puros: el ruido no tiene simetría de n-lóbulos, por eso NO sale forma de "trébol".
  function carveBlob(ci, cj, rCells, shape, fn) {
    const rMax = Math.ceil(rCells * (1 + shape.a + shape.a2) + 1);
    for (let dj = -rMax; dj <= rMax; dj++) for (let di = -rMax; di <= rMax; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const d = Math.hypot(di, dj);
      const ang = Math.atan2(dj, di);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const warp = (fbm(ca * shape.nf + shape.noff, sa * shape.nf + shape.noff + 3.1) - 0.5) * 2;
      const rDir = rCells * (1 + shape.a * warp + shape.a2 * Math.sin(ang * shape.k2 + shape.p2));
      if (d > rDir) continue;
      fn(j * N + i, 1 - d / rDir);
    }
  }
  function generateWaterFeatures() {
    clearWater();
    lakeInfo = []; riverPts = [];        // se repueblan abajo → fauna acuática
    const flow = blurField(height, 5);   // ruteo suave → ríos siguen valles sin cortarse

    // ---- LAGOS: excava una cuenca y pone una superficie de agua ----
    // Reúne celdas candidatas (interior, banda baja-media, lejos del mar) y las ORDENA por llanura.
    // Así garantizamos al menos 1 lago aunque la isla sea empinada (usa la más llana disponible),
    // en vez del muestreo aleatorio anterior que podía fallar las 400 veces.
    const lakeCands = [];
    for (let j = 8; j < N - 8; j += 2) for (let i = 8; i < N - 8; i += 2) {
      const h = height[j * N + i];
      if (h <= 1 || h >= LAND_MAX * 0.35) continue;
      if (Math.hypot(i / SEG - 0.5, j / SEG - 0.5) < 0.22) continue;   // fuera de la montaña central
      if (seaWithin(i, j, 12)) continue;                                // bien adentro: no choca con el acantilado costero
      lakeCands.push({ idx: j * N + i, i, j, s: slopeAt(i, j) });
    }
    lakeCands.sort((a, b) => a.s - b.s);                                // más llanas primero
    const wantLakes = lakeCands.length ? Math.max(1, params.lakes | 0) : 0;
    const lakeCtrs = [];                                                // centros ya usados → separación
    const minSep = Math.max(8, N * 0.07);
    for (let p = 0; p < lakeCands.length && lakeCtrs.length < wantLakes; p++) {
      const cand = lakeCands[p];
      let far = true;
      for (const q of lakeCtrs) { if (Math.hypot(cand.i - q.i, cand.j - q.j) < minSep) { far = false; break; } }
      if (!far) continue;
      lakeCtrs.push(cand);
      const bi = cand.idx;
      const ci = bi % N, cj = (bi / N) | 0;
      // tamaño y profundidad variables → cada lago distinto (no clones)
      const level = height[bi] + 1.0 + rng() * 2.0;
      const depth = 2.5 + rng() * 3.5;                      // SOMERO → agua clara, no pozo oscuro
      const rWorld = SIZE * (0.020 + rng() * 0.050);
      const rCells = Math.max(2, Math.ceil(rWorld / CELL));
      // forma orgánica única: ruido angular (sin simetría → no "trébol") + detalle fino de baja amplitud
      const shape = {
        nf: 2.0 + rng() * 2.0, noff: rng() * 10,
        a: 0.14 + rng() * 0.12,
        k2: 5 + (rng() * 4 | 0), a2: 0.04 + rng() * 0.05, p2: rng() * 6.283,
      };
      // cuenco SOMERO con bajío junto a la orilla: perfil smoothstep (plano cerca del borde, hondo al
      // centro) + ruido de baja frecuencia que rompe los anillos concéntricos → orillas naturales
      carveBlob(ci, cj, rCells, shape, (idx, t) => {
        const i = idx % N, j = (idx / N) | 0;
        const u = 1 - t;                                    // 0 centro .. 1 borde
        const bowl = 1 - u * u * (3 - 2 * u);               // 1 centro → 0 orilla, somero en la orilla
        const noise = (fbm(i * 0.06, j * 0.06) - 0.5) * 1.2;
        const target = level - 0.3 - bowl * depth + noise;
        if (height[idx] > target) height[idx] = target;
      });
      // suaviza la cuenca PRIMERO → quita escalones residuales del tallado
      smoothRegion(ci, cj, Math.ceil(rCells * 1.3), 2);
      // BANCO DE ORILLA inclinado AL FINAL (no muro plano): sube suave del agua hacia afuera con un
      // perfil smoothstep → orilla natural y a la vez sella el flood-fill (cruza el nivel justo afuera
      // de la orilla y se mantiene por encima → el agua no se escapa)
      carveBlob(ci, cj, rCells * 1.4, shape, (idx, t) => {
        const i = idx % N, j = (idx / N) | 0;
        const q = 1 - t;                                    // 0 centro .. 1 borde
        if (q < 0.62) return;                               // bajo el agua: no tocar
        const u = (q - 0.62) / 0.38;                        // 0 orilla .. 1 borde exterior
        // ruido escalado por u → orilla irregular (sin terrazas de anillos); poco ruido junto al agua
        const noise = (fbm(i * 0.06, j * 0.06) - 0.5) * 2.2 * u;
        const bank = level - 0.3 + (depth * 0.4 + 1.4) * (u * u * (3 - 2 * u)) + noise;
        if (height[idx] < bank) height[idx] = bank;         // solo levanta → no aplana terreno alto
      });
      buildLake(bi, level);
      { const w = vertWorld(ci, cj); lakeInfo.push({ x: w.x, z: w.z, level, r: rWorld }); }
    }

    // ---- RÍOS: nacen en MANANTIALES de ladera EMPINADA y alta (NO en la cima nevada) → arrancan como cascada ----
    const srcLo = LAND_MAX * 0.5, srcHi = LAND_MAX * 0.85;
    let highs = [];        // celdas en banda alta CON pendiente fuerte (nacimiento en cascada)
    const anyBand = [];    // respaldo: cualquier celda en la banda, por si no hay laderas empinadas
    for (let idx = 0; idx < N * N; idx++) {
      const h = height[idx]; if (h <= srcLo || h >= srcHi) continue;
      const i = idx % N, j = (idx / N) | 0;
      if (i < 2 || j < 2 || i >= N - 2 || j >= N - 2) continue;
      anyBand.push(idx);
      const sx = height[j * N + i + 1] - height[j * N + i - 1];
      const sz = height[(j + 1) * N + i] - height[(j - 1) * N + i];
      if (Math.hypot(sx, sz) > CELL * 0.7) highs.push(idx);   // ladera empinada → caída inicial
    }
    if (!highs.length) highs = anyBand;
    const wCells = 1;                       // canal ESTRECHO (1 celda) → ríos finos
    const halfW = Math.max(1.6, CELL * 0.6); // semiancho de la cinta de agua (m): fino
    // traza un río por descenso máximo desde startIdx, talla el canal y construye cinta+cascadas.
    // Devuelve el eje (centerline) o null. Para al llegar al mar o al chocar con OTRA agua (lago u
    // otro río ya tallado) → así un afluente que baja hacia el cauce principal se une a él.
    const buildRiverFrom = (startIdx) => {
      let idx = startIdx;
      const path = [], seen = new Set();
      let guard = 0;
      while (guard++ < N * 3) {
        if (seen.has(idx)) break; seen.add(idx);
        const i = idx % N, j = (idx / N) | 0, w = vertWorld(i, j);
        path.push({ i, j, x: w.x, z: w.z, y: height[idx] });
        if (height[idx] <= 0.4) break;                   // llegó al mar
        if (waterMask[idx] && path.length > 2) break;     // cayó en un lago u otro río → se une
        let best = -1, bestH = flow[idx];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = i + dx, y = j + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const ni = y * N + x; if (flow[ni] < bestH) { bestH = flow[ni]; best = ni; }
        }
        if (best < 0) break;                              // pozo (mínimo local)
        idx = best;
      }
      if (path.length < 3) return null;
      const cl = riverCenterline(path);                   // suavizado + meandros
      for (const p of cl) {                               // talla canal angosto y marca agua
        const c = worldToIndex(p.x, p.z);
        carveDisc(c.i, c.j, wCells, (id2, t) => {
          const target = p.bed - 0.4 - t * 0.5;
          if (height[id2] > target) height[id2] = target;
          waterMask[id2] = 1;
        });
      }
      buildRiverRibbon(cl, halfW);
      buildWaterfalls(cl, halfW);
      // puntos para peces de río: solo tramos BAJOS (no montaña), muestreados con separación
      const riverLo = LAND_MAX * 0.22;
      for (let n = 2; n < cl.length - 1; n += 4) {
        if (cl[n].bed < riverLo && cl[n].bed > 0.5) riverPts.push({ x: cl[n].x, z: cl[n].z, y: cl[n].bed });
      }
      return cl;
    };
    // ríos principales
    const mainCls = [];
    for (let k = 0; k < (params.rivers | 0) && highs.length; k++) {
      const cl = buildRiverFrom(highs[(rng() * highs.length) | 0]);
      if (cl) mainCls.push(cl);
    }
    // AFLUENTES: nacen ladera arriba junto al cauce principal y bajan hasta unirse (forma de Y).
    // Probamos en VARIOS puntos del cauce; el manantial = celda más alta del entorno (basta con que
    // esté por encima del río → el descenso por el flujo lo devuelve al valle = al río principal).
    for (const cl of mainCls) {
      if (cl.length < 8) continue;
      const want = 2 + (rng() * 2 | 0);                 // 2-3 intentos de afluente por río
      let made = 0;
      for (let s = 0; s < want * 3 && made < want; s++) {
        const p = cl[((0.12 + rng() * 0.6) * (cl.length - 1)) | 0];   // tramo alto-medio
        const c = worldToIndex(p.x, p.z);
        if (c.i < 2 || c.j < 2 || c.i >= N - 2 || c.j >= N - 2) continue;
        const hRiver = height[c.j * N + c.i];
        let bi = -1, bh = hRiver + 0.5;                  // solo necesita ser MÁS ALTO que el río
        const R = 8 + (rng() * 12 | 0);
        for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
          const ii = c.i + di, jj = c.j + dj;
          if (ii < 2 || jj < 2 || ii >= N - 2 || jj >= N - 2) continue;
          const hh = height[jj * N + ii];
          if (hh > bh && !waterMask[jj * N + ii]) { bh = hh; bi = jj * N + ii; }
        }
        if (bi >= 0 && buildRiverFrom(bi)) made++;
      }
    }
  }
  // Construye el eje del río: lecho monotónico + suavizado + meandros sinusoidales
  // (perpendiculares al cauce, creciendo hacia la desembocadura como un río real).
  function riverCenterline(path) {
    let bed = path[0].y;
    const pts = path.map((p) => { bed = Math.min(bed, p.y); return { x: p.x, z: p.z, bed }; });
    for (let pass = 0; pass < 3; pass++)
      for (let n = 1; n < pts.length - 1; n++) {
        pts[n].x = (pts[n - 1].x + pts[n].x * 2 + pts[n + 1].x) / 4;
        pts[n].z = (pts[n - 1].z + pts[n].z * 2 + pts[n + 1].z) / 4;
      }
    const amp = CELL * (1.6 + rng() * 1.4);          // amplitud del meandro (m)
    const wav = SIZE * (0.035 + rng() * 0.035);      // longitud de onda (m)
    const ph = rng() * Math.PI * 2;
    const len = pts.length;
    let cum = 0;
    const out = pts.map((p) => ({ x: p.x, z: p.z, bed: p.bed }));
    for (let n = 0; n < len; n++) {
      if (n > 0) cum += Math.hypot(pts[n].x - pts[n - 1].x, pts[n].z - pts[n - 1].z);
      const a = pts[Math.max(0, n - 1)], b = pts[Math.min(len - 1, n + 1)];
      let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const grow = n / (len - 1 || 1);               // más sinuoso aguas abajo
      const off = Math.sin((cum / wav) * Math.PI * 2 + ph) * amp * grow;
      out[n].x = pts[n].x + (-dz) * off;
      out[n].z = pts[n].z + (dx) * off;
    }
    return out;
  }
  // Inunda la cuenca: flood-fill de celdas bajo `level` desde la semilla y construye
  // la superficie del agua SOLO sobre esas celdas → contorno orgánico que sigue al terreno.
  function buildLake(seedIdx, level) {
    const stack = [seedIdx], filled = [], seen = new Set();
    const MAXC = Math.min(20000, N * N * 0.2);
    while (stack.length) {
      const idx = stack.pop();
      if (seen.has(idx)) continue; seen.add(idx);
      const i = idx % N, j = (idx / N) | 0;
      if (i <= 0 || j <= 0 || i >= N - 1 || j >= N - 1) return; // tocó el borde → no es cuenca cerrada
      if (height[idx] >= level) continue;                       // fuera del agua
      filled.push(idx);
      if (filled.length > MAXC) break;
      stack.push(idx + 1, idx - 1, idx + N, idx - N);
    }
    if (filled.length < 6) return;
    const verts = [], idxs = []; let vi = 0;
    for (const idx of filled) {
      const i = idx % N, j = (idx / N) | 0;
      waterMask[idx] = 1;
      lakeMask[idx] = 1;                  // marca agua dulce de lago → humedad fuerte alrededor
      const x0 = (i / SEG - 0.5) * SIZE, z0 = (j / SEG - 0.5) * SIZE;
      const x1 = ((i + 1) / SEG - 0.5) * SIZE, z1 = ((j + 1) / SEG - 0.5) * SIZE;
      // se teje en el plano LOCAL XY (mirando a +Z); luego se rota -90°X → +Y. El Reflector
      // de Water asume normal local +Z, así refleja el CIELO (antes lo hacía de lado → "pintura").
      verts.push(x0, -z0, 0, x1, -z0, 0, x1, -z1, 0, x0, -z1, 0);
      idxs.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3); vi += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idxs); g.computeVertexNormals();
    // agua REFLECTANTE real (misma clase que el mar)
    const lake = new Water(g, {
      textureWidth: 512, textureHeight: 512, waterNormals: lakeNormals,
      sunDirection: sun.clone().normalize(), sunColor: 0xffffff,
      waterColor: 0x1f6b86, distortionScale: 2.5, fog: false,
    });
    lake.material.uniforms.size.value = 6;        // olas densas a escala de lago (si no, se ve plano)
    lake.material.side = THREE.DoubleSide;
    lake.rotation.x = -Math.PI / 2; lake.position.y = level;
    waterGroup.add(lake); lakeWaters.push(lake);
  }
  function buildRiverRibbon(cl, halfW) {
    // cl ya viene suavizado y con meandros (riverCenterline): aquí solo se teje la cinta
    const verts = [], uvs = [], idxs = [];
    const tile = Math.max(4, halfW * 2);   // longitud (m) de cada repetición del normal map
    const len = cl.length;
    let cum = 0;
    for (let n = 0; n < len; n++) {
      const p = cl[n], a = cl[Math.max(0, n - 1)], b = cl[Math.min(len - 1, n + 1)];
      let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      if (n > 0) { const pr = cl[n - 1]; cum += Math.hypot(p.x - pr.x, p.z - pr.z); }
      const frac = n / (len - 1 || 1);
      const wHere = halfW * (0.18 + 0.82 * Math.pow(frac, 0.6));   // nace MUY fino y se ensancha aguas abajo
      // sigue la altura REAL del cauce ya tallado (no el `bed` abstracto) → nunca flota ni se entierra
      const px = -dz, pz = dx, wy = heightBilinear(p.x, p.z) + 0.25, vv = cum / tile;
      verts.push(p.x + px * wHere, wy, p.z + pz * wHere, p.x - px * wHere, wy, p.z - pz * wHere);
      uvs.push(0, vv, 1, vv);                // U a lo ancho, V río abajo
    }
    for (let n = 0; n < len - 1; n++) { const a = n * 2; idxs.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idxs); g.computeVertexNormals();
    waterGroup.add(new THREE.Mesh(g, riverMat));
  }
  function buildWaterfalls(path, halfW) {
    // En vez de apilar un plano vertical por segmento (parecían cajas/escalones), detectamos
    // TRAMOS empinados consecutivos y tejemos UNA sola lámina de espuma continua que drapea la
    // ladera siguiendo el cauce → cascada/rápido (whitewater) en lugar de bloques sueltos.
    const len = path.length;
    const steep = (n) => {
      if (n >= len - 1) return false;
      const a = path[n], b = path[n + 1];
      const drop = a.bed - b.bed, horiz = Math.hypot(b.x - a.x, b.z - a.z);
      const headBoost = n < 4 ? 0.6 : 1;      // favorece el nacimiento → arranca en cascada
      return drop > Math.max(1.0, horiz * 0.55) * headBoost;
    };
    let n = 0;
    while (n < len - 1) {
      if (!steep(n)) { n++; continue; }
      let e = n;
      while (e + 1 < len - 1 && steep(e + 1)) e++;     // run [n .. e] de segmentos empinados
      buildFoamStrip(path, n, e + 1, halfW);           // hasta el vértice e+1 inclusive
      n = e + 1;
    }
  }
  // Lámina de espuma sobre el tramo [i0..i1] del cauce: sigue el lecho (drapea la pendiente),
  // un poco más ancha que el río y elevada para no pelear en z con la cinta azul.
  function buildFoamStrip(cl, i0, i1, halfW) {
    if (i1 - i0 < 1) return;
    const verts = [], uvs = [], idxs = [];
    const len = cl.length;
    let cum = 0;
    for (let n = i0; n <= i1; n++) {
      const p = cl[n], a = cl[Math.max(i0, n - 1)], b = cl[Math.min(i1, n + 1)];
      let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      if (n > i0) { const pr = cl[n - 1]; cum += Math.hypot(p.x - pr.x, p.z - pr.z); }
      // misma anchura que el río en ese punto (un pelín menos) → espuma DENTRO del cauce, no banda gorda
      const fw = halfW * (0.18 + 0.82 * Math.pow(n / (len - 1 || 1), 0.6)) * 0.85;
      const px = -dz, pz = dx, wy = heightBilinear(p.x, p.z) + 0.4;
      verts.push(p.x + px * fw, wy, p.z + pz * fw, p.x - px * fw, wy, p.z - pz * fw);
      uvs.push(0, cum, 1, cum);
    }
    for (let k = 0; k < i1 - i0; k++) { const a = k * 2; idxs.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idxs); g.computeVertexNormals();
    waterGroup.add(new THREE.Mesh(g, fallMat));
  }

  // ---- (re)construye la malla para el tamaño actual ----
  function buildTerrainMesh(seed) {
    if (mesh) { scene.remove(mesh); geo.dispose(); mesh.material.dispose(); }
    clearPropGrid();
    geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    height = new Float32Array(N * N);
    biomes = new Uint8Array(N * N);
    waterMask = new Uint8Array(N * N);
    relief = new Uint8Array(N * N);
    zones = new Uint8Array(N * N);
    lakeMask = new Uint8Array(N * N);
    colors = new Float32Array(N * N * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    posAttr = geo.attributes.position;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, wireframe: params.wireframe });
    mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    generateRandom(seed);
  }

  // ---- escultura ----
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovering = false, sculpting = false, flattenTarget = 0, normalsDirty = false;
  const hit = new THREE.Vector3();
  function castToTerrain(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const inter = ray.intersectObject(mesh, false);
    if (inter.length) { hit.copy(inter[0].point); return true; }
    return false;
  }
  function stroke() {
    const rad = params.brushSize, rad2 = rad * rad;
    const cells = Math.ceil(rad / CELL) + 1;
    const ctr = worldToIndex(hit.x, hit.z);
    const dir = params.mode === 'Bajar' ? -1 : 1;
    for (let dj = -cells; dj <= cells; dj++) for (let di = -cells; di <= cells; di++) {
      const i = ctr.i + di, j = ctr.j + dj;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const w = vertWorld(i, j);
      const d2 = (w.x - hit.x) ** 2 + (w.z - hit.z) ** 2;
      if (d2 > rad2) continue;
      const t = 1 - Math.sqrt(d2) / rad;
      const fall = t * t * (3 - 2 * t);
      const idx = j * N + i;
      if (params.mode === 'Subir' || params.mode === 'Bajar') {
        height[idx] += dir * params.strength * STRENGTH_SCALE * fall;
      } else if (params.mode === 'Aplanar') {
        height[idx] += (flattenTarget - height[idx]) * Math.min(1, params.strength * fall);
      } else {
        const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1);
        const j0 = Math.max(0, j - 1), j1 = Math.min(N - 1, j + 1);
        const avg = (height[j * N + i0] + height[j * N + i1] + height[j0 * N + i] + height[j1 * N + i]) / 4;
        height[idx] += (avg - height[idx]) * Math.min(1, params.strength * fall);
      }
      posAttr.setZ(idx, height[idx]);     // solo los vértices del pincel
      colorVert(idx);
    }
    posAttr.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    normalsDirty = true;                  // normales se recalculan 1 vez por frame
  }

  // ---- controles ----
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enablePan = true; controls.panSpeed = 1.2; controls.screenSpacePanning = true;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

  // entorno HDRI SOLO como reflejo del agua del río (no scene.environment, para no lavar el terreno)
  const hdr = await new RGBELoader().loadAsync('./assets/env/venice_sunset_1k.hdr');
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  riverMat.envMap = hdr; riverMat.envMapIntensity = 0.9; riverMat.needsUpdate = true;

  // ---- assets LOWPOLY procedurales (geometría fusionada + color por vértice = 1 draw-call por tipo) ----
  // Reemplazan a los GLB (que eran ~3k tris/árbol): ahora ~40-120 tris cada uno → muchísimo más
  // barato, así podemos sembrarlos MÁS DENSOS. flatShading da el aspecto facetado lowpoly.
  const plantMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
  // nieve en la vegetación: blanquea (en world-space) cualquier planta por encima de la línea de nieve en invierno.
  // Funciona también con InstancedMesh (no hace falta tocar instancia por instancia).
  const snowUniforms = { uSnowY: { value: 1e9 }, uSnowBand: { value: 30 }, uSnowAmt: { value: 0 } };
  // viento: mece el follaje CERCANO (los lejanos quedan quietos por rendimiento y claridad)
  const windUniforms = {
    uWindTime: { value: 0 }, uWindStr: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindCam: { value: new THREE.Vector3() }, uWindNear: { value: 100 }, uWindFar: { value: 300 },
  };
  plantMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, snowUniforms, windUniforms);
    shader.vertexShader = 'varying float vSnowWY;\nuniform float uWindTime;\nuniform float uWindStr;\nuniform vec2 uWindDir;\nuniform vec3 uWindCam;\nuniform float uWindNear;\nuniform float uWindFar;\n' +
      shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n' +
        '#ifdef USE_INSTANCING\n  vec3 _wp0 = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#else\n  vec3 _wp0 = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif\n' +
        '  float _near = 1.0 - smoothstep(uWindNear, uWindFar, length(_wp0.xz - uWindCam.xz));\n' +
        '  float _lever = max(transformed.y, 0.0);\n' +
        '  float _ph = _wp0.x * 0.12 + _wp0.z * 0.12;\n' +
        '  float _sw = sin(uWindTime * 1.3 + _ph) + 0.3 * sin(uWindTime * 3.3 + _ph * 2.0);\n' +
        '  float _amp = uWindStr * _lever * _near;\n' +
        '  transformed.x += uWindDir.x * _sw * _amp;\n  transformed.z += uWindDir.y * _sw * _amp;\n' +
        '#ifdef USE_INSTANCING\n  vSnowWY = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).y;\n#else\n  vSnowWY = (modelMatrix * vec4(transformed, 1.0)).y;\n#endif');
    shader.fragmentShader = 'varying float vSnowWY;\nuniform float uSnowY;\nuniform float uSnowBand;\nuniform float uSnowAmt;\n' + shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\n  float _snow = smoothstep(uSnowY, uSnowY + uSnowBand, vSnowWY) * uSnowAmt;\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.95, 0.96, 1.0), _snow);');
  };
  plantMat.customProgramCacheKey = () => 'snowwindveg';
  const C = { bark: [0.40, 0.27, 0.16], palmBark: [0.46, 0.38, 0.22], pine: [0.12, 0.40, 0.20], tree: [0.17, 0.46, 0.24], palm: [0.20, 0.52, 0.26], bush: [0.22, 0.45, 0.20], cactus: [0.26, 0.50, 0.30], rock: [0.46, 0.44, 0.40], tan: [0.56, 0.50, 0.40], grass: [0.30, 0.52, 0.22], grass2: [0.42, 0.60, 0.26],
    fruitLeaf: [0.21, 0.49, 0.25], fruit: [0.78, 0.16, 0.12], fruitO: [0.93, 0.51, 0.10], fruitP: [0.52, 0.18, 0.52],
    blossom: [0.93, 0.62, 0.72], blossom2: [0.98, 0.84, 0.89] };
  const CONE = (r, h, s) => new THREE.ConeGeometry(r, h, s);
  const CYL = (rt, rb, h, s) => new THREE.CylinderGeometry(rt, rb, h, s);
  const ICO = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);
  function paintGeo(g, c) {
    if (g.index) g = g.toNonIndexed();                 // Ico no tiene índice; Cone/Cyl sí → homogeneiza
    if (g.attributes.uv) g.deleteAttribute('uv');      // homogeneiza atributos para poder fusionar
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i*3] = c[0]; col[i*3+1] = c[1]; col[i*3+2] = c[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }
  // parts: { geo, color, pos?, rot?, scale? } → fusiona, centra en XZ y apoya la base en y=0
  function mergeModel(parts) {
    const geos = parts.map((p) => {
      let g = p.geo;
      if (p.scale) g.scale(p.scale[0], p.scale[1], p.scale[2]);
      if (p.rot) { g.rotateX(p.rot[0] || 0); g.rotateZ(p.rot[2] || 0); g.rotateY(p.rot[1] || 0); }
      if (p.pos) g.translate(p.pos[0], p.pos[1], p.pos[2]);
      return paintGeo(g, p.color);
    });
    const m = mergeGeometries(geos, false);
    m.computeBoundingBox();
    const b = m.boundingBox, mx = (b.min.x + b.max.x) / 2, mz = (b.min.z + b.max.z) / 2;
    m.translate(-mx, -b.min.y, -mz);                  // base-centro al origen → aterriza donde se coloca
    m.computeVertexNormals();
    return m;
  }
  // make*(hi): hi=true sube subdivisiones/segmentos y añade piezas → variante de alta calidad (LOD cercano)
  function makePine(hi) {           // pino ~6 m: tronco + conos apilados
    const s = hi ? 9 : 6;
    const parts = [
      { geo: CYL(0.10, 0.18, 1.4, hi ? 8 : 5), color: C.bark, pos: [0, 0.7, 0] },
      { geo: CONE(1.35, 2.4, s), color: C.pine, pos: [0, 2.0, 0] },
      { geo: CONE(1.05, 2.0, s), color: C.pine, pos: [0, 3.3, 0] },
      { geo: CONE(0.70, 1.8, s), color: C.pine, pos: [0, 4.7, 0] },
    ];
    if (hi) parts.push({ geo: CONE(0.42, 1.4, s), color: C.pine, pos: [0, 5.9, 0] });
    return mergeModel(parts);
  }
  function makeTree(hi) {           // árbol ~5 m: tronco + copa de icosaedros
    const d = hi ? 1 : 0;
    const parts = [
      { geo: CYL(0.12, 0.20, 1.8, hi ? 8 : 5), color: C.bark, pos: [0, 0.9, 0] },
      { geo: ICO(1.5, d), color: C.tree, pos: [0, 3.0, 0], scale: [1, 0.95, 1] },
      { geo: ICO(1.0, d), color: C.tree, pos: [0.7, 3.8, 0.3] },
      { geo: ICO(1.0, d), color: C.tree, pos: [-0.6, 3.6, -0.4] },
    ];
    if (hi) parts.push(
      { geo: ICO(0.8, 1), color: C.tree, pos: [0.1, 4.6, -0.5] },
      { geo: ICO(0.7, 1), color: C.tree, pos: [-0.5, 4.2, 0.5] },
    );
    return mergeModel(parts);
  }
  function makePalm(hi) {           // palmera ~6 m: tronco inclinado + corona de hojas (conos planos)
    const nL = hi ? 9 : 6, seg = hi ? 6 : 4;
    const parts = [{ geo: CYL(0.12, 0.18, 5.2, hi ? 8 : 5), color: C.palmBark, pos: [0, 2.6, 0], rot: [0, 0, 0.12] }];
    for (let k = 0; k < nL; k++) {
      const a = (k / nL) * Math.PI * 2;
      parts.push({ geo: CONE(0.42, 2.6, seg), color: C.palm, scale: [1, 1, 0.18],
        rot: [Math.PI * 0.42, a, 0], pos: [0.62 + Math.cos(a) * 1.0, 5.0, Math.sin(a) * 1.0] });
    }
    return mergeModel(parts);
  }
  function makeBush(hi) {           // arbusto ~0.9 m
    const d = hi ? 1 : 0;
    const parts = [
      { geo: ICO(0.5, d), color: C.bush, pos: [0, 0.42, 0], scale: [1.2, 0.85, 1.2] },
      { geo: ICO(0.34, d), color: C.bush, pos: [0.32, 0.5, 0.1] },
    ];
    if (hi) parts.push({ geo: ICO(0.3, 1), color: C.bush, pos: [-0.28, 0.46, -0.12] });
    return mergeModel(parts);
  }
  function makeGrass(hi) {          // mata ancha y baja: cobertura verde a ras de suelo (no pincho)
    const n = hi ? 12 : 8;
    const parts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (k % 2) * 0.4;
      const r = 0.16 + (k % 3) * 0.16;            // radio amplio → cubre suelo, las matas se solapan
      const blade = 0.42 - (k % 3) * 0.08;        // briznas cortas → mata baja, sin agujas
      const tilt = 0.45 + (k % 3) * 0.12;         // bien abiertas hacia fuera
      parts.push({ geo: CONE(0.06, blade, hi ? 4 : 3), color: k % 2 ? C.grass2 : C.grass,
        rot: [tilt * Math.cos(a), a, tilt * Math.sin(a)], pos: [Math.cos(a) * r, blade * 0.32, Math.sin(a) * r] });
    }
    return mergeModel(parts);
  }
  function makeCactus(hi) {         // cactus ~2 m: cuerpo + 2 brazos
    return mergeModel([
      { geo: CYL(0.18, 0.22, 1.7, hi ? 10 : 7), color: C.cactus, pos: [0, 0.85, 0] },
      { geo: CYL(0.09, 0.11, 0.7, hi ? 8 : 6), color: C.cactus, pos: [0.32, 1.0, 0], rot: [0, 0, -0.5] },
      { geo: CYL(0.09, 0.11, 0.6, hi ? 8 : 6), color: C.cactus, pos: [-0.30, 1.2, 0], rot: [0, 0, 0.5] },
    ]);
  }
  function makeRock(hi) {           // rocas ~1 m: bloques facetados bajos
    const d = hi ? 1 : 0;
    return mergeModel([
      { geo: ICO(0.55, d), color: C.rock, pos: [0, 0.28, 0], scale: [1.3, 0.7, 1.1] },
      { geo: ICO(0.32, d), color: C.rock, pos: [0.45, 0.2, 0.2], scale: [1.1, 0.7, 1] },
    ]);
  }
  function makeFormation(hi) {      // formación ~2.6 m: agujas/peñascos facetados
    const d = hi ? 1 : 0;
    return mergeModel([
      { geo: ICO(1.0, d), color: C.tan, pos: [0, 0.9, 0], scale: [0.8, 1.6, 0.8] },
      { geo: ICO(0.7, d), color: C.tan, pos: [0.6, 0.5, 0.1], scale: [0.7, 1.1, 0.7] },
    ]);
  }
  function makeFruitTree(hi, fc) {  // frutal ~4.2 m: copa redonda + frutos del color fc
    const d = hi ? 1 : 0;
    const parts = [
      { geo: CYL(0.11, 0.18, 1.5, hi ? 8 : 5), color: C.bark, pos: [0, 0.75, 0] },
      { geo: ICO(1.30, d), color: C.fruitLeaf, pos: [0, 2.5, 0], scale: [1.05, 0.95, 1.05] },
      { geo: ICO(0.82, d), color: C.fruitLeaf, pos: [0.6, 3.0, 0.25] },
      { geo: ICO(0.78, d), color: C.fruitLeaf, pos: [-0.55, 2.9, -0.35] },
    ];
    const nF = hi ? 12 : 7;                          // frutos repartidos por la superficie de la copa
    for (let k = 0; k < nF; k++) {
      const a = (k / nF) * Math.PI * 2 + k * 1.7;
      const r = 1.0 + (k % 2) * 0.22;
      parts.push({ geo: ICO(0.13, 0), color: fc, pos: [Math.cos(a) * r, 2.35 + (k % 3) * 0.42, Math.sin(a) * r] });
    }
    return mergeModel(parts);
  }
  function makeFlowerTree(hi) {     // floral ~4.5 m: copa en flor (rosa) tipo cerezo
    const d = hi ? 1 : 0;
    const parts = [
      { geo: CYL(0.10, 0.17, 1.6, hi ? 8 : 5), color: C.bark, pos: [0, 0.8, 0] },
      { geo: ICO(1.38, d), color: C.blossom, pos: [0, 2.7, 0], scale: [1.1, 0.82, 1.1] },
      { geo: ICO(0.95, d), color: C.blossom2, pos: [0.65, 3.3, 0.2] },
      { geo: ICO(0.88, d), color: C.blossom, pos: [-0.6, 3.1, -0.35] },
    ];
    if (hi) parts.push(
      { geo: ICO(0.68, 1), color: C.blossom2, pos: [0.1, 3.8, -0.4] },
      { geo: ICO(0.58, 1), color: C.blossom, pos: [-0.4, 3.5, 0.45] },
    );
    return mergeModel(parts);
  }
  function buildPersonAsset() {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: 0x2f7fc4, roughness: 0.55 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.85, 6, 16), m);
    body.position.y = 0.675; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 16), m);
    head.position.y = 1.56; head.castShadow = true;
    g.add(body, head); return g;
  }
  // geometrías lowpoly compartidas (un único material para toda la vegetación)
  // MODELS = LOD medio (lo normal) · MODELS_HI = alta calidad (solo cuando la cámara está muy cerca)
  const MAKERS = { arbol: makeTree, pino: makePine, palmera: makePalm, cactus: makeCactus, arbusto: makeBush, rocas: makeRock, formacion: makeFormation, hierba: makeGrass,
    frutal: (hi) => makeFruitTree(hi, C.fruit), frutal2: (hi) => makeFruitTree(hi, C.fruitO), frutal3: (hi) => makeFruitTree(hi, C.fruitP), floral: makeFlowerTree };
  const FRUTAL_KEYS = ['frutal', 'frutal2', 'frutal3'];   // variedades de fruta (se eligen al azar al sembrar)
  const MODELS = {}, MODELS_HI = {};
  for (const k in MAKERS) { MODELS[k] = MAKERS[k](false); MODELS_HI[k] = MAKERS[k](true); }
  const MODEL_H = {};   // altura (m) de cada modelo según su bounding box → para hundir en pendiente
  for (const k in MODELS) { MODELS[k].computeBoundingBox(); MODEL_H[k] = MODELS[k].boundingBox.max.y; }
  function meshOf(key) { const m = new THREE.Mesh(MODELS[key], plantMat); m.castShadow = true; m.receiveShadow = true; return m; }
  const assetDefs = {
    persona: { label: '🧍 Persona (1.7 m)', make: () => buildPersonAsset() },
    arbol: { label: '🌳 Árbol', make: () => meshOf('arbol') },
    pino: { label: '🌲 Pino', make: () => meshOf('pino') },
    palmera: { label: '🌴 Palmera', make: () => meshOf('palmera') },
    cactus: { label: '🌵 Cactus', make: () => meshOf('cactus') },
    arbusto: { label: '🌿 Arbusto', make: () => meshOf('arbusto') },
    hierba: { label: '🌱 Hierba', make: () => meshOf('hierba') },
    rocas: { label: '🪨 Rocas', make: () => meshOf('rocas') },
    formacion: { label: '⛰️ Formación', make: () => meshOf('formacion') },
    frutal: { label: '🍎 Frutal rojo', make: () => meshOf('frutal') },
    frutal2: { label: '🍊 Frutal naranja', make: () => meshOf('frutal2') },
    frutal3: { label: '🫐 Frutal morado', make: () => meshOf('frutal3') },
    floral: { label: '🌸 Floral', make: () => meshOf('floral') },
    // animales: los mismos modelos de fauna, colocables de forma estática (build* están hoisted)
    ave:     { label: '🐦 Ave',     make: () => { const g = buildBird().g; g.scale.setScalar(0.2); return g; } },   // ~0.5 m
    pez:     { label: '🐟 Pez',     make: () => { const g = buildFish(fishMats[0]); g.scale.setScalar(0.22); return g; } },  // ~0.5 m
    delfin:  { label: '🐬 Delfín',  make: () => buildDolphin().g },
    tiburon: { label: '🦈 Tiburón', make: () => buildShark().g },
    ballena: { label: '🐋 Ballena', make: () => { const o = buildWhale().g; o.scale.setScalar(0.5); return o; } },
  };
  // agrupación de la paleta de assets por tipo (orden y títulos de las secciones de la izquierda)
  const assetGroups = [
    { title: 'Árboles',  keys: ['arbol', 'pino', 'palmera', 'frutal', 'frutal2', 'frutal3', 'floral'] },
    { title: 'Plantas',  keys: ['arbusto', 'hierba', 'cactus'] },
    { title: 'Rocas',    keys: ['rocas', 'formacion'] },
    { title: 'Animales', keys: ['ave', 'pez', 'delfin', 'tiburon', 'ballena'] },
    { title: 'Otros',    keys: ['persona'] },
  ];

  // ---- vegetación INSTANCIADA en GPU con CULLING + LOD ----
  // Cada tipo guarda sus instancias en arrays planos (id lógico = índice, estable para editar/borrar).
  // Cada frame, si la cámara se movió, recomponemos SOLO lo visible:
  //   · frustum culling → no subimos a GPU lo que la cámara no ve
  //   · distancia máx.  → no dibujamos specks lejanos (params.vegDist)
  //   · LOD por distancia → muy cerca = modelo de alta calidad, cerca = medio, lejos = impostor ultra-lowpoly
  const UP = new THREE.Vector3(0, 1, 0);
  const INST_MAX = 120000;                             // capacidad lógica por tipo (sube para densificar mapas grandes)
  const CAP_HI = 8000, CAP_NEAR = 30000, CAP_FAR = 60000;  // capacidad GPU por tier (lo visible en cada banda)
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  // impostor lejano: blob de pocos tris con el color medio del modelo, estirado a su silueta
  function buildImpostor(geo) {
    geo.computeBoundingBox();
    const b = geo.boundingBox, h = b.max.y - b.min.y;
    const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    const col = geo.attributes.color; let cr = 0, cg = 0, cb = 0;
    for (let i = 0; i < col.count; i++) { cr += col.getX(i); cg += col.getY(i); cb += col.getZ(i); }
    cr /= col.count; cg /= col.count; cb /= col.count;
    const rad = Math.max(w * 0.42, h * 0.30);
    const im = new THREE.IcosahedronGeometry(rad, 0);
    im.scale(1, (h * 0.5) / rad, 1);     // estira a la altura del modelo
    im.translate(0, h * 0.5, 0);          // base en y=0
    const g = paintGeo(im, [cr, cg, cb]); // quita uv + color medio
    g.computeVertexNormals();
    return g;
  }
  function makeTier(geo, cap, shadow) {
    const im = new THREE.InstancedMesh(geo, plantMat, cap);
    im.castShadow = shadow; im.receiveShadow = true; im.count = 0; im.frustumCulled = false;
    scene.add(im); return im;
  }
  function buildInstancedGeo(geoNear, geoHi) {
    geoNear.computeBoundingSphere();
    const bs = geoNear.boundingSphere;
    const hi = makeTier(geoHi, CAP_HI, true);                       // muy cerca: alta calidad
    const near = makeTier(geoNear, CAP_NEAR, true);                 // cerca: modelo medio
    const far = makeTier(buildImpostor(geoNear), CAP_FAR, false);   // lejos: impostor lowpoly (sin sombra)
    return {
      hi, near, far, scale: 1, minY: 0, count: 0, free: [],
      bsCenterY: bs.center.y, bsRadius: bs.radius,
      px: new Float32Array(INST_MAX), py: new Float32Array(INST_MAX), pz: new Float32Array(INST_MAX),
      ry: new Float32Array(INST_MAX), sc: new Float32Array(INST_MAX), alive: new Uint8Array(INST_MAX),
    };
  }
  const inst = {};
  for (const k in MODELS) inst[k] = buildInstancedGeo(MODELS[k], MODELS_HI[k]);
  let instDirty = true;   // la vegetación cambió → hay que recomponer el set visible
  function addInstance(key, x, y, z, ry, jit) {
    const t = inst[key]; if (!t) return -1;
    const id = t.free.length ? t.free.pop() : t.count++;
    if (id >= INST_MAX) { t.count = INST_MAX; return -1; }
    const sc = t.scale * jit;
    t.px[id] = x; t.py[id] = y - t.minY * sc; t.pz[id] = z;
    t.ry[id] = ry; t.sc[id] = sc; t.alive[id] = 1;
    instDirty = true;
    return id;
  }
  function removeInstance(key, id) {
    const t = inst[key]; if (!t) return;
    t.alive[id] = 0; t.free.push(id); instDirty = true;
  }
  // ÁRBOLES REALES (madera): árbol/pino/palmera, NO flores ni frutales. Para el leñador de la simulación.
  function realTreeNear(x, z, maxR) {
    let best = null, bestD = (maxR || 1e9) ** 2;
    for (const key of ['arbol', 'pino', 'palmera']) {
      const t = inst[key]; if (!t) continue;
      for (let id = 0; id < t.count; id++) {
        if (!t.alive[id]) continue;
        const dx = t.px[id] - x, dz = t.pz[id] - z, d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = { key, id, x: t.px[id], z: t.pz[id] }; }
      }
    }
    return best;
  }
  function fellTree(ref) { if (ref) removeInstance(ref.key, ref.id); }   // tala: el árbol desaparece
  function resetInstances() {
    for (const k in inst) {
      const t = inst[k];
      t.count = 0; t.free.length = 0; t.alive.fill(0);
      t.hi.count = 0; t.near.count = 0; t.far.count = 0;
    }
    instDirty = true;
  }
  // recompone el conjunto visible (frustum + distancia + LOD); solo sube a GPU lo que se dibuja
  const _frustum = new THREE.Frustum(), _projScreen = new THREE.Matrix4(), _sphere = new THREE.Sphere();
  const _lastCamPos = new THREE.Vector3(NaN, NaN, NaN), _lastCamQuat = new THREE.Quaternion(1, 0, 0, 0);
  function cullInstances() {
    camera.updateMatrixWorld();
    const moved = !(_lastCamPos.distanceToSquared(camera.position) <= 0.04) ||
                  Math.abs(_lastCamQuat.dot(camera.quaternion)) < 0.99999;
    if (!instDirty && !moved) return;          // cámara quieta y sin cambios → no recomputamos ni subimos
    _lastCamPos.copy(camera.position); _lastCamQuat.copy(camera.quaternion); instDirty = false;
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    const far2 = params.vegDist * params.vegDist;
    const hiD = params.vegDist * 0.13, hi2 = hiD * hiD;        // dentro de esto = alta calidad
    const lodD = params.vegDist * 0.42, lod2 = lodD * lodD;    // dentro de esto = modelo medio
    const cpx = camera.position.x, cpz = camera.position.z;
    for (const k in inst) {
      const t = inst[k]; let wh = 0, wn = 0, wf = 0;
      for (let id = 0; id < t.count; id++) {
        if (!t.alive[id]) continue;
        const sc = t.sc[id], x = t.px[id], z = t.pz[id];
        _sphere.center.set(x, t.py[id] + t.bsCenterY * sc, z); _sphere.radius = t.bsRadius * sc;
        if (!_frustum.intersectsSphere(_sphere)) continue;
        const dx = x - cpx, dz = z - cpz, d2 = dx * dx + dz * dz;
        if (d2 > far2) continue;                               // demasiado lejos → no se dibuja
        _q.setFromAxisAngle(UP, t.ry[id]); _p.set(x, t.py[id], z); _s.set(sc, sc, sc);
        _m4.compose(_p, _q, _s);
        // enruta al tier por distancia; si un tier se llena, cae con gracia al siguiente
        if (d2 < hi2 && wh < CAP_HI) t.hi.setMatrixAt(wh++, _m4);
        else if (d2 < lod2 && wn < CAP_NEAR) t.near.setMatrixAt(wn++, _m4);
        else if (wf < CAP_FAR) t.far.setMatrixAt(wf++, _m4);
      }
      t.hi.count = wh; t.near.count = wn; t.far.count = wf;
      t.hi.instanceMatrix.needsUpdate = true; t.near.instanceMatrix.needsUpdate = true; t.far.instanceMatrix.needsUpdate = true;
    }
  }

  let placed = [];
  let placedRecords = [];   // {key,x,y,z,rot} de TODO lo colocado → para guardar/recargar la isla completa
  let selKind = 'nav', selKey = null, paletteEl = null;   // arranca en NAVEGAR (no edita al primer clic)
  const ANIMAL_KEYS = new Set(['ave', 'pez', 'delfin', 'tiburon', 'ballena']);
  function placeAsset(key, x, y, z, rot) {
    const r = (rot == null) ? Math.random() * Math.PI * 2 : rot;
    placedRecords.push({ key, x, y, z, rot: r });
    if (ANIMAL_KEYS.has(key)) { spawnPlacedAnimal(key, x, y, z); return; }   // los animales cobran vida, no se colocan estáticos
    const obj = assetDefs[key].make();
    obj.rotation.y = r;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(x, y - box.min.y, z);
    scene.add(obj); placed.push(obj);
  }
  function clearPlaced() { for (const o of placed) scene.remove(o); placed = []; placedRecords = []; }

  // Reparte aleatoriamente los assets que tenemos sobre la tierra generada.
  function randLand(minH, maxH) {
    for (let t = 0; t < 80; t++) {
      const i = (Math.random() * N) | 0, j = (Math.random() * N) | 0;
      const hh = height[j * N + i];
      if (hh >= minH && hh <= maxH) { const w = vertWorld(i, j); return { x: w.x, y: hh, z: w.z }; }
    }
    return null;
  }
  function scatterAssets() {
    const palms = 6 + (Math.random() * 14 | 0);
    const rocks = 5 + (Math.random() * 12 | 0);
    const forms = 1 + (Math.random() * 3 | 0);
    const people = 1 + (Math.random() * 3 | 0);
    const drop = (key, p) => { if (p) placeAsset(key, p.x, p.y, p.z); };
    for (let k = 0; k < palms; k++) drop('palmera', randLand(0.8, LAND_MAX * 0.35));
    for (let k = 0; k < rocks; k++) drop('rocas', randLand(0.4, LAND_MAX * 0.9));
    for (let k = 0; k < forms; k++) drop('formacion', randLand(LAND_MAX * 0.4, LAND_MAX));
    for (let k = 0; k < people; k++) drop('persona', randLand(0.2, 2.5)); // en la playa
  }
  // bioma en una coordenada de mundo (vecino más cercano)
  function biomeAt(wx, wz) {
    const c = worldToIndex(wx, wz);
    if (c.i < 0 || c.j < 0 || c.i >= N || c.j >= N) return 0;
    return biomes[c.j * N + c.i];
  }
  // Siembra/quita el prop de UNA celda de la rejilla según el bioma que tenga debajo.
  // Reutilizable por el pincel (pintar) y por la siembra global al generar.
  function seedCell(gx, gz) {
    const sp = propSpacing();
    const cx = (gx + 0.5) * sp - SIZE / 2, cz = (gz + 0.5) * sp - SIZE / 2;
    const key = gx + '_' + gz;
    const existing = propGrid.get(key);
    const bid = biomeAt(cx, cz);
    const B = bid > 0 ? BIOMES[biomeKeys[bid - 1]] : null;
    const biomeName = bid > 0 ? biomeKeys[bid - 1] : null;
    // MANGLAR: excepción deliberada → planta pegado al mar (raíces en agua somera), suelo casi a nivel del mar
    const isMangrove = biomeName === 'pantano';
    // suelo de plantación: por encima de la playa para no plantar en la orilla/bajo el agua (salvo manglar)
    const floor = isMangrove ? 0.05 : Math.max(B && B.scatter ? (B.scatter.hMin ?? 0.4) : 0.4, BEACH_TOP);
    const ti = worldToIndex(cx, cz);
    const inGrid = ti.i >= 0 && ti.j >= 0 && ti.i < N && ti.j < N;
    const wet = inGrid && waterMask[ti.j * N + ti.i];
    // mar cerca (≤2 celdas) → no sembrar: evita árboles en lengüetas/escollos que parecen flotar
    let seaNear = !inGrid;
    for (let dj = -2; dj <= 2 && !seaNear; dj++) for (let di = -2; di <= 2; di++) {
      const ii = ti.i + di, jj = ti.j + dj;
      if (ii < 0 || jj < 0 || ii >= N || jj >= N || height[jj * N + ii] < 0) { seaNear = true; break; }
    }
    if (!B || !B.scatter || wet || (seaNear && !isMangrove) || heightAt(cx, cz) < floor) {
      if (existing) { removeInstance(existing.plant, existing.id); propGrid.delete(key); }
      return;
    }
    if (existing) { if (existing.biome === biomeName) return; removeInstance(existing.plant, existing.id); propGrid.delete(key); }
    // más vegetación cerca del agua, menos lejos (manglar/selva ya viven húmedos → casi sin penalización)
    const w = (inGrid && wetField) ? wetField[ti.j * N + ti.i] : 0;
    const wetMul = (isMangrove || biomeName === 'selva') ? (0.9 + 0.4 * w) : (0.55 + 1.25 * w);
    if (rng() < Math.min(1, B.scatter.prob * params.vegDensity * wetMul)) {
      const jx = cx + (rng() - 0.5) * sp * 0.6, jz = cz + (rng() - 0.5) * sp * 0.6;
      const jh = heightBilinear(jx, jz);
      const ji = worldToIndex(jx, jz);
      if (jh < floor || (ji.i >= 0 && ji.j >= 0 && ji.i < N && ji.j < N && waterMask[ji.j * N + ji.i])) return; // nunca en playa/agua/río
      let plant = B.scatter.keys[(rng() * B.scatter.keys.length) | 0];
      // florales = EXCEPCIÓN muy rara: rarísima vez un árbol normal sale en flor
      if (plant === 'arbol' && rng() < 0.012) plant = 'floral';
      // frutales: la key 'frutal' se reparte entre las 3 variedades de fruta (rojo/naranja/morado)
      else if (plant === 'frutal') plant = FRUTAL_KEYS[(rng() * FRUTAL_KEYS.length) | 0];
      const jit = 0.72 + rng() * 0.56;
      // ANTI-FLOTACIÓN en laderas: un prop vertical sobre pendiente despega cuesta abajo.
      // Lo hundimos según la pendiente local (desnivel bajo su huella) sin enterrarlo (≤35% de su alto).
      const sl = (ji.i >= 0 && ji.j >= 0 && ji.i < N && ji.j < N) ? slopeAt(ji.i, ji.j) : 0;
      const objH = (MODEL_H[plant] ?? 2) * jit;
      const sink = Math.min(objH * 0.35, sl * sp * 0.5);
      const newId = addInstance(plant, jx, jh - sink, jz, rng() * Math.PI * 2, jit);
      if (newId >= 0) propGrid.set(key, { plant, id: newId, biome: biomeName });
    }
  }
  // siembra la vegetación de TODOS los biomas por todo el mapa (al generar la isla)
  function scatterVegetationAll() {
    clearPropGrid();
    const sp = propSpacing();
    const gMax = Math.ceil(SIZE / sp);
    for (let gx = 0; gx <= gMax; gx++) for (let gz = 0; gz <= gMax; gz++) seedCell(gx, gz);
  }

  // ---- pintar bioma con el pincel (id = índice+1; id 0 = borrador) ----
  function paintBiome(id) {
    const rad = params.brushSize, rad2 = rad * rad;
    const cells = Math.ceil(rad / CELL) + 1;
    const ctr = worldToIndex(hit.x, hit.z);
    for (let dj = -cells; dj <= cells; dj++) for (let di = -cells; di <= cells; di++) {
      const i = ctr.i + di, j = ctr.j + dj;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const w = vertWorld(i, j);
      if ((w.x - hit.x) ** 2 + (w.z - hit.z) ** 2 > rad2) continue;
      const idx = j * N + i;
      if (height[idx] < 0) continue;          // no pintar bajo el agua
      biomes[idx] = id;
      colorVert(idx);                         // recolorea solo el pincel (fluido)
    }
    geo.attributes.color.needsUpdate = true;
    // al BORRAR (id 0): quita también los assets colocados a mano/sembrados dentro del pincel
    if (id === 0) {
      for (let n = placed.length - 1; n >= 0; n--) {
        const pp = placed[n].position;
        if ((pp.x - hit.x) ** 2 + (pp.z - hit.z) ** 2 <= rad2) { scene.remove(placed[n]); placed.splice(n, 1); }
      }
    }
    // sembrar/quitar props sobre la rejilla regular dentro del pincel (cada celda usa su bioma)
    const sp = propSpacing();
    const gx0 = Math.floor((hit.x - rad + SIZE / 2) / sp), gx1 = Math.floor((hit.x + rad + SIZE / 2) / sp);
    const gz0 = Math.floor((hit.z - rad + SIZE / 2) / sp), gz1 = Math.floor((hit.z + rad + SIZE / 2) / sp);
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const cx = (gx + 0.5) * sp - SIZE / 2, cz = (gz + 0.5) * sp - SIZE / 2;
      if ((cx - hit.x) ** 2 + (cz - hit.z) ** 2 > rad2) continue;
      seedCell(gx, gz);
    }
  }

  // ---- ZONIFICACIÓN: pintar dónde se permite construir (1 residencia · 2 servicios · 0 borrar) ----
  const ZONES_KEY = 'evermark_zones_v1';
  const zoneCounts = [0, 0, 0]; let zonesDirty = true; const _zoneSpots = { 1: [], 2: [] };
  function paintZone(id) {
    const rad = params.brushSize, rad2 = rad * rad, cells = Math.ceil(rad / CELL) + 1, ctr = worldToIndex(hit.x, hit.z);
    for (let dj = -cells; dj <= cells; dj++) for (let di = -cells; di <= cells; di++) {
      const i = ctr.i + di, j = ctr.j + dj;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const w = vertWorld(i, j);
      if ((w.x - hit.x) ** 2 + (w.z - hit.z) ** 2 > rad2) continue;
      const idx = j * N + i; if (height[idx] < 0) continue;
      if (zones[idx] !== id) { zoneCounts[zones[idx]]--; zoneCounts[id]++; zones[idx] = id; colorVert(idx); }
    }
    geo.attributes.color.needsUpdate = true; zonesDirty = true; saveZones();
  }
  function zoneAt(wx, wz) { const c = worldToIndex(wx, wz); if (!zones || c.i < 0 || c.j < 0 || c.i >= N || c.j >= N) return 0; return zones[c.j * N + c.i]; }
  function zoneSpots(t) {     // posiciones de mundo de las celdas de la zona t (cacheado)
    if (zonesDirty) {
      _zoneSpots[1].length = 0; _zoneSpots[2].length = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const z = zones[j * N + i]; if (z) { const w = vertWorld(i, j); _zoneSpots[z].push({ x: w.x, z: w.z }); } }
      zonesDirty = false;
    }
    return _zoneSpots[t] || [];
  }
  function saveZones() { try { localStorage.setItem(ZONES_KEY, JSON.stringify({ n: N, z: b64FromU8(zones) })); } catch (e) {} }
  function loadZones() { try { const s = JSON.parse(localStorage.getItem(ZONES_KEY) || 'null'); if (s && s.n === N && zones) { const u = u8FromB64(s.z); if (u.length === zones.length) { zones.set(u); zoneCounts[0] = zoneCounts[1] = zoneCounts[2] = 0; for (const v of zones) zoneCounts[v]++; zonesDirty = true; } } } catch (e) {} }

  function rgbHex(c) { return (c[0] << 16) | (c[1] << 8) | c[2]; }
  function setSel(kind, key) {
    selKind = kind; selKey = key;
    let col = 0xffe27a;                              // esculpir
    if (kind === 'asset') col = 0x7CFF9B;
    else if (kind === 'zone') col = key === 1 ? 0x50a0ff : key === 2 ? 0xffa030 : 0xff7a7a;
    else if (kind === 'arrival') col = 0x40e0ff;
    else if (kind === 'biome') col = key > 0 ? rgbHex(BIOMES[biomeKeys[key - 1]].color) : 0xff7a7a;
    ring.material.color.set(col);
    const selId = (kind === 'sculpt' || kind === 'nav') ? kind : kind[0] + ':' + key;
    paletteEl?.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.id === selId));
  }

  const dom = renderer.domElement;
  const onMove = (ev) => {
    hovering = castToTerrain(ev);
    const showRing = hovering && selKind !== 'nav';   // en modo navegar no mostramos el pincel
    ring.visible = showRing;
    if (showRing) ring.position.set(hit.x, hit.y + 0.2, hit.z);
    if (sculpting && hovering) {
      if (selKind === 'biome') paintBiome(selKey);
      else if (selKind === 'zone') paintZone(selKey);
      else if (selKind === 'sculpt') stroke();
    }
  };
  const onDown = (ev) => {
    if (ev.button !== 0) return;
    if (selKind === 'nav') return;                    // modo navegar: el clic-izq no edita el terreno
    if (!castToTerrain(ev)) return;
    if (selKind === 'asset') placeAsset(selKey, hit.x, hit.y, hit.z);
    else if (selKind === 'arrival') { if (humanSys) { humanSys.setArrival(hit.x, hit.z); toast('📍 Punto de llegada fijado'); } }
    else if (selKind === 'biome') { sculpting = true; paintBiome(selKey); }
    else if (selKind === 'zone') { sculpting = true; paintZone(selKey); }
    else if (selKind === 'sculpt') { sculpting = true; flattenTarget = hit.y; stroke(); }
  };
  const onUp = (ev) => { if (ev.button === 0) sculpting = false; };
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerdown', onDown);
  addEventListener('pointerup', onUp);

  // ---- ajusta cámara/sombras/pincel al tamaño ----
  let brushCtrl;
  function applySizeToView() {
    controls.minDistance = 0.4;            // zoom hasta tocar a la persona (1.7 m)
    controls.maxDistance = SIZE * 3.5;
    camera.position.set(SIZE * 0.55, SIZE * 0.5, SIZE * 0.8);
    controls.target.set(0, 0, 0);
    sunLight.position.copy(sun).multiplyScalar(SIZE * 1.5);
    sunLight.target.position.set(0, 0, 0);
    const s = SIZE * 0.72;
    const sc = sunLight.shadow.camera;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
    sc.near = SIZE * 0.05; sc.far = SIZE * 3.5;
    sc.updateProjectionMatrix();
    if (brushCtrl) { brushCtrl.max(Math.round(SIZE / 3)); }
    params.brushSize = Math.round(SIZE / 20);
    brushCtrl?.updateDisplay();
    resizeRing();
  }
  function setSize() {
    configureForSize();
    clearPlaced();
    buildTerrainMesh();
    applySizeToView();
  }

  // ============ FAUNA: aves, ballenas y peces ============
  const faunaGroup = new THREE.Group(); scene.add(faunaGroup);
  const birds = [], whales = [], sharks = [], dolphins = [], fishes = [];
  let faunaTime = 0;
  const birdMat  = new THREE.MeshStandardMaterial({ color: 0x2c2c34, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
  const songMat  = new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });   // pájaro chico (come fruta)
  const seaMat   = new THREE.MeshStandardMaterial({ color: 0xe6e0d2, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });    // ave marina (come peces)
  const raptorMat = new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });   // rapaz (come otras aves)
  const flocks = [];   // bandadas de pájaros chicos (centro que deambula)
  const whaleMat = new THREE.MeshStandardMaterial({ color: 0x35506b, roughness: 0.75, flatShading: true });
  const sharkMat = new THREE.MeshStandardMaterial({ color: 0x6e7b86, roughness: 0.7, flatShading: true });
  const dolphinMat = new THREE.MeshStandardMaterial({ color: 0x93a8bd, roughness: 0.55, flatShading: true });
  const spoutMat = new THREE.MeshStandardMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0.7, roughness: 0.4 });
  const fishMats = [
    new THREE.MeshStandardMaterial({ color: 0xc77b3a, roughness: 0.6, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x6f93b4, roughness: 0.6, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0xb9474a, roughness: 0.6, flatShading: true }),
  ];
  function buildBird(mat) {                     // ave: cuerpo (cono) + 2 alas planas que aletean
    mat = mat || birdMat;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.4, 5), mat);
    body.rotation.x = Math.PI / 2;             // punta hacia +z (frente del vuelo)
    const wGeo = new THREE.PlaneGeometry(2.3, 1.0);
    const mkWing = (sign) => {
      const pivot = new THREE.Group();
      const m = new THREE.Mesh(wGeo, mat);
      m.rotation.x = -Math.PI / 2;             // tumba el ala (plano horizontal)
      m.position.x = sign * 1.15;              // se extiende desde la raíz
      pivot.add(m); return pivot;
    };
    const lw = mkWing(-1), rw = mkWing(1);
    g.add(body, lw, rw);
    return { g, lw, rw };
  }
  function buildWhale() {                       // ballena azul ~18 u: cuerpo afilado (lathe) + pectorales + dorsal + flukes + soplido
    const g = new THREE.Group();
    // --- CUERPO: perfil real revolucionado (cola fina → panza ancha → cabeza ancha y roma) ---
    // pts = (radio, posición a lo largo del eje), de cola (-9) a morro (+8.95)
    const profile = [
      [0.05, -9.0], [0.55, -8.0], [0.75, -6.8],   // punta de cola + pedúnculo caudal fino
      [1.15, -5.2], [1.85, -3.4], [2.50, -1.4],
      [2.90,  0.6], [2.95,  2.4], [2.80,  3.9],     // panza (punto más ancho algo adelantado)
      [2.45,  5.2], [1.90,  6.4], [1.15,  7.6],     // cabeza ancha
      [0.40,  8.6], [0.05,  8.95],                  // morro romo cerrado
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const bodyWrap = new THREE.Group();             // grupo para aplastar dorsoventralmente en mundo
    const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 16), whaleMat);
    body.rotation.z = -Math.PI / 2;                 // eje del lathe (+y=morro) → +x (frente)
    bodyWrap.add(body); bodyWrap.scale.set(1, 0.9, 1);
    // --- ALETAS PECTORALES: largas, barridas hacia atrás y caídas (estilo ballena) ---
    const mkPec = (sign) => {
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.6, 3), whaleMat);
      m.scale.set(1, 1, 0.1); m.rotation.x = sign * Math.PI / 2;   // pala plana horizontal, punta hacia afuera
      m.position.z = sign * 1.5;
      grp.add(m); grp.position.set(2.2, -0.5, 0);
      grp.rotation.y = -sign * 0.5;                 // barrido hacia atrás
      grp.rotation.x = sign * 0.15;                 // ligera caída
      return grp;
    };
    // --- ALETA DORSAL: pequeña, atrás (la azul la tiene diminuta) ---
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 3), whaleMat);
    dorsal.position.set(-3.2, 2.3, 0); dorsal.rotation.z = -0.5; dorsal.scale.set(0.9, 1, 0.13);
    // --- COLA: flukes horizontales barridos, con muesca central ---
    const tail = new THREE.Group(); tail.position.x = -8.4;
    const mkFluke = (sign) => {
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 3), whaleMat);
      m.scale.set(1, 1, 0.12); m.rotation.x = sign * Math.PI / 2;  // pala plana horizontal, punta hacia afuera
      m.position.z = sign * 1.5;                    // deja una muesca en el centro
      grp.add(m); grp.rotation.y = -sign * 0.4;     // barrido hacia atrás
      return grp;
    };
    tail.add(mkFluke(1), mkFluke(-1));
    // --- SOPLIDO (oculto, sale al respirar) ---
    const spout = new THREE.Group(); spout.position.set(5.2, 1.9, 0); spout.visible = false;
    for (let s = 0; s < 3; s++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 5), spoutMat); p.position.y = s * 1.4; spout.add(p); }
    g.add(bodyWrap, mkPec(1), mkPec(-1), dorsal, tail, spout);
    return { g, tail, spout };
  }
  function buildFish(mat) {                     // pez: cuerpo elipsoide + cola (frente +x)
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), mat);
    body.scale.set(1.7, 0.8, 0.5);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.6, 3), mat);
    tail.rotation.z = -Math.PI / 2; tail.position.x = -1.05; tail.scale.set(1, 1, 0.35);
    g.add(body, tail);
    return g;
  }
  function buildShark() {                        // tiburón ~5 m (great white): cuerpo + morro + aletas (front +x)
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 3.0, 5, 10), sharkMat);
    body.rotation.z = Math.PI / 2; body.scale.set(1, 0.92, 0.82);   // torpedo a lo largo de x
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 6), sharkMat);
    snout.rotation.z = -Math.PI / 2; snout.position.x = 2.3; snout.scale.set(1, 0.9, 0.8);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.25, 3), sharkMat);  // aleta dorsal icónica
    dorsal.position.set(-0.1, 0.95, 0); dorsal.rotation.z = -0.35; dorsal.scale.set(0.9, 1, 0.14);
    const caudU = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.7, 3), sharkMat);     // cola: lóbulo superior grande
    caudU.position.set(-2.4, 0.55, 0); caudU.rotation.z = 0.5; caudU.scale.set(0.7, 1, 0.14);
    const caudL = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.0, 3), sharkMat);    // lóbulo inferior menor
    caudL.position.set(-2.35, -0.45, 0); caudL.rotation.z = Math.PI - 0.4; caudL.scale.set(0.6, 1, 0.14);
    const mkPec = (sign) => { const p = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.1, 3), sharkMat);
      p.position.set(0.7, -0.25, sign * 0.55); p.rotation.set(sign * 0.5, 0, -0.5); p.scale.set(0.6, 1, 0.12); return p; };
    g.add(body, snout, dorsal, caudU, caudL, mkPec(1), mkPec(-1));
    return { g };
  }
  function buildDolphin() {                       // delfín ~3 m (bottlenose): cuerpo curvo + hocico + flukes horizontales
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.7, 5, 10), dolphinMat);
    body.rotation.z = Math.PI / 2; body.scale.set(1, 0.95, 0.86);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.6, 6), dolphinMat);   // rostrum
    beak.rotation.z = -Math.PI / 2; beak.position.set(1.45, -0.05, 0);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.72, 3), dolphinMat); // aleta dorsal curva hacia atrás
    dorsal.position.set(-0.1, 0.5, 0); dorsal.rotation.z = -0.6; dorsal.scale.set(0.85, 1, 0.13);
    const tail = new THREE.Group(); tail.position.x = -1.4;                          // flukes HORIZONTALES
    const fl1 = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.18, 3), dolphinMat);
    fl1.rotation.x = Math.PI / 2; fl1.position.z = 0.42; fl1.scale.set(1, 1, 0.45);
    const fl2 = fl1.clone(); fl2.position.z = -0.42; fl2.rotation.x = -Math.PI / 2;
    tail.add(fl1, fl2);
    const mkPec = (sign) => { const p = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 3), dolphinMat);
      p.position.set(0.55, -0.18, sign * 0.4); p.rotation.set(sign * 0.5, 0, -0.4); p.scale.set(0.6, 1, 0.12); return p; };
    g.add(body, beak, dorsal, tail, mkPec(1), mkPec(-1));
    return { g };
  }
  function clearFauna() {
    for (const arr of [birds, whales, sharks, dolphins, fishes]) {
      for (const o of arr) { faunaGroup.remove(o.g); o.g.traverse((c) => c.geometry?.dispose?.()); }
      arr.length = 0;
    }
  }
  // devuelve un radio de órbita (≥ r0) cuyo anillo cae casi todo en AGUA (evita que la fauna marina
  // patrulle embebida en la isla). Empuja el radio hacia afuera hasta encontrar mar abierto.
  function waterRingRadius(r0) {
    let r = r0;
    for (let step = 0; step < 14; step++) {
      let land = 0;
      for (let a = 0; a < 8; a++) { const an = a / 8 * TWO_PI; if (heightAt(Math.cos(an) * r, Math.sin(an) * r) > -1) land++; }
      if (land <= 2) return r;
      r += SIZE * 0.06;
    }
    return r;
  }
  function spawnFauna() {
    clearFauna();
    // --- AVES (ecología): bandadas de pájaros chicos (fruta) + aves marinas (peces) + rapaces (otras aves) ---
    flocks.length = 0;
    const nFlocks = 1 + (Math.random() * 2 | 0);
    for (let f = 0; f < nFlocks; f++) {
      const fl = { cx: (Math.random() - 0.5) * SIZE * 0.4, cz: (Math.random() - 0.5) * SIZE * 0.4, vx: 0, vz: 0, alt: Math.max(45, LAND_MAX * (0.7 + Math.random() * 0.6)), scatter: 0 };
      flocks.push(fl);
      const nS = 5 + (Math.random() * 6 | 0);
      for (let k = 0; k < nS; k++) {
        const b = buildBird(songMat); b.g.scale.setScalar(0.7 + Math.random() * 0.5); faunaGroup.add(b.g);
        birds.push(Object.assign(b, { kind: 'song', flock: fl, R: 6 + Math.random() * 14, ang: Math.random() * 6.283, spd: (0.5 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6.283, flap: 11 + Math.random() * 4 }));
      }
    }
    const nSea = 2 + (Math.random() * 3 | 0);
    for (let k = 0; k < nSea; k++) {
      const b = buildBird(seaMat); b.g.scale.setScalar(1.4 + Math.random() * 0.8); faunaGroup.add(b.g);
      birds.push(Object.assign(b, { kind: 'sea', R: waterRingRadius(SIZE * (0.34 + Math.random() * 0.12)), alt: 22 + Math.random() * 18, cx: 0, cz: 0, ang: Math.random() * 6.283, spd: (0.12 + Math.random() * 0.1) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6.283, flap: 6 + Math.random() * 2, dive: 3 + Math.random() * 5 }));
    }
    const nR = Math.random() < 0.6 ? 1 : 0;
    for (let k = 0; k < nR; k++) {
      const b = buildBird(raptorMat); b.g.scale.setScalar(1.7 + Math.random() * 0.6); faunaGroup.add(b.g);
      birds.push(Object.assign(b, { kind: 'raptor', R: SIZE * (0.1 + Math.random() * 0.12), alt: Math.max(80, LAND_MAX * 1.5), cx: (Math.random() - 0.5) * SIZE * 0.2, cz: (Math.random() - 0.5) * SIZE * 0.2, ang: Math.random() * 6.283, spd: 0.14 * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6.283, flap: 5, hunt: 5 + Math.random() * 5 }));
    }
    // --- BALLENAS: BAJA probabilidad; orbitan en aguas profundas; salen a la superficie CADA TANTO ---
    // base ~18 m × escala 1.0-1.6 → 18-29 m (azul real ~25-33 m)
    const nW = Math.random() < 0.35 ? (1 + (Math.random() < 0.25 ? 1 : 0)) : 0;
    for (let k = 0; k < nW; k++) {
      const w = buildWhale(); w.g.scale.setScalar(1.0 + Math.random() * 0.6); w.g.visible = false;
      faunaGroup.add(w.g);
      whales.push(Object.assign(w, {
        R: waterRingRadius(SIZE * (0.30 + Math.random() * 0.08)), ang: Math.random() * 6.283,
        spd: (0.02 + Math.random() * 0.02) * (Math.random() < 0.5 ? -1 : 1),
        state: 'wait', timer: 2 + Math.random() * 6, swimLeft: 0, spoutT: 0, spoutScale: 0,
      }));
    }
    // --- TIBURONES: BAJA probabilidad; patrullan cerca de la superficie con la aleta dorsal cortando el agua ---
    // ~5 m (great white real 4.6-6 m): cuerpo casi sumergido, solo lomo+aleta asoman
    const nS = Math.random() < 0.75 ? (1 + (Math.random() < 0.4 ? 1 : 0)) : 0;   // suelen verse 1-2
    for (let k = 0; k < nS; k++) {
      const s = buildShark(); s.g.scale.setScalar(0.9 + Math.random() * 0.25);
      faunaGroup.add(s.g);
      sharks.push(Object.assign(s, {
        R: waterRingRadius(SIZE * (0.28 + Math.random() * 0.14)), ang: Math.random() * 6.283,   // patrulla en mar abierto
        spd: (0.05 + Math.random() * 0.05) * (Math.random() < 0.5 ? -1 : 1),
        ph: Math.random() * 6.283,
      }));
    }
    // --- DELFINES: BAJA probabilidad; manada que avanza haciendo arcos (porpoising) ---
    // ~3 m (bottlenose real 2.4-3.7 m)
    if (Math.random() < 0.85) {                          // manada casi siempre presente
      const Rpod = waterRingRadius(SIZE * (0.24 + Math.random() * 0.12));   // circula la isla en mar abierto
      const ang0 = Math.random() * 6.283;
      const dir = Math.random() < 0.5 ? -1 : 1, spd = (0.06 + Math.random() * 0.05) * dir;
      const nD = 4 + (Math.random() * 3 | 0);            // varios (4-6)
      for (let k = 0; k < nD; k++) {
        const d = buildDolphin(); d.g.scale.setScalar(0.85 + Math.random() * 0.35);
        faunaGroup.add(d.g);
        dolphins.push(Object.assign(d, {
          cx: 0, cz: 0, R: Rpod + (Math.random() - 0.5) * 24, ang: ang0 + (Math.random() - 0.5) * 0.5,   // manada compacta
          spd, leapH: 1.8 + Math.random() * 1.1, ph: Math.random() * 6.283, leapRate: 1.3 + Math.random() * 0.5,
        }));
      }
    }
    // --- PECES DE LAGO: varios tamaños, saltan cada tanto ---
    for (const L of lakeInfo) {
      const n = THREE.MathUtils.clamp(Math.round(L.r / 6), 2, 18);   // más peces en lagos más grandes
      for (let k = 0; k < n; k++) {
        const size = 0.15 + Math.random() * 0.13;      // ~0.35-0.6 m (real)
        const g = buildFish(fishMats[(Math.random() * fishMats.length) | 0]);
        g.scale.setScalar(size); faunaGroup.add(g);
        fishes.push({ g, cx: L.x, cz: L.z, area: L.r * 0.7, surf: L.level, jumpH: 0.4 + size * 2.0, size,
          state: 'wait', timer: Math.random() * 6, t: 0, dur: 0, jx: L.x, jz: L.z, dx: 1, dz: 0 });
      }
    }
    // --- PECES DE RÍO: chiquitos, solo en tramos bajos (no montaña) ---
    if (riverPts.length) {
      const want = Math.min(riverPts.length, 10);
      for (let k = 0; k < want; k++) {
        const p = riverPts[(Math.random() * riverPts.length) | 0];
        const size = 0.1 + Math.random() * 0.08;       // ~0.2-0.4 m (real, río)
        const g = buildFish(fishMats[(Math.random() * fishMats.length) | 0]);
        g.scale.setScalar(size); faunaGroup.add(g);
        fishes.push({ g, cx: p.x, cz: p.z, area: 1.5, surf: p.y + 0.15, jumpH: 0.3 + size * 1.6, size,
          state: 'wait', timer: Math.random() * 5, t: 0, dur: 0, jx: p.x, jz: p.z, dx: 1, dz: 0 });
      }
    }
  }
  // Coloca un animal VIVO en (x,z): se integra a la fauna y se comporta según su tipo (no queda estático).
  function spawnPlacedAnimal(key, x, y, z) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    if (key === 'ave') {
      const b = buildBird(); b.g.scale.setScalar(1.0 + Math.random() * 0.8); faunaGroup.add(b.g);
      const groundY = Math.max(0, heightAt(x, z));
      birds.push(Object.assign(b, { cx: x, cz: z, R: 22 + Math.random() * 40,
        alt: groundY + 32 + Math.random() * 34, ang: Math.random() * 6.283,
        spd: (0.12 + Math.random() * 0.12) * dir, ph: Math.random() * 6.283, flap: 7 + Math.random() * 3 }));
    } else if (key === 'pez') {
      const size = 0.2 + Math.random() * 0.12;
      const g = buildFish(fishMats[(Math.random() * fishMats.length) | 0]); g.scale.setScalar(size); faunaGroup.add(g);
      const surf = y > 0.5 ? y : 0;
      fishes.push({ g, cx: x, cz: z, area: 7, surf, jumpH: 0.5 + size * 2.0, size,
        state: 'wait', timer: Math.random() * 4, t: 0, dur: 0, jx: x, jz: z, dx: 1, dz: 0 });
    } else if (key === 'delfin') {
      const d = buildDolphin(); d.g.scale.setScalar(0.9 + Math.random() * 0.3); faunaGroup.add(d.g);
      dolphins.push(Object.assign(d, { cx: x, cz: z, R: 22 + Math.random() * 28, ang: Math.random() * 6.283,
        spd: (0.07 + Math.random() * 0.05) * dir, leapH: 1.8 + Math.random() * 1.0, ph: Math.random() * 6.283, leapRate: 1.3 + Math.random() * 0.5 }));
    } else if (key === 'tiburon') {
      const s = buildShark(); s.g.scale.setScalar(0.9 + Math.random() * 0.25); faunaGroup.add(s.g);
      sharks.push(Object.assign(s, { cx: x, cz: z, R: 26 + Math.random() * 38, ang: Math.random() * 6.283,
        spd: (0.06 + Math.random() * 0.05) * dir, ph: Math.random() * 6.283 }));
    } else if (key === 'ballena') {
      const w = buildWhale(); w.g.scale.setScalar(1.0 + Math.random() * 0.5); w.g.visible = true; faunaGroup.add(w.g);
      whales.push(Object.assign(w, { cx: x, cz: z, R: 45 + Math.random() * 55, ang: Math.random() * 6.283,
        spd: (0.03 + Math.random() * 0.02) * dir, state: 'swim', swimLeft: Infinity, spoutT: 2 + Math.random() * 4, spoutScale: 0, placed: true }));
    }
  }
  function updateFauna(dt) {
    faunaTime += dt; const t = faunaTime;
    for (const fl of flocks) {                  // bandadas: el centro deambula sobre la isla (huye al ser atacada)
      fl.vx += (Math.random() - 0.5) * dt * 4; fl.vz += (Math.random() - 0.5) * dt * 4;
      const sp = Math.hypot(fl.vx, fl.vz), mx = fl.scatter > 0 ? 16 : 5; if (sp > mx) { fl.vx *= mx / sp; fl.vz *= mx / sp; }
      fl.cx += fl.vx * dt; fl.cz += fl.vz * dt;
      const lim = SIZE * 0.4; if (Math.abs(fl.cx) > lim) { fl.cx = Math.sign(fl.cx) * lim; fl.vx *= -0.6; } if (Math.abs(fl.cz) > lim) { fl.cz = Math.sign(fl.cz) * lim; fl.vz *= -0.6; }
      if (fl.scatter > 0) fl.scatter -= dt;
    }
    for (const b of birds) {                    // aves: aleteo + comportamiento por tipo
      const fa = Math.sin(t * b.flap + b.ph) * 0.7; b.lw.rotation.z = -fa; b.rw.rotation.z = fa;
      const sgn = Math.sign(b.spd);
      if (b.kind === 'song') {                  // pájaro chico: vuela en bandada (come fruta), se dispersa si hay rapaz
        b.ang += b.spd * dt;
        b.g.position.set(b.flock.cx + Math.cos(b.ang) * b.R, b.flock.alt + Math.sin(t * 1.6 + b.ph) * 3, b.flock.cz + Math.sin(b.ang) * b.R);
        b.g.rotation.y = Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn);
      } else if (b.kind === 'sea') {            // ave marina: orbita el mar y pica al agua a pescar
        b.ang += b.spd * dt; b.dive -= dt;
        let y = b.alt + Math.sin(t * 0.8 + b.ph) * 4;
        if (b.dive > 0 && b.dive < 0.7) y = 2 + Math.abs(b.dive - 0.35) * 50;   // zambullida
        if (b.dive <= 0) b.dive = 4 + Math.random() * 6;
        b.g.position.set(Math.cos(b.ang) * b.R, y, Math.sin(b.ang) * b.R);
        b.g.rotation.y = Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn);
      } else if (b.kind === 'raptor') {         // rapaz: caza bandadas (las dispersa)
        b.ang += b.spd * dt; b.hunt -= dt;
        if (b.hunt <= 0 && flocks.length) { const fl = flocks[(Math.random() * flocks.length) | 0]; b.cx = fl.cx; b.cz = fl.cz; fl.scatter = 2.4; b.hunt = 6 + Math.random() * 6; }
        b.g.position.set(b.cx + Math.cos(b.ang) * b.R, b.alt + Math.sin(t * 0.6 + b.ph) * 5, b.cz + Math.sin(b.ang) * b.R);
        b.g.rotation.y = Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn);
      } else {                                  // aves colocadas a mano (órbita simple)
        b.ang += b.spd * dt;
        b.g.position.set(b.cx + Math.cos(b.ang) * b.R, b.alt + Math.sin(t * 0.7 + b.ph) * 6, b.cz + Math.sin(b.ang) * b.R);
        b.g.rotation.y = Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn);
      }
    }
    for (const w of whales) {                   // ballenas: máquina de estados (espera larga ↔ pasada)
      if (w.state === 'wait') {
        w.timer -= dt;
        if (w.timer <= 0) { w.state = 'swim'; w.swimLeft = 5 + Math.random() * 6; w.g.visible = true; w.spoutT = 1 + Math.random() * 3; }
      } else {
        w.swimLeft -= dt * Math.abs(w.spd); w.ang += w.spd * dt;
        const x = (w.cx || 0) + Math.cos(w.ang) * w.R, z = (w.cz || 0) + Math.sin(w.ang) * w.R, sgn = Math.sign(w.spd);
        const dxdir = -Math.sin(w.ang) * sgn, dzdir = Math.cos(w.ang) * sgn;
        w.g.position.set(x, -0.9 + Math.sin(t * 0.5) * 0.4, z);   // lomo bien expuesto sobre la superficie
        w.g.rotation.y = Math.atan2(-dzdir, dxdir);
        w.tail.rotation.y = Math.sin(t * 1.2) * 0.3;
        w.spoutT -= dt;
        if (w.spoutT <= 0) { w.spout.visible = true; w.spoutScale = 1.4; w.spoutT = 6 + Math.random() * 6; }
        if (w.spout.visible) { w.spoutScale -= dt * 1.1; if (w.spoutScale <= 0) w.spout.visible = false; else w.spout.scale.setScalar(0.4 + w.spoutScale); }
        // las ballenas colocadas a mano nadan en bucle (no terminan la pasada ni se ocultan)
        if (!w.placed && (w.swimLeft <= 0 || heightAt(x, z) >= -2)) { w.state = 'wait'; w.timer = 8 + Math.random() * 14; w.g.visible = false; w.spout.visible = false; }
      }
    }
    for (const s of sharks) {                   // tiburones: patrullan en superficie, aleta dorsal cortando el agua
      s.ang += s.spd * dt; const sgn = Math.sign(s.spd);
      const x = (s.cx || 0) + Math.cos(s.ang) * s.R, z = (s.cz || 0) + Math.sin(s.ang) * s.R;
      s.g.position.set(x, -0.3 + Math.sin(t * 0.8 + s.ph) * 0.1, z);   // lomo a ras → asoman aleta dorsal y dorso
      s.g.rotation.y = Math.atan2(-Math.cos(s.ang) * sgn, -Math.sin(s.ang) * sgn);
      s.g.rotation.z = Math.sin(t * 2.2 + s.ph) * 0.06;                  // leve coleo
    }
    for (const d of dolphins) {                 // delfines: avanzan en manada haciendo arcos (porpoising)
      d.ang += d.spd * dt; const sgn = Math.sign(d.spd);
      const x = d.cx + Math.cos(d.ang) * d.R, z = d.cz + Math.sin(d.ang) * d.R;
      const ph = t * d.leapRate + d.ph, sn = Math.sin(ph);
      const y = sn > 0 ? sn * d.leapH : sn * 0.5;      // arco fuera del agua / pequeña zambullida
      d.g.position.set(x, y, z);
      d.g.rotation.y = Math.atan2(-Math.cos(d.ang) * sgn, -Math.sin(d.ang) * sgn);
      d.g.rotation.z = Math.cos(ph) * 0.9;             // morro arriba al subir, abajo al bajar
    }
    const fcull2 = params.vegDist * params.vegDist;   // peces lejanos no se renderizan
    for (const f of fishes) {                   // peces: nadan visibles a ras de superficie y saltan cada tanto
      const dxc = f.cx - camera.position.x, dzc = f.cz - camera.position.z;
      if (dxc * dxc + dzc * dzc > fcull2) { f.g.visible = false; continue; }
      if (f.hd === undefined) {                  // init perezoso del crucero
        f.hd = Math.random() * 6.283; f.px = f.cx; f.pz = f.cz; f.phase = Math.random() * 6.283; f.t2 = 0;
      }
      f.g.visible = true;
      if (f.state === 'wait') {                  // crucero: deriva lenta serpenteando dentro de su zona
        f.t2 += dt;
        f.hd += (Math.random() - 0.5) * dt * 1.4;
        const sp = 0.3 + f.size * 1.2;
        f.px += Math.cos(f.hd) * sp * dt; f.pz += Math.sin(f.hd) * sp * dt;
        const dx0 = f.px - f.cx, dz0 = f.pz - f.cz, dist = Math.hypot(dx0, dz0) || 1;
        if (dist > f.area) { f.hd += Math.PI; f.px = f.cx + dx0 / dist * f.area; f.pz = f.cz + dz0 / dist * f.area; }
        const bob = Math.sin(f.t2 * 2 + f.phase) * 0.03 * f.size;
        f.g.position.set(f.px, f.surf - f.size * 0.12 + bob, f.pz);   // lomo justo rompiendo la superficie
        f.g.rotation.set(0, Math.atan2(-Math.sin(f.hd), Math.cos(f.hd)), Math.sin(f.t2 * 7 + f.phase) * 0.12);
        f.timer -= dt;
        if (f.timer <= 0) {                      // arranca un salto desde la posición actual
          f.jx = f.px; f.jz = f.pz; f.dx = Math.cos(f.hd); f.dz = Math.sin(f.hd);
          f.t = 0; f.dur = 0.75 + Math.random() * 0.4; f.state = 'jump';
        }
      } else {                                   // salto en arco con morro arriba/abajo
        f.t += dt; const p = f.t / f.dur;
        if (p >= 1) { f.state = 'wait'; f.timer = 3 + Math.random() * 6;
          f.px = f.jx + f.dx * f.size * 0.75; f.pz = f.jz + f.dz * f.size * 0.75; continue; }
        const travel = f.size * 1.5;
        f.g.position.set(f.jx + f.dx * travel * (p - 0.5), f.surf + f.jumpH * Math.sin(p * Math.PI), f.jz + f.dz * travel * (p - 0.5));
        f.g.rotation.set(0, Math.atan2(-f.dz, f.dx), Math.cos(p * Math.PI) * 1.0);
      }
    }
  }

  // ============ ESTACIONES + CLIMA LOCALIZADO + OLAS DE ORILLA ============
  // ---- ESTACIONES: línea de nieve dinámica (solo se congelan las cimas) + tinte estacional del follaje ----
  const SEASON_NAMES = ['🌸 Primavera', '☀️ Verano', '🍂 Otoño', '❄️ Invierno'];
  const _foliageTint = new THREE.Color();
  let _lastSnowRecolor = -1e9;
  function seasonName() { return SEASON_NAMES[Math.min(3, Math.floor((((params.season % 1) + 1) % 1) * 4))]; }
  function applySeasonVisuals() {
    const s = ((params.season % 1) + 1) % 1;
    const temp = Math.cos((s - 0.25) * TWO_PI);          // 1 en verano · -1 en invierno
    const cold = (1 - temp) / 2;                         // 0 verano … 1 invierno
    seasonSnowY = LAND_MAX * (0.82 - 0.42 * cold);       // línea de nieve: alta en verano (solo cima), baja en invierno
    // tinte del follaje (multiplica el color por vértice): verano verde pleno, otoño ámbar, invierno apagado
    let tr, tg, tb;
    if (s < 0.25) { const k = s / 0.25; tr = 0.80 + 0.20 * k; tg = 0.95 + 0.05 * k; tb = 0.78 + 0.10 * k; }       // primavera → verano
    else if (s < 0.50) { const k = (s - 0.25) / 0.25; tr = 1.00; tg = 1.00 - 0.28 * k; tb = 0.88 - 0.50 * k; }     // verano → otoño (amarillea)
    else if (s < 0.75) { const k = (s - 0.50) / 0.25; tr = 1.00 - 0.28 * k; tg = 0.72 - 0.30 * k; tb = 0.38 - 0.05 * k; } // otoño → invierno (marrón apagado)
    else { const k = (s - 0.75) / 0.25; tr = 0.72 + 0.08 * k; tg = 0.42 + 0.53 * k; tb = 0.33 + 0.45 * k; }        // invierno → primavera
    _foliageTint.setRGB(tr, tg, tb);
    plantMat.color.copy(_foliageTint);
    // árboles a la altura de la nieve se vuelven blancos (sobre todo en otoño tardío/invierno)
    snowUniforms.uSnowY.value = seasonSnowY - LAND_MAX * 0.04;   // empieza un poco por debajo del manto del terreno
    snowUniforms.uSnowBand.value = LAND_MAX * 0.12;
    snowUniforms.uSnowAmt.value = Math.max(0, cold - 0.15) / 0.85;   // aparece cuando refresca, pleno en invierno
  }
  function updateSeason(dt) {
    if (params.seasonCycle && !scenePlaying) params.season = (params.season + dt / params.seasonSeconds) % 1;
    applySeasonVisuals();
    if (Math.abs(seasonSnowY - _lastSnowRecolor) > LAND_MAX * 0.015) { _lastSnowRecolor = seasonSnowY; recolorAll(); }  // recolorea solo si la nieve se movió
  }

  // ---- OLAS DE ORILLA: parches de espuma que lavan la arena en la línea de costa ----
  const foamGroup = new THREE.Group(); scene.add(foamGroup);
  const foamMat = new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0, depthWrite: false });
  const foamPatches = [];
  function clearFoam() { for (const f of foamPatches) { foamGroup.remove(f.m); f.m.geometry.dispose(); f.m.material.dispose(); } foamPatches.length = 0; }
  function buildShoreFoam() {
    clearFoam();
    if (!relief) return;
    const spots = findReliefSpots('orilla', 90).concat(findReliefSpots('playa', 40));
    for (const p of spots) {
      const sz = SIZE * (0.008 + Math.random() * 0.012);
      const m = new THREE.Mesh(new THREE.CircleGeometry(sz, 10), foamMat.clone());
      m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.12, p.z); m.renderOrder = 3;
      foamGroup.add(m);
      foamPatches.push({ m, ph: Math.random() * TWO_PI, rate: 0.7 + Math.random() * 0.6 });
    }
  }
  function updateFoam(t) {
    foamGroup.visible = params.shoreWaves;
    if (!params.shoreWaves) return;
    const wind = 0.6 + params.windSpeed * 1.0;             // con más viento, olas más rápidas y marcadas
    for (const f of foamPatches) {
      const w = 0.5 + 0.5 * Math.sin(t * f.rate * wind + f.ph);   // lavado entra/sale
      f.m.material.opacity = (0.12 + 0.5 * w) * (0.7 + 0.5 * params.windSpeed);
      const s = (0.55 + 0.7 * w) * (0.85 + 0.4 * params.windSpeed); f.m.scale.set(s, s, s);
    }
  }

  // ---- CLIMA LOCALIZADO: celdas que cruzan el mapa con nubes/lluvia/niebla; a veces un tifón ----
  const weatherGroup = new THREE.Group(); scene.add(weatherGroup);
  const cloudGeo = new THREE.IcosahedronGeometry(1, 1);
  const cloudMatLight = new THREE.MeshStandardMaterial({ color: 0xf4f7fc, roughness: 1, flatShading: true });
  const cloudMatDark = new THREE.MeshStandardMaterial({ color: 0x717b8c, roughness: 1, flatShading: true });
  const fogCanvas = document.createElement('canvas'); fogCanvas.width = fogCanvas.height = 64;
  const fctx = fogCanvas.getContext('2d');
  const fgr = fctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  fgr.addColorStop(0, 'rgba(222,227,236,0.75)'); fgr.addColorStop(1, 'rgba(222,227,236,0)');
  fctx.fillStyle = fgr; fctx.fillRect(0, 0, 64, 64);
  const fogTex = new THREE.CanvasTexture(fogCanvas);
  const weatherCells = [];
  let weatherInited = false, windX = 1, windZ = 0, windSpeed = 10;
  // LLUVIA LOCAL: volumen denso anclado a la cámara → al meterse bajo una nube se ve un aguacero de verdad
  const LR_N = 2600, LR_H = 55, LR_V = 50;
  const localRainGeo = new THREE.BufferGeometry();
  const lrPos = new Float32Array(LR_N * 3);
  for (let i = 0; i < LR_N; i++) { lrPos[i * 3] = (Math.random() - 0.5) * 2 * LR_H; lrPos[i * 3 + 1] = Math.random() * LR_V; lrPos[i * 3 + 2] = (Math.random() - 0.5) * 2 * LR_H; }
  localRainGeo.setAttribute('position', new THREE.BufferAttribute(lrPos, 3));
  const localRainMat = new THREE.PointsMaterial({ color: 0xc2d0e4, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false });
  const localRain = new THREE.Points(localRainGeo, localRainMat); localRain.frustumCulled = false; scene.add(localRain);
  function makeCell() { const g = new THREE.Group(); weatherGroup.add(g); const c = { g, type: 'cloud', x: 0, z: 0, r: 1, puffs: [], rain: null, rainTop: 0, fogs: [], typhoon: false, alpha: 0, forced: false }; weatherCells.push(c); return c; }
  function dressCell(cell) {                              // (re)construye los visuales según tipo/tamaño
    for (const p of cell.puffs) cell.g.remove(p); cell.puffs.length = 0;
    for (const f of cell.fogs) { cell.g.remove(f); f.material.dispose(); } cell.fogs.length = 0;
    if (cell.rain) { cell.g.remove(cell.rain); cell.rain.geometry.dispose(); cell.rain.material.dispose(); cell.rain = null; }
    const r = cell.r, wet = cell.type === 'rain' || cell.typhoon;
    const cloudY = Math.max(LAND_MAX * 1.6, SIZE * 0.18);
    cell.rainTop = cloudY;
    if (cell.type !== 'fog') {                            // nubes (claras o de tormenta)
      const mat = wet ? cloudMatDark : cloudMatLight;
      const nP = cell.typhoon ? 26 : (7 + Math.round(r / SIZE * 34));   // más puffs cuanto mayor la celda → cubre la isla
      for (let i = 0; i < nP; i++) {
        const m = new THREE.Mesh(cloudGeo, mat);
        if (cell.typhoon) { const a = i / nP * TWO_PI * 2.2, rr = r * (0.12 + 0.85 * i / nP); m.position.set(Math.cos(a) * rr, cloudY + (Math.random() - 0.5) * r * 0.1, Math.sin(a) * rr); }
        else m.position.set((Math.random() - 0.5) * r * 1.4, cloudY + (Math.random() - 0.5) * r * 0.2, (Math.random() - 0.5) * r * 1.4);
        const sc = r * (0.16 + Math.random() * 0.18); m.scale.set(sc * 1.6, sc * 0.8, sc * 1.6);
        cell.g.add(m); cell.puffs.push(m);
      }
    }
    if (wet) {                                            // lluvia: Points dentro del cilindro de la celda (densidad ∝ área)
      const area = (r * r) / (SIZE * SIZE);
      const n = Math.max(500, Math.min(cell.typhoon ? 13000 : 5000, Math.round(area * (cell.typhoon ? 2.4 : 1.7) * 9000)));
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const a = Math.random() * TWO_PI, rr = Math.sqrt(Math.random()) * r; pos[i * 3] = Math.cos(a) * rr; pos[i * 3 + 1] = Math.random() * cloudY; pos[i * 3 + 2] = Math.sin(a) * rr; }
      const gge = new THREE.BufferGeometry(); gge.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const rmat = new THREE.PointsMaterial({ color: cell.typhoon ? 0x8fa0b8 : 0xaebfd6, size: cell.typhoon ? 3 : 2.2, sizeAttenuation: false, transparent: true, opacity: 0.5, depthWrite: false });
      cell.rain = new THREE.Points(gge, rmat); cell.g.add(cell.rain);
    }
    if (cell.type === 'fog') {                            // niebla a ras de suelo
      const nF = 5 + (Math.random() * 4 | 0);
      for (let i = 0; i < nF; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: fogTex, transparent: true, opacity: 0, depthWrite: false }));
        s.position.set((Math.random() - 0.5) * r * 1.6, LAND_MAX * 0.08 + Math.random() * LAND_MAX * 0.1, (Math.random() - 0.5) * r * 1.6);
        const sc = r * (0.8 + Math.random() * 0.8); s.scale.set(sc, sc * 0.5, 1);
        cell.g.add(s); cell.fogs.push(s);
      }
    }
  }
  function recycleCell(cell, firstTime) {
    cell.forced = false;
    const a = params.weatherAmount, roll = Math.random();
    cell.typhoon = !firstTime && Math.random() < 0.05 * a;            // tifón ocasional
    cell.type = cell.typhoon ? 'rain' : (roll < 0.45 ? 'cloud' : roll < 0.45 + 0.35 * a ? 'rain' : 'fog');
    // celdas grandes: en una isla de pocos km una tormenta real cubre buena parte del terreno
    cell.r = cell.typhoon ? SIZE * 0.9 : SIZE * (0.22 + Math.random() * 0.24);
    const edge = SIZE * 1.0;
    cell.x = -windX * edge + (Math.random() - 0.5) * SIZE; cell.z = -windZ * edge + (Math.random() - 0.5) * SIZE;
    cell.alpha = 0;
    dressCell(cell);
  }
  function clearSky() {                                    // barre la tormenta/nubes actuales (el clima sigue según Nubosidad)
    if (!weatherInited) return;
    for (const c of weatherCells) { recycleCell(c, true); c.alpha = 0; c.g.position.set(c.x, 0, c.z); }
    localRain.visible = false;
    toast('☀️ Cielo despejado');
  }
  function forceStorm() {                                  // dispara una tormenta grande sobre la isla (para grabar/probar)
    params.weather = true;
    if (!weatherInited) initWeather();
    const c = weatherCells[0];
    c.typhoon = false; c.type = 'rain'; c.r = SIZE * 0.75;
    c.x = (Math.random() - 0.5) * SIZE * 0.2; c.z = (Math.random() - 0.5) * SIZE * 0.2;   // centrada sobre la isla
    c.alpha = 1; c.forced = true; c.g.position.set(c.x, 0, c.z); dressCell(c);   // forzada: visible aunque Nubosidad sea baja
    toast('⛈️ Tormenta sobre la isla');
  }
  function initWeather() {
    weatherInited = true;
    const ang = Math.random() * TWO_PI; windX = Math.cos(ang); windZ = Math.sin(ang); windSpeed = SIZE * (0.01 + Math.random() * 0.02);
    for (let i = 0; i < 14; i++) { const c = makeCell(); recycleCell(c, true); c.x = (Math.random() - 0.5) * SIZE * 1.8; c.z = (Math.random() - 0.5) * SIZE * 1.8; c.alpha = 1; c.g.position.set(c.x, 0, c.z); }
  }
  function updateWeather(dt, t) {
    // viento (siempre, aunque el clima visible esté apagado): mece árboles cercanos y olas
    windUniforms.uWindTime.value += dt * (0.5 + params.windSpeed * 2.5);
    windUniforms.uWindStr.value = params.windSpeed * 0.05;
    windUniforms.uWindDir.value.set(windX, windZ);
    windUniforms.uWindCam.value.copy(camera.position);
    windUniforms.uWindNear.value = SIZE * 0.05; windUniforms.uWindFar.value = SIZE * 0.16;
    weatherGroup.visible = params.weather;
    localRain.visible = localRain.visible && params.weather;
    if (!params.weather) return;
    if (!weatherInited) initWeather();
    const want = params.weatherAmount <= 0.001 ? 0 : Math.min(weatherCells.length, Math.round(1 + params.weatherAmount * 12));   // 0 = cielo despejado · 1 = cubierto
    const drift = params.windSpeed * SIZE * 0.018;                  // viento más suave → la lluvia tarda más en pasar
    let storm = 0;                                                   // cuánto cubre una tormenta el centro de la isla
    let rainAtCam = 0;                                              // cuánto llueve justo sobre la cámara
    const cpx = camera.position.x, cpz = camera.position.z;
    for (let i = 0; i < weatherCells.length; i++) {
      const cell = weatherCells[i], active = i < want || cell.forced;
      cell.g.visible = active;
      if (!active) continue;
      cell.x += windX * drift * dt; cell.z += windZ * drift * dt;
      cell.alpha = Math.min(1, cell.alpha + dt * 0.3);
      cell.g.position.set(cell.x, 0, cell.z);
      if (cell.typhoon) cell.g.rotation.y += dt * 0.25;             // remolino del tifón
      if (cell.rain) {
        const arr = cell.rain.geometry.attributes.position.array, fall = (cell.typhoon ? 90 : 60) * dt * (SIZE / 600);
        for (let k = 1; k < arr.length; k += 3) { arr[k] -= fall; if (arr[k] < 0) arr[k] = cell.rainTop; }
        cell.rain.geometry.attributes.position.needsUpdate = true;
        cell.rain.material.opacity = 0.5 * cell.alpha;
        const cover = Math.max(0, 1 - Math.hypot(cell.x, cell.z) / (cell.r * 1.1));   // cubre el centro de la isla
        storm = Math.max(storm, cover * cell.alpha * (cell.typhoon ? 1 : 0.85));
        const cAt = Math.max(0, 1 - Math.hypot(cell.x - cpx, cell.z - cpz) / cell.r);   // ¿la cámara está bajo esta celda?
        rainAtCam = Math.max(rainAtCam, cAt * cell.alpha * (cell.typhoon ? 1.4 : 1));
      }
      for (const f of cell.fogs) f.material.opacity = 0.5 * cell.alpha * (0.7 + 0.3 * Math.sin(t * 0.5 + f.position.x));
      if (Math.hypot(cell.x, cell.z) > SIZE * 1.45 && (cell.x * windX + cell.z * windZ) > 0) recycleCell(cell, false);  // cruzó → recicla
    }
    // oscurece el cielo/luces mientras una tormenta cubre la isla (updateSky ya corrió → multiplicamos)
    if (storm > 0.01) {
      sunLight.intensity *= 1 - 0.75 * storm;
      hemiLight.intensity *= 1 - 0.45 * storm;
      renderer.toneMappingExposure *= 1 - 0.30 * storm;
    }
    // aguacero local alrededor de la cámara (solo si está cerca del suelo y bajo una celda lluviosa)
    const groundY = Math.max(0, heightAt(cpx, cpz));
    const lowEnough = THREE.MathUtils.clamp(1 - (camera.position.y - groundY) / (LR_V * 1.4), 0, 1);
    const lrI = rainAtCam * lowEnough;
    localRain.visible = lrI > 0.02;
    if (localRain.visible) {
      localRain.position.set(cpx, groundY, cpz);
      const arr = localRainGeo.attributes.position.array, fall = 130 * dt;
      for (let k = 1; k < arr.length; k += 3) { arr[k] -= fall; if (arr[k] < 0) arr[k] += LR_V; }
      localRainGeo.attributes.position.needsUpdate = true;
      localRainMat.opacity = Math.min(0.7, 0.7 * lrI);
    }
  }

  // ---- guardar / cargar isla (persistencia por semilla en localStorage) ----
  let toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;bottom:54px;left:50%;transform:translateX(-50%);z-index:40;' +
        'background:rgba(10,16,28,.85);color:#dfe9ff;border:1px solid rgba(160,190,255,.3);padding:8px 16px;' +
        'border-radius:10px;font:14px system-ui;backdrop-filter:blur(6px);transition:opacity .3s;pointer-events:none;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = '1';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1700);
  }
  // ---- (de)serialización de arrays grandes (altura cuantizada a Int16, biomas Uint8) en base64 ----
  function b64FromU8(u8) { let s = ''; const C = 0x8000; for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C)); return btoa(s); }
  function u8FromB64(b64) { const s = atob(b64), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
  function packHeights(arr) { const n = arr.length, i16 = new Int16Array(n); for (let i = 0; i < n; i++) { let v = Math.round(arr[i] * 50); i16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } return b64FromU8(new Uint8Array(i16.buffer)); }
  function unpackHeights(b64) { const u8 = u8FromB64(b64), i16 = new Int16Array(u8.buffer, 0, u8.length >> 1), f = new Float32Array(i16.length); for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 50; return f; }
  // semilla + ajustes (mínimo). La isla generada se reconstruye igual con esto.
  function currentIslandData() {
    return { seed: currentSeed, sizeKm: params.sizeKm, coverage: params.coverage, erosion: params.erosion,
      rivers: params.rivers, lakes: params.lakes, vegDensity: params.vegDensity };
  }
  // isla COMPLETA: además del seed/ajustes, guarda el relieve esculpido, los biomas pintados y lo colocado
  function islandFullData() {
    const d = currentIslandData();
    d.full = true;
    d.h = packHeights(height);
    d.b = b64FromU8(biomes);
    d.placed = placedRecords.map((r) => ({ key: r.key, x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2), rot: +r.rot.toFixed(3) }));
    return d;
  }
  function saveIsland() {
    if (currentSeed == null) { toast('Genera una isla primero'); return; }
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(islandFullData())); toast('Isla guardada ✓'); }
    catch (e) { toast('No se pudo guardar (¿espacio?)'); }
  }
  // reconstruye una isla a partir de sus datos guardados (incluye ediciones y assets si es "completa")
  function applyIslandData(data, quiet) {
    if (!data || typeof data.seed !== 'number') { if (!quiet) toast('Datos inválidos'); return false; }
    params.sizeKm = data.sizeKm ?? params.sizeKm;
    params.coverage = data.coverage ?? params.coverage;
    params.erosion = data.erosion ?? params.erosion;
    params.rivers = data.rivers ?? params.rivers;
    params.lakes = data.lakes ?? params.lakes;
    params.vegDensity = data.vegDensity ?? params.vegDensity;
    configureForSize();
    clearPlaced();
    buildTerrainMesh(data.seed >>> 0);                    // base por semilla
    if (data.full && data.h && data.b) {                  // aplica esculpido + biomas pintados
      const hh = unpackHeights(data.h), bb = u8FromB64(data.b);
      if (hh.length === height.length) height.set(hh);
      if (bb.length === biomes.length) biomes.set(bb);
      resetInstances(); propGrid.clear();
      scatterVegetationAll();                             // re-siembra según los biomas guardados
      refresh();                                          // re-malla + recolor + relieve
      spawnFauna(); buildShoreFoam();
    }
    if (Array.isArray(data.placed)) for (const r of data.placed) if (assetDefs[r.key]) placeAsset(r.key, r.x, r.y, r.z, r.rot);  // repone assets/animales
    applySizeToView();
    if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
    return true;
  }
  function loadIsland(quiet) {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { data = null; }
    if (!data || typeof data.seed !== 'number') { if (!quiet) toast('No hay isla guardada'); return false; }
    const ok = applyIslandData(data, quiet);
    if (ok && !quiet) toast('Isla cargada ✓');
    return ok;
  }
  // ---- biblioteca: varios mapas con nombre (semilla + ajustes) ----
  function readLib() { try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]') || []; } catch (e) { return []; } }
  function writeLib(arr) { try { localStorage.setItem(LIB_KEY, JSON.stringify(arr)); return true; } catch (e) { return false; } }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function saveNamedIsland() {
    if (currentSeed == null) { toast('Genera una isla primero'); return; }
    const lib = readLib();
    const name = (prompt('Nombre del mapa:', 'Isla ' + (lib.length + 1)) || '').trim();
    if (!name) return;
    lib.push(Object.assign({ name, ts: Date.now() }, islandFullData()));   // guarda la isla COMPLETA con sus ediciones
    if (writeLib(lib)) { toast('Guardado en biblioteca ✓'); refreshLibPanel(); } else toast('No se pudo guardar (¿espacio?)');
  }
  function refreshLibPanel() {
    if (!libEl) return;
    const lib = readLib();
    let html = '<div class="ap-head"><span>Mis mapas</span><button id="lib-close" title="Cerrar">✕</button></div><div id="lib-body">';
    if (!lib.length) html += '<div class="hintline">Aún no guardaste mapas.<br>Usa “💾 Guardar como…”.</div>';
    lib.forEach((m, i) => {
      html += `<div class="lib-item"><span class="lib-name" title="semilla ${m.seed} · ${m.sizeKm} km">${escapeHtml(m.name)}</span>` +
        `<span class="lib-actions"><button data-load="${i}" title="Cargar">📂</button>` +
        `<button data-del="${i}" title="Borrar">🗑️</button></span></div>`;
    });
    libEl.innerHTML = html + '</div>';
  }
  function openLibrary() { refreshLibPanel(); libEl.style.display = 'block'; }
  // backup PORTABLE a archivo (no depende del puerto/origen del navegador)
  const BACKUP_KEYS = [SAVE_KEY, LIB_KEY, 'evermark_settings_v1', 'evermark_zones_v1', 'evermark_sim_meta_buildEra'];
  function exportMaps() {
    const data = {};
    for (const k of [SAVE_KEY, LIB_KEY, 'evermark_settings_v1', 'evermark_zones_v1']) { const v = localStorage.getItem(k); if (v != null) data[k] = v; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = 'evermark-mapas-' + Date.now() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Mapas exportados ✓');
  }
  function importMaps() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader();
      r.onload = () => { try { const d = JSON.parse(r.result); for (const k in d) localStorage.setItem(k, d[k]); refreshLibPanel(); toast('Mapas importados ✓ — recargá la página'); } catch (e) { toast('Archivo inválido'); } };
      r.readAsText(f); };
    inp.click();
  }

  // ---- GUI ----
  const gui = new GUI({ title: CINE_MODE ? 'Evermark · Cinemática' : 'Mundo 3 · Constructor' });
  // mapas (útil en ambos modos): guardar/cargar
  gui.add({ save: saveIsland }, 'save').name('💾 Guardar isla (rápido)');
  gui.add({ load: () => loadIsland(false) }, 'load').name('📂 Cargar isla (rápido)');
  gui.add({ saveAs: saveNamedIsland }, 'saveAs').name('💾 Guardar como…');
  gui.add({ lib: openLibrary }, 'lib').name('📚 Mis mapas');
  gui.add({ exp: exportMaps }, 'exp').name('📤 Exportar mapas (backup)');
  gui.add({ imp: importMaps }, 'imp').name('📥 Importar mapas');
  // construcción: oculta en la sección Cinemática
  const fB = gui.addFolder('Construcción');
  fB.add(params, 'sizeKm', { '0.2 km': 0.2, '0.5 km': 0.5, '1 km': 1, '2 km': 2, '5 km': 5 }).name('Tamaño del mapa').onChange(setSize);
  fB.add(params, 'coverage', 5, 70, 1).name('% tierra (cobertura)');
  fB.add(params, 'erosion', 0, 1, 0.05).name('Erosión (al generar)');
  fB.add(params, 'rivers', 0, 8, 1).name('Ríos (al generar)');
  fB.add(params, 'lakes', 0, 6, 1).name('Lagos (al generar)');
  fB.add(params, 'mode', ['Subir', 'Bajar', 'Suavizar', 'Aplanar']).name('Herramienta (esculpir)');
  brushCtrl = fB.add(params, 'brushSize', 3, 200, 1).name('Tamaño pincel (m)').onChange(resizeRing);
  fB.add(params, 'strength', 0.1, 3, 0.1).name('Fuerza');
  fB.add(params, 'vegDensity', 0.2, 4, 0.1).name('Densidad vegetación');
  fB.add(params, 'vegDist', 200, 3000, 50).name('Distancia veg. (m)').onChange(() => { instDirty = true; });
  fB.add({ gen: generateRandom }, 'gen').name('🎲 Generar isla aleatoria');
  fB.add({ sow: scatterAssets }, 'sow').name('🌱 Sembrar assets');
  fB.add({ clr: clearPlaced }, 'clr').name('🧹 Limpiar assets');
  fB.add({ plano: flat }, 'plano').name('Vaciar a mar');
  fB.add(params, 'mar').name('Mostrar mar').onChange((v) => { water.visible = v; });
  fB.add(params, 'wireframe').name('Malla').onChange((v) => { mesh.material.wireframe = v; });
  fB.add(params, 'heatmap').name('🗺️ Relieve (heatmap)').onChange((v) => { recolorAll(); legendEl.style.display = v ? 'block' : 'none'; });
  if (CINE_MODE || MANAGE_MODE || VIEW_MODE) fB.hide();
  gui.add({ mg: () => humanSys && humanSys.togglePanel() }, 'mg').name('🏝️ Gestión (followers)');
  const fDN = gui.addFolder('Día / Noche');
  const timeCtrl = fDN.add(params, 'timeOfDay', 0, 24, 0.01).name('Hora').onChange(updateSky);
  fDN.add(params, 'daySeconds', 10, 600, 5).name('Duración del día (s)');
  fDN.add(params, 'dayCycle').name('Ciclo automático');
  const moonCtrl = fDN.add(params, 'moonPhase', 0, 1, 0.001).name('Fase lunar').onChange(updateSky);
  fDN.add(params, 'moonCycle').name('Avanzar fases');
  fDN.open();
  const fCL = gui.addFolder('Clima / Estaciones');
  const seasonCtrl = fCL.add(params, 'season', 0, 1, 0.001).name('Estación').onChange(() => { applySeasonVisuals(); recolorAll(); });
  fCL.add(params, 'seasonCycle').name('Ciclo de estaciones');
  fCL.add(params, 'seasonSeconds', 30, 1200, 10).name('Duración del año (s)');
  fCL.add(params, 'weather').name('Clima localizado');
  fCL.add(params, 'weatherAmount', 0, 1, 0.05).name('Nubosidad');
  fCL.add(params, 'windSpeed', 0, 1, 0.05).name('Viento (mece árboles/olas)');
  fCL.add(params, 'shoreWaves').name('Olas de orilla');
  fCL.add({ storm: forceStorm }, 'storm').name('⛈️ Tormenta ahora');
  fCL.add({ clear: clearSky }, 'clear').name('☀️ Despejar cielo');
  fCL.open();
  // escenas de cámara scripted: capturás planos (cámara + hora + estación) y se reproducen interpolados
  const fCM = gui.addFolder('🎬 Cinemática');
  fCM.add({ fly: toggleCinematic }, 'fly').name('Vuelo automático (Full HD)');
  fCM.add({ cap: captureSceneKey }, 'cap').name('➕ Capturar plano');
  fCM.add(params, 'sceneSegSecs', 1, 12, 0.5).name('Segundos por plano');
  fCM.add(params, 'cineFormat', ['1080p 16:9', '1440p 16:9', '720p 16:9', 'Vertical 9:16', 'Cuadrado 1:1', 'Cine 21:9', 'Clásico 4:3', 'Personalizado']).name('Formato grabación');
  fCM.add(params, 'filter', Object.keys(GRADE_PRESETS)).name('Filtro (look)').onChange(applyFilter);
  fCM.add({ play: () => playScene(false) }, 'play').name('▶ Reproducir escena');
  fCM.add({ rec: () => playScene(true) }, 'rec').name('● Reproducir y grabar (webm)');
  fCM.add({ mp4: renderSceneMP4 }, 'mp4').name('🎬 Renderizar MP4 (offline, sin lag)');
  fCM.add({ free: recToggle }, 'free').name('● Grabar libre (on/off)');
  fCM.add({ stop: stopScene }, 'stop').name('⏹ Detener');
  fCM.add({ clr: clearScene }, 'clr').name('🗑 Limpiar escena');
  if (CINE_MODE) fCM.hide();   // en la sección Cinemática usamos el panel izquierdo dedicado
  gui.onChange(saveSettings);  // cualquier cambio en el panel se guarda (la última selección queda fija)

  // reloj + nombre de la fase lunar en pantalla
  const clockEl = document.createElement('div');
  clockEl.id = 'daynight-hud';
  clockEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:24;' +
    'font-family:system-ui,sans-serif;font-size:13px;color:#dfe9ff;background:rgba(10,16,28,.6);' +
    'border:1px solid rgba(160,190,255,.25);border-radius:10px;padding:6px 14px;backdrop-filter:blur(6px);' +
    'pointer-events:none;letter-spacing:.3px;';
  document.body.appendChild(clockEl);
  const PHASE_NAMES = ['🌑 Luna nueva', '🌒 Creciente', '🌓 Cuarto creciente', '🌔 Gibosa creciente',
    '🌕 Luna llena', '🌖 Gibosa menguante', '🌗 Cuarto menguante', '🌘 Menguante'];
  function updateClockHud() {
    const hf = params.timeOfDay, h = hf | 0, m = (hf - h) * 60 | 0;
    const phase = PHASE_NAMES[Math.round(params.moonPhase * 8) % 8];
    clockEl.textContent = `🕑 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}  ·  ${phase}  ·  ${seasonName()}`;
  }

  // leyenda del heatmap de relieve (se muestra solo con la vista activa)
  const legendEl = document.createElement('div');
  legendEl.id = 'relief-legend';
  legendEl.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:24;display:none;' +
    'font-family:system-ui,sans-serif;font-size:12px;color:#e7eefc;background:rgba(10,16,28,.7);' +
    'border:1px solid rgba(160,190,255,.25);border-radius:10px;padding:8px 12px;backdrop-filter:blur(6px);';
  legendEl.innerHTML = '<div style="opacity:.7;margin-bottom:5px;letter-spacing:.5px;">RELIEVE</div>' +
    RELIEF_CLASSES.map((name, k) => {
      const c = RELIEF_COLORS[k];
      return `<div style="display:flex;align-items:center;gap:7px;margin:2px 0;">` +
        `<span style="width:13px;height:13px;border-radius:3px;background:rgb(${c[0]},${c[1]},${c[2]});"></span>${name}</div>`;
    }).join('');
  document.body.appendChild(legendEl);

  // ===== CINEMÁTICA: recorrido automático en 16:9 1080p para grabar (oculta toda la UI) =====
  let cinematic = false, cineT = 0, cineHintT = 0;
  const _cineSaved = {};
  const _camGoal = new THREE.Vector3(), _camLook = new THREE.Vector3();
  const cineHint = document.createElement('div');
  cineHint.id = 'cine-hint';
  cineHint.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:60;display:none;' +
    'font-family:system-ui,sans-serif;font-size:13px;color:#fff;background:rgba(0,0,0,.45);' +
    'border-radius:20px;padding:7px 18px;backdrop-filter:blur(4px);transition:opacity .8s;pointer-events:none;';
  cineHint.textContent = '🎬 Cinemática · Esc para salir · C para alternar';
  document.body.appendChild(cineHint);
  // formatos de cámara/grabación (ancho × alto del buffer interno)
  const CINE_FORMATS = {
    '1080p 16:9': [1920, 1080], '1440p 16:9': [2560, 1440], '720p 16:9': [1280, 720],
    'Vertical 9:16': [1080, 1920], 'Cuadrado 1:1': [1080, 1080], 'Cine 21:9': [2560, 1080],
    'Clásico 4:3': [1440, 1080], 'Personalizado': null,
  };
  function cineSize() {
    const p = CINE_FORMATS[params.cineFormat];
    if (p) return p;
    return [Math.max(64, params.cineW | 0), Math.max(64, params.cineH | 0)];   // personalizado
  }
  function fitLetterbox(aspect) {                       // encaja el canvas (aspect dado) centrado con barras negras
    const cv = renderer.domElement;
    let w = innerWidth, ht = innerWidth / aspect;
    if (ht > innerHeight) { ht = innerHeight; w = innerHeight * aspect; }
    cv.style.position = 'fixed';
    cv.style.width = w + 'px'; cv.style.height = ht + 'px';
    cv.style.left = ((innerWidth - w) / 2) + 'px';
    cv.style.top = ((innerHeight - ht) / 2) + 'px';
  }
  function enterCinematic() {
    if (cinematic) return;
    cinematic = true; cineT = 0; cineHintT = 3.5;
    _cineSaved.cam = camera.position.clone();
    _cineSaved.target = controls.target.clone();
    _cineSaved.aspect = camera.aspect;
    _cineSaved.cv = renderer.domElement.style.cssText;
    _cineSaved.bg = document.body.style.background;
    _cineSaved.dpr = renderer.getPixelRatio();
    _cineSaved.vegDist = params.vegDist;
    params.vegDist = SIZE * 4; instDirty = true;        // no ocultar vegetación por lejanía durante la grabación
    controls.enabled = false;
    if (paletteEl) paletteEl.style.display = 'none';
    if (cinePanel) cinePanel.style.display = 'none';
    gui.hide(); clockEl.style.display = 'none'; legendEl.style.display = 'none';
    if (libEl) libEl.style.display = 'none';
    ring.visible = false;
    const back = document.getElementById('back'); if (back) back.style.display = 'none';
    const hintEl = document.getElementById('hint'); if (hintEl) hintEl.style.display = 'none';
    document.body.style.background = '#000';
    const [cw, ch] = cineSize();
    renderer.setPixelRatio(1);                         // buffer interno exacto al formato elegido
    renderer.setSize(cw, ch, false);
    composer.setPixelRatio(1); composer.setSize(cw, ch);
    camera.aspect = cw / ch; camera.updateProjectionMatrix();
    fitLetterbox(cw / ch);
    cineHint.style.display = 'block'; cineHint.style.opacity = '1';
  }
  function exitCinematic() {
    if (!cinematic) return;
    cinematic = false;
    controls.enabled = true;
    if (paletteEl && !CINE_MODE) paletteEl.style.display = '';
    if (cinePanel && CINE_MODE) cinePanel.style.display = '';
    gui.show(); clockEl.style.display = '';
    legendEl.style.display = params.heatmap ? 'block' : 'none';
    const back = document.getElementById('back'); if (back) back.style.display = 'block';
    document.body.style.background = _cineSaved.bg || '';
    renderer.domElement.style.cssText = _cineSaved.cv || '';
    renderer.setPixelRatio(_cineSaved.dpr || 1);
    renderer.setSize(innerWidth, innerHeight, true);
    composer.setPixelRatio(_cineSaved.dpr || 1); composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    camera.position.copy(_cineSaved.cam);
    controls.target.copy(_cineSaved.target);
    controls.update();
    if (_cineSaved.vegDist != null) { params.vegDist = _cineSaved.vegDist; instDirty = true; }
    cineHint.style.display = 'none';
  }
  function toggleCinematic() { cinematic ? exitCinematic() : enterCinematic(); }
  // ---- grabación de video: captura el canvas a WebM y lo descarga (MediaRecorder) ----
  let mediaRec = null, recChunks = [];
  function startRecording() {
    if (mediaRec) return;
    if (typeof MediaRecorder === 'undefined' || !renderer.domElement.captureStream) { toast('Tu navegador no soporta grabar'); return; }
    try {
      const stream = renderer.domElement.captureStream(60);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      mediaRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16000000 });
      recChunks = [];
      mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      mediaRec.onstop = () => {
        const blob = new Blob(recChunks, { type: 'video/webm' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'evermark-' + Date.now() + '.webm'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        mediaRec = null;
      };
      mediaRec.start();
      toast('● Grabando…');
    } catch (e) { toast('No se pudo grabar'); mediaRec = null; }
  }
  function stopRecording() { if (mediaRec && mediaRec.state !== 'inactive') { mediaRec.stop(); toast('🎞️ Video descargado ✓'); } }
  function recToggle() {                                // grabación libre (sin escena): graba lo que se ve
    if (mediaRec) { stopRecording(); exitCinematic(); }
    else { enterCinematic(); startRecording(); }
  }
  function cineUpdate(dt) {                            // autopiloto: órbita amplia que mantiene TODA la isla en cuadro
    cineT += dt; const t = cineT, SZ = SIZE || 1000;
    const peak = Math.max(LAND_MAX, SZ * 0.12);
    const az = t * 0.10;
    const radius = SZ * (0.72 + 0.30 * Math.sin(t * 0.045));   // se acerca y se aleja
    const elev = SZ * (0.16 + 0.26 * (0.5 + 0.5 * Math.sin(t * 0.07 + 1.0)));   // sube y baja
    const cx = Math.cos(az) * radius, cz = Math.sin(az) * radius;
    _camGoal.set(cx, elev, cz);
    const gy = Math.max(0, heightAt(cx, cz)) + SZ * 0.02 + 4;  // nunca atraviesa el terreno
    if (_camGoal.y < gy) _camGoal.y = gy;
    camera.position.lerp(_camGoal, 1 - Math.pow(0.0015, dt));  // suavizado independiente de fps
    _camLook.set(Math.sin(t * 0.06) * SZ * 0.10, peak * 0.32, Math.cos(t * 0.08) * SZ * 0.10);
    camera.lookAt(_camLook);
    if (cineHintT > 0) { cineHintT -= dt; if (cineHintT <= 0) cineHint.style.opacity = '0'; }
  }
  const onCineKey = (e) => {
    if (e.code === 'Escape' && (cinematic || scenePlaying)) { stopScene(); exitCinematic(); e.stopImmediatePropagation(); }
    else if (e.code === 'KeyC' && !/input|textarea/i.test((e.target && e.target.tagName) || '')) toggleCinematic();
  };
  addEventListener('keydown', onCineKey, true);        // captura → corre antes del Esc del shell

  // ===== ESCENAS SCRIPTED: capturás keyframes (cámara + hora + estación + clima) y se reproducen interpolados =====
  let scenePlaying = false, sceneT = 0, sceneCurve = null, sceneRecord = false;
  const sceneKeys = [];
  function snapState() {   // estado actual completo para un keyframe
    return {
      pos: camera.position.clone(), tgt: controls.target.clone(),
      tod: params.timeOfDay, season: params.season, moon: params.moonPhase,
      weather: params.weatherAmount, wind: params.windSpeed,
    };
  }
  function applyState(k) { // coloca cámara + clima como el keyframe (para previsualizar/editar)
    camera.position.copy(k.pos); controls.target.copy(k.tgt); controls.update();
    params.timeOfDay = k.tod; params.season = k.season; params.moonPhase = k.moon;
    params.weatherAmount = k.weather; params.windSpeed = k.wind;
    applySeasonVisuals(); updateSky();
    if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
  function captureSceneKey() { sceneKeys.push(snapState()); refreshCinePanel(); toast('🎬 Keyframe ' + sceneKeys.length); }
  function gotoSceneKey(i) { if (sceneKeys[i]) applyState(sceneKeys[i]); }
  function delSceneKey(i) { sceneKeys.splice(i, 1); refreshCinePanel(); }
  function clearScene() { sceneKeys.length = 0; scenePlaying = false; refreshCinePanel(); toast('Escena vaciada'); }
  function stopScene() {
    if (!scenePlaying) return;
    scenePlaying = false;
    if (sceneRecord) { sceneRecord = false; stopRecording(); exitCinematic(); } else controls.enabled = true;
  }
  function playScene(record) {
    if (sceneKeys.length < 2) { toast('Capturá al menos 2 keyframes (➕)'); return; }
    sceneCurve = new THREE.CatmullRomCurve3(sceneKeys.map((k) => k.pos.clone()), false, 'catmullrom', 0.5);
    scenePlaying = true; sceneT = 0; controls.enabled = false;
    sceneRecord = !!record;
    if (record) { enterCinematic(); startRecording(); }   // encuadre limpio + grabación a video
  }
  function sceneUpdate(dt) {
    const total = Math.max(0.1, (sceneKeys.length - 1) * params.sceneSegSecs);
    sceneT += dt;
    const u = Math.min(1, sceneT / total);
    camera.position.copy(sceneCurve.getPoint(u));
    const f = u * (sceneKeys.length - 1), i = Math.min(sceneKeys.length - 2, Math.floor(f)), k = f - i;
    const a = sceneKeys[i], b = sceneKeys[i + 1];
    _camLook.copy(a.tgt).lerp(b.tgt, k); camera.lookAt(_camLook);
    params.timeOfDay = (a.tod + (b.tod - a.tod) * k + 24) % 24;          // hora, estación y clima también se interpolan
    params.season = a.season + (b.season - a.season) * k;
    params.moonPhase = a.moon + (b.moon - a.moon) * k;
    params.weatherAmount = a.weather + (b.weather - a.weather) * k;
    params.windSpeed = a.wind + (b.wind - a.wind) * k;
    if (u >= 1) stopScene();
  }

  // init: si hay una isla guardada, se recrea idéntica; si no, una aleatoria nueva
  configureForSize();
  if (!loadIsland(true)) buildTerrainMesh();
  applySizeToView();
  loadZones(); recolorAll();        // restaura zonas pintadas y las muestra
  updateSky(); updateClockHud();

  // ---- panel de assets ----
  const style = document.createElement('style');
  style.textContent = `
    #asset-palette { position: fixed; top: 64px; left: 16px; z-index: 24; width: 184px;
      max-height: calc(100vh - 84px); overflow-y: auto;
      background: rgba(10,16,28,.6); border: 1px solid rgba(160,190,255,.25); border-radius: 12px;
      padding: 10px; backdrop-filter: blur(6px); font-family: system-ui, sans-serif; }
    #asset-palette h4:not(:first-child) { margin-top: 12px; }
    #asset-palette h4 { color: #cfe0ff; font-size: 12px; letter-spacing: .5px; margin: 2px 4px 8px;
      text-transform: uppercase; opacity: .8; }
    #asset-palette h5 { color: #9db6e6; font-size: 10.5px; letter-spacing: .4px; margin: 9px 4px 4px;
      text-transform: uppercase; opacity: .65; font-weight: 600; }
    #asset-palette button { display: block; width: 100%; text-align: left; margin: 4px 0; cursor: pointer;
      background: rgba(40,60,95,.5); color: #e7eefc; border: 1px solid transparent; border-radius: 8px;
      padding: 8px 10px; font-size: 14px; transition: background .12s, border-color .12s; }
    #asset-palette button:hover { background: rgba(60,90,150,.6); }
    #asset-palette button.sel { border-color: #7CFF9B; background: rgba(50,100,70,.6); }
    #asset-palette .hintline { color: #9fb4d4; font-size: 11px; margin: 8px 4px 2px; line-height: 1.35; }
    #asset-palette .ap-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: -2px 0 6px; }
    #asset-palette .ap-head span { color: #cfe0ff; font-size: 12px; letter-spacing: .5px; text-transform: uppercase; opacity: .85; font-weight: 600; }
    #asset-palette #ap-toggle { width: 28px; flex: 0 0 auto; margin: 0; padding: 3px 0; text-align: center; font-size: 13px; }
    #asset-palette.collapsed { width: auto; }
    #asset-palette.collapsed #ap-body { display: none; }
    #asset-palette .sec-h { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; }
    #asset-palette .sec-arrow { font-size: 9px; opacity: .65; width: 9px; flex: 0 0 auto; }
    #asset-palette .sec.collapsed .sec-c { display: none; }
    #map-library { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 30; width: 280px;
      max-height: calc(100vh - 120px); overflow-y: auto; display: none;
      background: rgba(10,16,28,.85); border: 1px solid rgba(160,190,255,.3); border-radius: 12px;
      padding: 12px; backdrop-filter: blur(8px); font-family: system-ui, sans-serif; color: #e7eefc; }
    #map-library .ap-head span { color: #cfe0ff; font-size: 13px; letter-spacing: .5px; text-transform: uppercase; opacity: .85; font-weight: 600; }
    #map-library #lib-close { width: 30px; padding: 3px 0; margin: 0; cursor: pointer; text-align: center;
      background: rgba(40,60,95,.5); color: #e7eefc; border: 1px solid transparent; border-radius: 8px; }
    #map-library .ap-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    #map-library .lib-item { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: rgba(40,60,95,.4); border-radius: 8px; padding: 7px 10px; margin: 5px 0; }
    #map-library .lib-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #map-library .lib-actions { flex: 0 0 auto; display: flex; gap: 4px; }
    #map-library .lib-actions button { cursor: pointer; background: rgba(60,90,150,.5); color: #e7eefc;
      border: 1px solid transparent; border-radius: 7px; padding: 5px 8px; font-size: 13px; }
    #map-library .lib-actions button:hover { background: rgba(80,120,190,.7); }
    #map-library .hintline { color: #9fb4d4; font-size: 12px; line-height: 1.4; }
    #cine-panel { position: fixed; top: 64px; left: 16px; z-index: 24; width: 220px;
      max-height: calc(100vh - 84px); overflow-y: auto;
      background: rgba(10,16,28,.62); border: 1px solid rgba(160,190,255,.25); border-radius: 12px;
      padding: 10px; backdrop-filter: blur(6px); font-family: system-ui, sans-serif; color: #e7eefc; }
    #cine-panel .ap-head span { color: #cfe0ff; font-size: 13px; letter-spacing: .5px; text-transform: uppercase; opacity: .85; font-weight: 600; }
    #cine-panel button { display: block; width: 100%; text-align: left; margin: 5px 0; cursor: pointer;
      background: rgba(40,60,95,.5); color: #e7eefc; border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    #cine-panel button:hover { background: rgba(60,90,150,.6); }
    #cine-panel .cine-seg { font-size: 12px; color: #b9c8e0; margin: 8px 2px; display: flex; align-items: center; gap: 6px; }
    #cine-panel .cine-seg input { width: 60px; background: rgba(40,60,95,.5); color: #e7eefc; border: 1px solid rgba(160,190,255,.2); border-radius: 6px; padding: 3px 6px; }
    #cine-panel .cine-kf { display: flex; align-items: center; justify-content: space-between; gap: 6px;
      background: rgba(40,60,95,.4); border-radius: 8px; padding: 5px 8px; margin: 3px 0; font-size: 12px; }
    #cine-panel .cine-kf .ka { flex: 0 0 auto; display: flex; gap: 3px; }
    #cine-panel .cine-kf .ka button { width: auto; margin: 0; padding: 3px 7px; }
    #cine-panel .hintline { color: #9fb4d4; font-size: 11px; margin-top: 8px; line-height: 1.35; }
    #cine-panel .play { background: rgba(50,110,70,.6); }
    #cine-panel .rec { background: rgba(140,50,55,.6); }
  `;
  document.head.appendChild(style);
  paletteEl = document.createElement('div');
  paletteEl.id = 'asset-palette';
  // cada sección (h4/h5) es plegable: la cabecera con ▾/▸ colapsa su contenido
  const sec = (title, lvl, inner) =>
    `<div class="sec"><${lvl} class="sec-h"><span class="sec-arrow">▾</span>${title}</${lvl}><div class="sec-c">${inner}</div></div>`;
  let h = '<div class="ap-head"><span>Paleta</span><button id="ap-toggle" title="Colapsar/expandir todo">▾</button></div><div id="ap-body">';
  h += sec('Herramienta', 'h4', '<button data-id="nav">🧭 Navegar (no editar)</button><button data-id="sculpt">✋ Esculpir</button>');
  let biomeBtns = biomeKeys.map((k, n) => `<button data-id="b:${n + 1}">${BIOMES[k].label}</button>`).join('');
  biomeBtns += '<button data-id="b:0">🧽 Borrar bioma</button>';
  h += sec('Pintar bioma', 'h4', biomeBtns);
  let assetInner = '';
  for (const grp of assetGroups) {
    let btns = '';
    for (const k of grp.keys) if (assetDefs[k]) btns += `<button data-id="a:${k}">${assetDefs[k].label}</button>`;
    assetInner += sec(grp.title, 'h5', btns);
  }
  h += sec('Colocar asset', 'h4', assetInner);
  h += '<div class="hintline">Elige una herramienta y usa clic-izquierdo sobre el terreno.</div></div>';
  paletteEl.innerHTML = h;
  document.body.appendChild(paletteEl);
  if (CINE_MODE || MANAGE_MODE || VIEW_MODE) paletteEl.style.display = 'none';   // estas secciones no editan el terreno
  const onPaletteClick = (e) => {
    const head = e.target.closest('.sec-h');          // clic en cabecera de sección → plega/expande
    if (head) {
      const sc = head.parentElement.classList.toggle('collapsed');
      const ar = head.querySelector('.sec-arrow'); if (ar) ar.textContent = sc ? '▸' : '▾';
      return;
    }
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'ap-toggle') {                        // colapsar/expandir toda la paleta
      const col = paletteEl.classList.toggle('collapsed');
      b.textContent = col ? '▸' : '▾';
      return;
    }
    const id = b.dataset.id;
    if (id === 'nav') setSel('nav', null);
    else if (id === 'sculpt') setSel('sculpt', null);
    else if (id.startsWith('b:')) setSel('biome', parseInt(id.slice(2), 10));
    else if (id.startsWith('a:')) setSel('asset', id.slice(2));
  };
  paletteEl.addEventListener('click', onPaletteClick);
  setSel('nav', null);

  // panel de biblioteca de mapas guardados
  const libEl = document.createElement('div');
  libEl.id = 'map-library';
  document.body.appendChild(libEl);
  libEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'lib-close') { libEl.style.display = 'none'; return; }
    if (b.dataset.load != null) {
      const m = readLib()[+b.dataset.load];
      if (m && applyIslandData(m, false)) { toast('“' + m.name + '” cargado ✓'); libEl.style.display = 'none'; }
      return;
    }
    if (b.dataset.del != null) {
      const lib = readLib(), m = lib[+b.dataset.del];
      if (m && confirm('¿Borrar “' + m.name + '”?')) { lib.splice(+b.dataset.del, 1); writeLib(lib); refreshLibPanel(); }
    }
  });

  // ---- panel IZQUIERDO de Cinemática: recorrido por keyframes ----
  const cinePanel = document.createElement('div');
  cinePanel.id = 'cine-panel';
  cinePanel.innerHTML =
    '<div class="ap-head"><span>🎬 Cinemática</span></div>' +
    '<button data-cine="add">➕ Añadir keyframe</button>' +
    '<div class="cine-seg">Seg/tramo <input id="cine-seg" type="number" min="1" max="20" step="0.5" value="' + params.sceneSegSecs + '"></div>' +
    '<div class="cine-seg">Formato <select id="cine-fmt">' +
      Object.keys(CINE_FORMATS).map((f) => `<option${f === params.cineFormat ? ' selected' : ''}>${f}</option>`).join('') +
    '</select></div>' +
    '<div class="cine-seg">Filtro <select id="cine-flt">' +
      Object.keys(GRADE_PRESETS).map((f) => `<option${f === params.filter ? ' selected' : ''}>${f}</option>`).join('') +
    '</select></div>' +
    '<div id="cine-list"></div>' +
    '<button class="rec" data-cine="mp4">🎬 Renderizar MP4 (sin lag)</button>' +
    '<button class="play" data-cine="play">▶ Play (previo)</button>' +
    '<button class="rec" data-cine="rec">● Play + Grabar (webm)</button>' +
    '<button data-cine="stop">⏹ Stop</button>' +
    '<button class="rec" data-cine="freerec">● Grabar libre (on/off)</button>' +
    '<button data-cine="fly">🛰 Vuelo automático</button>' +
    '<button data-cine="clear">🗑 Limpiar</button>' +
    '<div class="hintline">Orbitá con clic-DER y ajustá clima/hora; “➕” fija un keyframe. “Renderizar MP4” codifica cuadro a cuadro: fluido aunque la PC vaya lenta.</div>';
  document.body.appendChild(cinePanel);
  if (!CINE_MODE) cinePanel.style.display = 'none';
  const cineListEl = cinePanel.querySelector('#cine-list');
  function refreshCinePanel() {
    if (!cineListEl) return;
    cineListEl.innerHTML = sceneKeys.map((k, i) => {
      const hh = k.tod | 0, mm = (k.tod - hh) * 60 | 0;
      const seas = ['🌸', '☀️', '🍂', '❄️'][Math.min(3, Math.floor((((k.season % 1) + 1) % 1) * 4))];
      return `<div class="cine-kf"><span>KF ${i + 1} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${seas}</span>` +
        `<span class="ka"><button data-go="${i}" title="Ir a este keyframe">⤿</button><button data-del="${i}" title="Borrar">✕</button></span></div>`;
    }).join('');
  }
  cinePanel.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.go != null) { gotoSceneKey(+b.dataset.go); return; }
    if (b.dataset.del != null) { delSceneKey(+b.dataset.del); return; }
    const act = b.dataset.cine;
    if (act === 'add') captureSceneKey();
    else if (act === 'play') playScene(false);
    else if (act === 'rec') playScene(true);
    else if (act === 'mp4') renderSceneMP4();
    else if (act === 'stop') stopScene();
    else if (act === 'freerec') recToggle();
    else if (act === 'fly') toggleCinematic();
    else if (act === 'clear') clearScene();
  });
  cinePanel.querySelector('#cine-seg').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) params.sceneSegSecs = v; });
  cinePanel.querySelector('#cine-flt').addEventListener('change', (e) => { params.filter = e.target.value; applyFilter(); });
  cinePanel.querySelector('#cine-fmt').addEventListener('change', (e) => {
    params.cineFormat = e.target.value;
    if (params.cineFormat === 'Personalizado') {
      const s = (prompt('Resolución (ancho x alto):', params.cineW + 'x' + params.cineH) || '').toLowerCase().split('x');
      const w = parseInt(s[0], 10), ht = parseInt(s[1], 10);
      if (w > 0 && ht > 0) { params.cineW = w; params.cineH = ht; }
    }
  });
  refreshCinePanel();

  // un paso de simulación (reutilizable en tiempo real y en el render offline)
  let offlineRendering = false, humanSys = null;
  function stepWorld(dt) {
    if (params.dayCycle && !scenePlaying) { params.timeOfDay = (params.timeOfDay + dt * 24 / params.daySeconds) % 24; if (!offlineRendering) timeCtrl.updateDisplay(); }
    if (params.moonCycle) { params.moonPhase = (params.moonPhase + dt / (params.daySeconds * 29.5)) % 1; if (!offlineRendering) moonCtrl.updateDisplay(); }
    if (params.seasonCycle && !scenePlaying && !offlineRendering) seasonCtrl.updateDisplay();
    updateSky(); updateClockHud();
    water.material.uniforms.time.value += dt * 0.5;
    for (const lk of lakeWaters) lk.material.uniforms.time.value += dt * 0.4;
    riverNormals.offset.y -= dt * 0.25;
    riverNormals.offset.x = Math.sin(riverNormals.offset.y * 2) * 0.02;
    if (normalsDirty) { geo.computeVertexNormals(); normalsDirty = false; }
    updateFauna(dt); updateSeason(dt); updateFoam(faunaTime); updateWeather(dt, faunaTime);
    if (humanSys) humanSys.update(dt);   // followers: comportamiento día/noche
    if (scenePlaying) sceneUpdate(dt); else if (cinematic) cineUpdate(dt); else controls.update();
    cullInstances();
    const gy = Math.max(0, heightAt(camera.position.x, camera.position.z));
    if (camera.position.y < gy + 1.5) camera.position.y = gy + 1.5;
  }
  // RENDER OFFLINE a MP4: avanza con dt fijo y codifica cuadro a cuadro (fluido sin importar el rendimiento)
  async function renderSceneMP4() {
    if (sceneKeys.length < 2) { toast('Capturá al menos 2 keyframes'); return; }
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') { toast('Render MP4 requiere WebCodecs (Chrome/Edge)'); return; }
    let Muxer, ArrayBufferTarget;
    try { ({ Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.0.0/+esm')); }
    catch (e) { toast('No se pudo cargar el codificador MP4'); return; }
    enterCinematic();
    let [cw, ch] = cineSize(); cw &= ~1; ch &= ~1;       // H.264 requiere dimensiones pares
    const fps = 60, dt = 1 / fps;
    const total = Math.max(0.1, (sceneKeys.length - 1) * params.sceneSegSecs), frames = Math.ceil(total * fps);
    sceneCurve = new THREE.CatmullRomCurve3(sceneKeys.map((k) => k.pos.clone()), false, 'catmullrom', 0.5);
    scenePlaying = true; sceneT = 0; sceneRecord = false; controls.enabled = false;
    offlineRendering = true;
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: cw, height: ch }, fastStart: 'in-memory' });
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => console.error('VideoEncoder', e) });
    encoder.configure({ codec: 'avc1.640028', width: cw, height: ch, bitrate: 16000000, framerate: fps });
    try {
      for (let f = 0; f < frames; f++) {
        stepWorld(dt);
        renderFrame();
        const vf = new VideoFrame(renderer.domElement, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(vf, { keyFrame: f % 120 === 0 });
        vf.close();
        if (f % 10 === 0) { cineHint.style.display = 'block'; cineHint.style.opacity = '1'; cineHint.textContent = `🎞️ Renderizando ${Math.round(f / frames * 100)}%`; }
        await new Promise((r) => requestAnimationFrame(r));          // cede al navegador (no se congela)
        while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 0));   // RAM acotada
      }
      await encoder.flush(); muxer.finalize();
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'evermark-' + Date.now() + '.mp4'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 6000);
      toast('🎬 MP4 renderizado ✓');
    } catch (e) { console.error(e); toast('Error renderizando MP4'); }
    try { encoder.close(); } catch (e) {}
    offlineRendering = false; scenePlaying = false; exitCinematic();
  }

  // ---- followers / humanos (simulación con DB) ----
  try {
    humanSys = await createHumanSystem({
      scene, camera, controls, heightAt, groundAt: heightBilinear, findReliefSpots, terrainClassAt, zoneSpots, SIZE, toast,
      getTime: () => params.timeOfDay, cullDist: SIZE * 0.6, viewOnly: VIEW_MODE,
      onReset: () => { if (zones) zones.fill(0); zoneCounts[0] = zoneCounts[1] = zoneCounts[2] = 0; zonesDirty = true; saveZones(); recolorAll(); },
    });
    if (MANAGE_MODE || VIEW_MODE) humanSys.showPanel();
  } catch (e) { console.error('humanSys', e); }

  // ---- menú de CONSTRUCCIÓN (modo gestión): pintar zonas dónde se permite construir + etapa ----
  let buildToolsEl = null;
  if (MANAGE_MODE) {
    params.brushSize = Math.max(3, Math.round(SIZE / 70)); resizeRing(); brushCtrl?.updateDisplay();   // pincel chico para zonas
    camera.position.set(0, SIZE * 0.95, SIZE * 0.32); controls.target.set(0, 0, 0); controls.update();  // vista más de arriba
    buildToolsEl = document.createElement('div');
    buildToolsEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:27;display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:92vw;' +
      'background:rgba(10,16,28,.72);border:1px solid rgba(160,190,255,.25);border-radius:10px;padding:7px 12px;backdrop-filter:blur(6px);font-family:system-ui,sans-serif;color:#e7eefc;font-size:13px;';
    const eras = ['Sin construir', 'Campamento (carpas)', 'Aldea (chozas)', 'Pueblo (cabañas)', 'Ciudad (casas)'];
    const bs = 'cursor:pointer;background:rgba(40,60,95,.6);color:#e7eefc;border:1px solid transparent;border-radius:7px;padding:5px 9px;font-size:13px;';
    buildToolsEl.innerHTML = '<b>🏗️</b>' +
      `<button style="${bs}" data-z="1">🏠 Residencia</button><button style="${bs}" data-z="2">🛠️ Servicios</button>` +
      `<button style="${bs}" data-z="0">🧽 Borrar</button><button style="${bs}" data-tool="arrival">📍 Llegada</button><button style="${bs}" data-z="nav">✋ Mover</button>` +
      `<label style="margin-left:2px;">pincel <input id="ct-brush" type="range" min="2" max="60" value="${params.brushSize}" style="width:74px;vertical-align:middle;"></label>` +
      `<label><input type="checkbox" id="ct-show" checked> ver zonas</label>` +
      `<span>Etapa</span><select id="ct-era" style="${bs}">` + eras.map((l, i) => `<option value="${i}"${i === (humanSys ? humanSys.getEra() : 0) ? ' selected' : ''}>${l}</option>`).join('') + '</select>' +
      `<button style="${bs}background:rgba(140,50,55,.6);" data-tool="reset">🗑 Reiniciar mundo</button>` +
      '<div id="ct-assets" style="width:100%;margin-top:2px;color:#b9c8e0;"></div>';
    document.body.appendChild(buildToolsEl);
    const renderAssets = () => {
      const el = buildToolsEl.querySelector('#ct-assets'); if (!el || !humanSys) return;
      const list = humanSys.eraAssets();
      el.innerHTML = list.length ? ('Permitir: ' + list.map((a) => `<label style="margin-right:8px;white-space:nowrap;"><input type="checkbox" data-a="${a.key}"${a.on ? ' checked' : ''}> ${a.label}</label>`).join('')) : '<i>elegí una etapa para permitir construcciones</i>';
    };
    buildToolsEl.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool === 'arrival') { setSel('arrival', null); return; }
      if (b.dataset.tool === 'reset') { if (confirm('¿Reiniciar el mundo? Se borran todos los followers, viviendas, fogatas, caminos y zonas.')) { humanSys && humanSys.resetAll(); toast('Mundo reiniciado'); } return; }
      const z = b.dataset.z; if (z === 'nav') setSel('nav', null); else setSel('zone', +z);
    });
    buildToolsEl.addEventListener('change', (e) => {
      if (e.target.id === 'ct-show') { params.showZones = e.target.checked; recolorAll(); }
      else if (e.target.id === 'ct-brush') { params.brushSize = +e.target.value; resizeRing(); brushCtrl?.updateDisplay(); }
      else if (e.target.id === 'ct-era') { humanSys && humanSys.setEra(+e.target.value); renderAssets(); toast(+e.target.value ? 'Etapa activada' : 'Construcción detenida'); }
      else if (e.target.dataset.a) { humanSys && humanSys.setAllowed(e.target.dataset.a, e.target.checked); }
    });
    renderAssets();
  }

  return {
    scene, camera, showHud: false, render: renderFrame,
    terrainClassAt, findReliefSpots,   // API de geomorfología (p.ej. fauna que anida en 'acantilado')
    hint: CINE_MODE
      ? 'Cinemática · clic-DER orbita para encuadrar · ➕ Capturar plano · ▶ Reproducir/grabar escena · Esc detiene'
      : VIEW_MODE
      ? 'Ver Mundo · buscá un follower y tocá 👁 para seguirlo · clic-DER orbita · rueda zoom'
      : MANAGE_MODE
      ? 'Isla · ➕ Agregá followers en el panel izquierdo · cada uno llega y vive su ciclo día/noche · clic-DER orbita'
      : 'Tamaño del mapa en el panel · clic-izq esculpe/coloca · clic-DER orbita · arrastrar rueda mueve · girar rueda zoom',
    update(dt) { if (!offlineRendering) stepWorld(dt); },   // durante el render offline lo maneja renderSceneMP4
    onResize(w, ht) {
      if (cinematic) { const [cw, ch] = cineSize(); renderer.setSize(cw, ch, false); composer.setSize(cw, ch); camera.aspect = cw / ch; camera.updateProjectionMatrix(); fitLetterbox(cw / ch); }
      else { camera.aspect = w / ht; camera.updateProjectionMatrix(); composer.setSize(w, ht); }
    },
    dispose() {
      if (cinematic) exitCinematic();   // restaura renderer/canvas antes de salir del mundo
      removeEventListener('keydown', onCineKey, true);
      cineHint?.remove();
      gui.destroy();
      controls.dispose();
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown);
      removeEventListener('pointerup', onUp);
      paletteEl?.remove();
      clockEl?.remove();
      legendEl?.remove();
      libEl?.remove();
      cinePanel?.remove();
      buildToolsEl?.remove();
      humanSys?.dispose();
      style.remove();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      });
    },
  };
}
