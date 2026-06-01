import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// MUNDO 3 — Constructor de terreno con tamaño elegible (hasta varios km).
// El lienzo es el océano: levantas tierra con el pincel y se forman playas/acantilados.
//   Clic-izq = esculpir/colocar · clic-DER = orbitar · arrastrar rueda = mover · girar rueda = zoom
export async function create({ renderer }) {
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
  };

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 200000);

  // cielo + sol
  const sky = new Sky(); sky.scale.setScalar(90000); scene.add(sky);
  sky.material.uniforms.turbidity.value = 5;
  sky.material.uniforms.rayleigh.value = 1.4;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.mieDirectionalG.value = 0.85;
  const sun = new THREE.Vector3();
  sun.setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(135));
  sky.material.uniforms.sunPosition.value.copy(sun);

  const sunLight = new THREE.DirectionalLight(0xfff2dd, 2.1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0004;
  scene.add(sunLight, sunLight.target);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x55633f, 0.7));

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
  const SAVE_KEY = 'evermark_island_v1';

  // ---- estado del terreno (depende del tamaño) ----
  let SIZE, SEG, N, CELL, LAND_MAX, SEA_FLOOR, STRENGTH_SCALE, BEACH_TOP;
  let geo = null, mesh = null, height = null, colors = null, posAttr = null, biomes = null, waterMask = null;
  let lakeMask = null;          // 1 en celdas de LAGO (agua dulce) → humedad más fuerte que los ríos
  let wetField = null;          // 0..1 proximidad al agua (alto cerca de agua, decae con la distancia)
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
  function propSpacing() { return Math.max(2.4, SIZE / 440); }

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
    if (waterMask && waterMask[idx]) { colors[o] = 0.13; colors[o + 1] = 0.28; colors[o + 2] = 0.38; return; } // lecho de río/lago
    if (h < 0) { rampColor(h, colors, o); return; }
    const i = idx % N, j = (idx / N) | 0;
    const b = biomes[idx];
    let r, g, bl;
    if (b > 0) { const c = BIOMES[biomeKeys[b - 1]].color; r = c[0]; g = c[1]; bl = c[2]; }
    else { const c = lerpStops(LAND_STOPS, Math.min(1, h / LAND_MAX)); r = c[0]; g = c[1]; bl = c[2]; }
    const rk = Math.min(1, Math.max(0, (slopeAt(i, j) - 0.5) / 0.8));   // 0 llano .. 1 acantilado
    r = r * (1 - rk) + ROCK_COL[0] * rk; g = g * (1 - rk) + ROCK_COL[1] * rk; bl = bl * (1 - rk) + ROCK_COL[2] * rk;
    const jit = 0.9 + 0.2 * hash(idx * 0.137, idx * 0.911);     // grano natural
    const shade = (1 - rk * 0.22) * jit;                        // laderas algo más oscuras
    colors[o] = (r / 255) * shade; colors[o + 1] = (g / 255) * shade; colors[o + 2] = (bl / 255) * shade;
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
      biomes[idx] = idxOf(b);
    }
  }
  function flat() { clearWater(); height.fill(SEA_FLOOR); biomes.fill(0); refresh(); }   // vacía a océano

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
  function computeWetField() {
    const f = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) {
      if (lakeMask[k]) f[k] = 1.0;           // lago: humedad fuerte y de largo alcance
      else if (waterMask[k]) f[k] = 0.72;    // río: un poquito menos vegetación que el lago
      else if (height[k] < 0) f[k] = 0.55;   // mar / costa sumergida
    }
    const decay = 0.9;
    for (let p = 0; p < 26; p++) {
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
    wetField = f;
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
  };

  // ---- vegetación INSTANCIADA en GPU con CULLING + LOD ----
  // Cada tipo guarda sus instancias en arrays planos (id lógico = índice, estable para editar/borrar).
  // Cada frame, si la cámara se movió, recomponemos SOLO lo visible:
  //   · frustum culling → no subimos a GPU lo que la cámara no ve
  //   · distancia máx.  → no dibujamos specks lejanos (params.vegDist)
  //   · LOD por distancia → muy cerca = modelo de alta calidad, cerca = medio, lejos = impostor ultra-lowpoly
  const UP = new THREE.Vector3(0, 1, 0);
  const INST_MAX = 60000;                              // capacidad lógica por tipo (arrays de instancias)
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
  let selKind = 'sculpt', selKey = null, paletteEl = null;
  function placeAsset(key, x, y, z) {
    const obj = assetDefs[key].make();
    obj.rotation.y = Math.random() * Math.PI * 2;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(x, y - box.min.y, z);
    scene.add(obj); placed.push(obj);
  }
  function clearPlaced() { for (const o of placed) scene.remove(o); placed = []; }

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

  function rgbHex(c) { return (c[0] << 16) | (c[1] << 8) | c[2]; }
  function setSel(kind, key) {
    selKind = kind; selKey = key;
    let col = 0xffe27a;                              // esculpir
    if (kind === 'asset') col = 0x7CFF9B;
    else if (kind === 'biome') col = key > 0 ? rgbHex(BIOMES[biomeKeys[key - 1]].color) : 0xff7a7a;
    ring.material.color.set(col);
    const selId = kind === 'sculpt' ? 'sculpt' : kind[0] + ':' + key;
    paletteEl?.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.id === selId));
  }

  const dom = renderer.domElement;
  const onMove = (ev) => {
    hovering = castToTerrain(ev);
    ring.visible = hovering;
    if (hovering) ring.position.set(hit.x, hit.y + 0.2, hit.z);
    if (sculpting && hovering) {
      if (selKind === 'biome') paintBiome(selKey);
      else if (selKind === 'sculpt') stroke();
    }
  };
  const onDown = (ev) => {
    if (ev.button !== 0) return;
    if (!castToTerrain(ev)) return;
    if (selKind === 'asset') placeAsset(selKey, hit.x, hit.y, hit.z);
    else if (selKind === 'biome') { sculpting = true; paintBiome(selKey); }
    else { sculpting = true; flattenTarget = hit.y; stroke(); }
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
  const whaleMat = new THREE.MeshStandardMaterial({ color: 0x35506b, roughness: 0.75, flatShading: true });
  const sharkMat = new THREE.MeshStandardMaterial({ color: 0x6e7b86, roughness: 0.7, flatShading: true });
  const dolphinMat = new THREE.MeshStandardMaterial({ color: 0x93a8bd, roughness: 0.55, flatShading: true });
  const spoutMat = new THREE.MeshStandardMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0.7, roughness: 0.4 });
  const fishMats = [
    new THREE.MeshStandardMaterial({ color: 0xc77b3a, roughness: 0.6, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x6f93b4, roughness: 0.6, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0xb9474a, roughness: 0.6, flatShading: true }),
  ];
  function buildBird() {                       // ave: cuerpo (cono) + 2 alas planas que aletean
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.4, 5), birdMat);
    body.rotation.x = -Math.PI / 2;            // punta hacia +z (frente del vuelo)
    const wGeo = new THREE.PlaneGeometry(2.3, 1.0);
    const mkWing = (sign) => {
      const pivot = new THREE.Group();
      const m = new THREE.Mesh(wGeo, birdMat);
      m.rotation.x = -Math.PI / 2;             // tumba el ala (plano horizontal)
      m.position.x = sign * 1.15;              // se extiende desde la raíz
      pivot.add(m); return pivot;
    };
    const lw = mkWing(-1), rw = mkWing(1);
    g.add(body, lw, rw);
    return { g, lw, rw };
  }
  function buildWhale() {                       // ballena: cuerpo (cápsula) + cola + soplido (oculto)
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(3.0, 12, 6, 12), whaleMat);
    body.rotation.z = Math.PI / 2;             // largo a lo largo de x (frente +x)
    body.scale.set(1, 0.78, 1);
    const tail = new THREE.Group(); tail.position.x = -8.5;
    const fl1 = new THREE.Mesh(new THREE.ConeGeometry(2.2, 0.5, 3), whaleMat);
    fl1.rotation.x = Math.PI / 2; fl1.position.z = 2.0; fl1.scale.set(1, 1, 0.4);
    const fl2 = fl1.clone(); fl2.position.z = -2.0; fl2.rotation.x = -Math.PI / 2;
    tail.add(fl1, fl2);
    const spout = new THREE.Group(); spout.position.set(5.5, 2.6, 0); spout.visible = false;
    for (let s = 0; s < 3; s++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 5), spoutMat); p.position.y = s * 1.4; spout.add(p); }
    g.add(body, tail, spout);
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
  function spawnFauna() {
    clearFauna();
    // --- AVES: bandada en círculos sobre la isla, a distintas alturas/radios ---
    const nB = 9 + (Math.random() * 6 | 0);
    for (let k = 0; k < nB; k++) {
      const b = buildBird(); b.g.scale.setScalar(1.3 + Math.random() * 1.8);
      faunaGroup.add(b.g);
      birds.push(Object.assign(b, {
        R: SIZE * (0.06 + Math.random() * 0.22),
        alt: Math.max(60, LAND_MAX * (0.9 + Math.random() * 1.4)),
        cx: (Math.random() - 0.5) * SIZE * 0.25, cz: (Math.random() - 0.5) * SIZE * 0.25,
        ang: Math.random() * 6.283, spd: (0.1 + Math.random() * 0.12) * (Math.random() < 0.5 ? -1 : 1),
        ph: Math.random() * 6.283, flap: 7 + Math.random() * 3,
      }));
    }
    // --- BALLENAS: BAJA probabilidad; orbitan en aguas profundas; salen a la superficie CADA TANTO ---
    // base ~18 m × escala 1.0-1.6 → 18-29 m (azul real ~25-33 m)
    const nW = Math.random() < 0.35 ? (1 + (Math.random() < 0.25 ? 1 : 0)) : 0;
    for (let k = 0; k < nW; k++) {
      const w = buildWhale(); w.g.scale.setScalar(1.0 + Math.random() * 0.6); w.g.visible = false;
      faunaGroup.add(w.g);
      whales.push(Object.assign(w, {
        R: SIZE * (0.40 + Math.random() * 0.06), ang: Math.random() * 6.283,
        spd: (0.02 + Math.random() * 0.02) * (Math.random() < 0.5 ? -1 : 1),
        state: 'wait', timer: 4 + Math.random() * 16, swimLeft: 0, spoutT: 0, spoutScale: 0,
      }));
    }
    // --- TIBURONES: BAJA probabilidad; patrullan cerca de la superficie con la aleta dorsal cortando el agua ---
    // ~5 m (great white real 4.6-6 m): cuerpo casi sumergido, solo lomo+aleta asoman
    const nS = Math.random() < 0.30 ? (1 + (Math.random() < 0.25 ? 1 : 0)) : 0;
    for (let k = 0; k < nS; k++) {
      const s = buildShark(); s.g.scale.setScalar(0.9 + Math.random() * 0.25);
      faunaGroup.add(s.g);
      sharks.push(Object.assign(s, {
        R: SIZE * (0.16 + Math.random() * 0.24), ang: Math.random() * 6.283,
        spd: (0.05 + Math.random() * 0.05) * (Math.random() < 0.5 ? -1 : 1),
        ph: Math.random() * 6.283,
      }));
    }
    // --- DELFINES: BAJA probabilidad; manada que avanza haciendo arcos (porpoising) ---
    // ~3 m (bottlenose real 2.4-3.7 m)
    if (Math.random() < 0.30) {
      const cx = (Math.random() - 0.5) * SIZE * 0.4, cz = (Math.random() - 0.5) * SIZE * 0.4;
      const Rpod = SIZE * (0.22 + Math.random() * 0.12), ang0 = Math.random() * 6.283;
      const dir = Math.random() < 0.5 ? -1 : 1, spd = (0.06 + Math.random() * 0.05) * dir;
      const nD = 3 + (Math.random() * 4 | 0);
      for (let k = 0; k < nD; k++) {
        const d = buildDolphin(); d.g.scale.setScalar(0.85 + Math.random() * 0.35);
        faunaGroup.add(d.g);
        dolphins.push(Object.assign(d, {
          cx, cz, R: Rpod + (Math.random() - 0.5) * 18, ang: ang0 + (Math.random() - 0.5) * 0.4,
          spd, leapH: 1.6 + Math.random() * 1.0, ph: Math.random() * 6.283, leapRate: 1.3 + Math.random() * 0.5,
        }));
      }
    }
    // --- PECES DE LAGO: varios tamaños, saltan cada tanto ---
    for (const L of lakeInfo) {
      const n = 2 + (Math.random() * 3 | 0);
      for (let k = 0; k < n; k++) {
        const size = 0.7 + Math.random() * 1.7;
        const g = buildFish(fishMats[(Math.random() * fishMats.length) | 0]);
        g.scale.setScalar(size); g.visible = false; faunaGroup.add(g);
        fishes.push({ g, cx: L.x, cz: L.z, area: L.r * 0.7, surf: L.level, jumpH: 1.2 + size * 1.6, size,
          state: 'wait', timer: Math.random() * 6, t: 0, dur: 0, jx: L.x, jz: L.z, dx: 1, dz: 0 });
      }
    }
    // --- PECES DE RÍO: chiquitos, solo en tramos bajos (no montaña) ---
    if (riverPts.length) {
      const want = Math.min(riverPts.length, 10);
      for (let k = 0; k < want; k++) {
        const p = riverPts[(Math.random() * riverPts.length) | 0];
        const size = 0.28 + Math.random() * 0.34;
        const g = buildFish(fishMats[(Math.random() * fishMats.length) | 0]);
        g.scale.setScalar(size); g.visible = false; faunaGroup.add(g);
        fishes.push({ g, cx: p.x, cz: p.z, area: 1.5, surf: p.y + 0.3, jumpH: 0.5 + size * 1.2, size,
          state: 'wait', timer: Math.random() * 5, t: 0, dur: 0, jx: p.x, jz: p.z, dx: 1, dz: 0 });
      }
    }
  }
  function updateFauna(dt) {
    faunaTime += dt; const t = faunaTime;
    for (const b of birds) {                    // aves: círculo + bobeo + aleteo
      b.ang += b.spd * dt; const sgn = Math.sign(b.spd);
      b.g.position.set(b.cx + Math.cos(b.ang) * b.R, b.alt + Math.sin(t * 0.7 + b.ph) * 6, b.cz + Math.sin(b.ang) * b.R);
      b.g.rotation.y = Math.atan2(-Math.sin(b.ang) * sgn, Math.cos(b.ang) * sgn);
      const fa = Math.sin(t * b.flap + b.ph) * 0.7; b.lw.rotation.z = -fa; b.rw.rotation.z = fa;
    }
    for (const w of whales) {                   // ballenas: máquina de estados (espera larga ↔ pasada)
      if (w.state === 'wait') {
        w.timer -= dt;
        if (w.timer <= 0) { w.state = 'swim'; w.swimLeft = 2.0 + Math.random() * 3.0; w.g.visible = true; w.spoutT = 1 + Math.random() * 3; }
      } else {
        w.swimLeft -= dt * Math.abs(w.spd); w.ang += w.spd * dt;
        const x = Math.cos(w.ang) * w.R, z = Math.sin(w.ang) * w.R, sgn = Math.sign(w.spd);
        const dxdir = -Math.sin(w.ang) * sgn, dzdir = Math.cos(w.ang) * sgn;
        w.g.position.set(x, -1.4 + Math.sin(t * 0.5) * 0.5, z);
        w.g.rotation.y = Math.atan2(-dzdir, dxdir);
        w.tail.rotation.y = Math.sin(t * 1.2) * 0.3;
        w.spoutT -= dt;
        if (w.spoutT <= 0) { w.spout.visible = true; w.spoutScale = 1.4; w.spoutT = 6 + Math.random() * 6; }
        if (w.spout.visible) { w.spoutScale -= dt * 1.1; if (w.spoutScale <= 0) w.spout.visible = false; else w.spout.scale.setScalar(0.4 + w.spoutScale); }
        if (w.swimLeft <= 0 || heightAt(x, z) >= -2) { w.state = 'wait'; w.timer = 18 + Math.random() * 30; w.g.visible = false; w.spout.visible = false; }
      }
    }
    for (const s of sharks) {                   // tiburones: patrullan en superficie, aleta dorsal cortando el agua
      s.ang += s.spd * dt; const sgn = Math.sign(s.spd);
      const x = Math.cos(s.ang) * s.R, z = Math.sin(s.ang) * s.R;
      s.g.position.set(x, -0.55 + Math.sin(t * 0.8 + s.ph) * 0.12, z);   // lomo casi a ras → solo asoma la aleta
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
    for (const f of fishes) {                   // peces: salto en arco con morro arriba/abajo
      if (f.state === 'wait') {
        f.timer -= dt;
        if (f.timer <= 0) {
          const a = Math.random() * 6.283, rr = Math.random() * f.area;
          f.jx = f.cx + Math.cos(a) * rr; f.jz = f.cz + Math.sin(a) * rr;
          const da = Math.random() * 6.283; f.dx = Math.cos(da); f.dz = Math.sin(da);
          f.t = 0; f.dur = 0.75 + Math.random() * 0.4; f.state = 'jump'; f.g.visible = true;
        }
      } else {
        f.t += dt; const p = f.t / f.dur;
        if (p >= 1) { f.state = 'wait'; f.timer = 2 + Math.random() * 7; f.g.visible = false; continue; }
        const travel = f.size * 1.5;
        f.g.position.set(f.jx + f.dx * travel * (p - 0.5), f.surf + f.jumpH * Math.sin(p * Math.PI), f.jz + f.dz * travel * (p - 0.5));
        f.g.rotation.set(0, Math.atan2(-f.dz, f.dx), Math.cos(p * Math.PI) * 1.0);
      }
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
  function saveIsland() {
    if (currentSeed == null) { toast('Genera una isla primero'); return; }
    const data = {
      seed: currentSeed, sizeKm: params.sizeKm, coverage: params.coverage, erosion: params.erosion,
      rivers: params.rivers, lakes: params.lakes, vegDensity: params.vegDensity,
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); toast('Isla guardada ✓'); }
    catch (e) { toast('No se pudo guardar'); }
  }
  function loadIsland(quiet) {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { data = null; }
    if (!data || typeof data.seed !== 'number') { if (!quiet) toast('No hay isla guardada'); return false; }
    params.sizeKm = data.sizeKm ?? params.sizeKm;
    params.coverage = data.coverage ?? params.coverage;
    params.erosion = data.erosion ?? params.erosion;
    params.rivers = data.rivers ?? params.rivers;
    params.lakes = data.lakes ?? params.lakes;
    params.vegDensity = data.vegDensity ?? params.vegDensity;
    configureForSize();
    clearPlaced();
    buildTerrainMesh(data.seed >>> 0);
    applySizeToView();
    if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
    if (!quiet) toast('Isla cargada ✓');
    return true;
  }

  // ---- GUI ----
  const gui = new GUI({ title: 'Mundo 3 · Constructor' });
  gui.add(params, 'sizeKm', { '0.2 km': 0.2, '0.5 km': 0.5, '1 km': 1, '2 km': 2, '5 km': 5 })
    .name('Tamaño del mapa').onChange(setSize);
  gui.add(params, 'coverage', 5, 70, 1).name('% tierra (cobertura)');
  gui.add(params, 'erosion', 0, 1, 0.05).name('Erosión (al generar)');
  gui.add(params, 'rivers', 0, 8, 1).name('Ríos (al generar)');
  gui.add(params, 'lakes', 0, 6, 1).name('Lagos (al generar)');
  gui.add(params, 'mode', ['Subir', 'Bajar', 'Suavizar', 'Aplanar']).name('Herramienta (esculpir)');
  brushCtrl = gui.add(params, 'brushSize', 3, 200, 1).name('Tamaño pincel (m)').onChange(resizeRing);
  gui.add(params, 'strength', 0.1, 3, 0.1).name('Fuerza');
  gui.add(params, 'vegDensity', 0.2, 4, 0.1).name('Densidad vegetación');
  gui.add(params, 'vegDist', 200, 3000, 50).name('Distancia veg. (m)').onChange(() => { instDirty = true; });
  gui.add({ gen: generateRandom }, 'gen').name('🎲 Generar isla aleatoria');
  gui.add({ save: saveIsland }, 'save').name('💾 Guardar isla');
  gui.add({ load: () => loadIsland(false) }, 'load').name('📂 Cargar isla');
  gui.add({ sow: scatterAssets }, 'sow').name('🌱 Sembrar assets');
  gui.add({ clr: clearPlaced }, 'clr').name('🧹 Limpiar assets');
  gui.add({ plano: flat }, 'plano').name('Vaciar a mar');
  gui.add(params, 'mar').name('Mostrar mar').onChange((v) => { water.visible = v; });
  gui.add(params, 'wireframe').name('Malla').onChange((v) => { mesh.material.wireframe = v; });

  // init: si hay una isla guardada, se recrea idéntica; si no, una aleatoria nueva
  configureForSize();
  if (!loadIsland(true)) buildTerrainMesh();
  applySizeToView();

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
    #asset-palette button { display: block; width: 100%; text-align: left; margin: 4px 0; cursor: pointer;
      background: rgba(40,60,95,.5); color: #e7eefc; border: 1px solid transparent; border-radius: 8px;
      padding: 8px 10px; font-size: 14px; transition: background .12s, border-color .12s; }
    #asset-palette button:hover { background: rgba(60,90,150,.6); }
    #asset-palette button.sel { border-color: #7CFF9B; background: rgba(50,100,70,.6); }
    #asset-palette .hintline { color: #9fb4d4; font-size: 11px; margin: 8px 4px 2px; line-height: 1.35; }
  `;
  document.head.appendChild(style);
  paletteEl = document.createElement('div');
  paletteEl.id = 'asset-palette';
  let h = '<h4>Herramienta</h4><button data-id="sculpt">✋ Esculpir</button>';
  h += '<h4>Pintar bioma</h4>';
  biomeKeys.forEach((k, n) => { h += `<button data-id="b:${n + 1}">${BIOMES[k].label}</button>`; });
  h += '<button data-id="b:0">🧽 Borrar bioma</button>';
  h += '<h4>Colocar asset</h4>';
  for (const k of Object.keys(assetDefs)) h += `<button data-id="a:${k}">${assetDefs[k].label}</button>`;
  h += '<div class="hintline">Pinta biomas o coloca assets con clic-izquierdo sobre el terreno.</div>';
  paletteEl.innerHTML = h;
  document.body.appendChild(paletteEl);
  const onPaletteClick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.dataset.id;
    if (id === 'sculpt') setSel('sculpt', null);
    else if (id.startsWith('b:')) setSel('biome', parseInt(id.slice(2), 10));
    else if (id.startsWith('a:')) setSel('asset', id.slice(2));
  };
  paletteEl.addEventListener('click', onPaletteClick);
  setSel('sculpt', null);

  return {
    scene, camera, showHud: false,
    hint: 'Tamaño del mapa en el panel · clic-izq esculpe/coloca · clic-DER orbita · arrastrar rueda mueve · girar rueda zoom',
    update(dt) {
      water.material.uniforms.time.value += dt * 0.5;
      for (const lk of lakeWaters) lk.material.uniforms.time.value += dt * 0.4;
      riverNormals.offset.y -= dt * 0.25;   // desplaza el normal map río abajo → fluye
      riverNormals.offset.x = Math.sin(riverNormals.offset.y * 2) * 0.02;
      if (normalsDirty) { geo.computeVertexNormals(); normalsDirty = false; }  // 1 vez por frame
      updateFauna(dt);   // aves volando, ballenas cada tanto, peces saltando
      controls.update();
      cullInstances();   // recompone vegetación visible (frustum + distancia + LOD) si la cámara se movió
      // la cámara no atraviesa el terreno ni baja del agua
      const gy = Math.max(0, heightAt(camera.position.x, camera.position.z));
      const minY = gy + 1.5;
      if (camera.position.y < minY) camera.position.y = minY;
    },
    onResize(w, ht) { camera.aspect = w / ht; camera.updateProjectionMatrix(); },
    dispose() {
      gui.destroy();
      controls.dispose();
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown);
      removeEventListener('pointerup', onUp);
      paletteEl?.remove();
      style.remove();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      });
    },
  };
}
