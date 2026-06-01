# Evermark — Isla 3D explorable

Isla 3D en **Three.js** que puedes **recorrer volando**, con el relieve **derivado de la
ilustración** (`assets/map.png`) y **followers que van llegando** y caminan por la isla.

## Cómo verlo

Three.js carga módulos por HTTP (no sirve abrir el `index.html` con doble clic):

```bash
cd evermark-3d
python3 -m http.server 8080
# abre http://localhost:8080
```

## Controles

**Vuelo libre (modo por defecto):**
- `W A S D` = mover · arrastrar ratón = mirar · `Q/E` o `Espacio/Ctrl` = bajar/subir
- `Shift` = turbo · rueda = ajustar velocidad

En la GUI puedes cambiar a modo **Órbita** (arrastrar para girar alrededor, rueda zoom).

## Followers

Cada cierto tiempo aparece un follower en la costa (animación de "desembarco") y empieza
a deambular por la tierra, con su **@ flotando** encima y un color propio. Panel **Followers**:
ritmo de llegada, máximo y botón para reiniciar. Hoy usan una **lista de prueba**
(`src/followers.js`); el origen real (export de followers desde Meta → CSV/JSON) se
conecta más adelante.

## Estructura

- `main.js` — escena, cielo, agua, sol, GUI y bucle.
- `src/terrain.js` — malla del terreno + heightmap derivado de la imagen; expone
  `getGroundY(x,z)` e `isLandAt(x,z)` para que los personajes pisen el relieve.
- `src/flycam.js` — cámara de vuelo libre.
- `src/followers.js` — spawner + personajes que caminan + etiquetas con el @.
- `assets/map.png` — el mapa (textura + fuente del relieve).
- `assets/waternormals.jpg` — normales del agua.

## Ajustes (GUI)

- **Relieve**: altura, ganancia, contraste, suavizado, costa suave, umbral de mar.
- **Apariencia**: textura Ilustración / Topográfico / Mixto, malla.
- **Sol**: elevación y azimut.
