// World and scene construction: renderer, stadium, players' meshes, debug overlay.
import * as THREE from "three";
import { CONFIG } from "../config";
import type { MatchHost } from "./host";

/** Renderer + shadow configuration; a no-op stub in headless reproduction runs. */
export function createRenderer(canvas: HTMLCanvasElement, headless: boolean): THREE.WebGLRenderer {
  const renderer = headless
    // Headless reproduction harness: identical simulation, no GPU.
    ? ({ render() {}, setSize() {}, setPixelRatio() {}, dispose() {}, shadowMap: { enabled: false, type: 0 } } as unknown as THREE.WebGLRenderer)
    : new THREE.WebGLRenderer({ canvas, antialias: true });
  if (!headless) renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/** Night-match look: dark green backdrop with distance fog. */
export function configureScene(scene: THREE.Scene) {
  scene.background = new THREE.Color("#0b1f14");
  scene.fog = new THREE.Fog("#0b1f14", 55, 110);
}

export function createMatchCamera(camPos: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
  camera.position.copy(camPos);
  return camera;
}

/** Placeholder group for a future crowd system; intentionally disabled. */
export function addCrowdStub(scene: THREE.Scene): THREE.Group {
  const crowdStub = new THREE.Group();
  crowdStub.name = "CrowdSystem (disabled stub — add fans here later)";
  crowdStub.visible = false;
  scene.add(crowdStub);
  return crowdStub;
}

  export function buildPitchTexture(): THREE.CanvasTexture {
    const W = 1024, H = 640;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    // mow stripes
    for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? "#2f9e4f" : "#2a9048"; g.fillRect((W / 10) * i, 0, W / 10, H); }
    const sx = (x: number) => ((x + 20) / 40) * W;
    const sz = (z: number) => ((z + 12.5) / 25) * H;
    g.strokeStyle = "rgba(255,255,255,0.92)"; g.lineWidth = 4;
    // touchlines
    g.strokeRect(sx(-20), sz(-12.5), sx(20) - sx(-20), sz(12.5) - sz(-12.5));
    // halfway
    g.beginPath(); g.moveTo(sx(0), sz(-12.5)); g.lineTo(sx(0), sz(12.5)); g.stroke();
    // centre circle + spot
    g.beginPath(); g.arc(sx(0), sz(0), (4 / 40) * W, 0, 7); g.stroke();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(sx(0), sz(0), 5, 0, 7); g.fill();
    // penalty areas (5.5m deep, 12m wide) + arcs + spots
    for (const s of [-1, 1]) {
      const gx = s < 0 ? -20 : 20;
      const x0 = s < 0 ? sx(gx) : sx(gx - 5.5), x1 = s < 0 ? sx(gx + 5.5) : sx(gx);
      g.strokeRect(Math.min(x0, x1), sz(-6), Math.abs(x1 - x0), sz(6) - sz(-6));
      // six-yard (2m deep, 6m wide)
      const y0 = s < 0 ? sx(gx) : sx(gx - 2), y1 = s < 0 ? sx(gx + 2) : sx(gx);
      g.strokeRect(Math.min(y0, y1), sz(-3), Math.abs(y1 - y0), sz(3) - sz(-3));
      // spot
      const px = s < 0 ? sx(-16.5) : sx(16.5);
      g.beginPath(); g.arc(px, sz(0), 4, 0, 7); g.fill();
      // arc
      g.beginPath(); g.arc(px, sz(0), (3 / 40) * W, s < 0 ? -0.9 : Math.PI - 0.9, s < 0 ? 0.9 : Math.PI + 0.9); g.stroke();
      // corner arcs
      for (const cz of [-12.5, 12.5]) {
        g.beginPath(); g.arc(sx(gx), sz(cz), 22, 0, 7); g.stroke();
      }
    }
    const tx = new THREE.CanvasTexture(cv);
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = 4;
    return tx;
  }

/** Ground, perimeter, goals and lights for the stadium. */
export function buildWorld(e: MatchHost) {
  const P = CONFIG.pitch;
  // ground: pitch + buffer apron
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(P.length + P.buffer * 2 + 6, P.width + P.buffer * 2 + 6),
    new THREE.MeshLambertMaterial({ color: "#1d5c33" })
  );
  apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02; apron.receiveShadow = true;
  e.scene.add(apron);
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(P.length, P.width),
    new THREE.MeshLambertMaterial({ map: buildPitchTexture() })
  );
  pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true;
  e.scene.add(pitch);
  // perimeter wall
  const wallMat = new THREE.MeshLambertMaterial({ color: "#e2e8f0" });
  const adMat = new THREE.MeshLambertMaterial({ color: "#0ea5e9" });
  const mkWall = (w: number, d: number, x: number, z: number, c?: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, P.wallHeight, d), c ?? wallMat);
    m.position.set(x, P.wallHeight / 2, z); m.castShadow = true;
    e.scene.add(m);
  };
  const bx = P.length / 2 + P.buffer, bz = P.width / 2 + P.buffer;
  mkWall((bx + 0.3) * 2, 0.3, 0, -bz, adMat); mkWall((bx + 0.3) * 2, 0.3, 0, bz);
  mkWall(0.3, (bz + 0.3) * 2, -bx, 0); mkWall(0.3, (bz + 0.3) * 2, bx, 0);
  // goals
  for (const s of [-1, 1]) {
    const gx = s * (P.length / 2);
    const grp = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: "#f8fafc" });
    const pg = new THREE.CylinderGeometry(0.06, 0.06, P.goalHeight, 10);
    for (const z of [-P.goalWidth / 2, P.goalWidth / 2]) {
      const post = new THREE.Mesh(pg, postMat);
      post.position.set(0, P.goalHeight / 2, z); post.castShadow = true; grp.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, P.goalWidth + 0.12, 10), postMat);
    bar.rotation.x = Math.PI / 2; bar.position.set(0, P.goalHeight, 0); grp.add(bar);
    // net volume (cheap, non-simulated trigger)
    const net = new THREE.Mesh(
      new THREE.BoxGeometry(P.goalDepth, P.goalHeight, P.goalWidth),
      new THREE.MeshBasicMaterial({ color: "#ffffff", wireframe: true, transparent: true, opacity: 0.25 })
    );
    net.position.set(s * P.goalDepth / 2, P.goalHeight / 2, 0);
    grp.add(net);
    grp.position.set(gx, 0, 0);
    e.scene.add(grp);
  }
  // lights: 1 directional + soft ambient, subtle contact shadows
  const sun = new THREE.DirectionalLight("#ffffff", 1.35);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -28; sun.shadow.camera.right = 28;
  sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
  e.scene.add(sun, new THREE.HemisphereLight("#dff3ff", "#12351f", 0.75));
}

/** Line overlay that visualises AI move targets. */
export function buildAIDebug(e: MatchHost) {
  const geo = new THREE.BufferGeometry();
  e.aiLinePos = new THREE.Float32BufferAttribute(new Float32Array(10 * 2 * 3), 3);
  geo.setAttribute("position", e.aiLinePos);
  e.aiLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.7 }));
  e.aiLines.frustumCulled = false;
  e.scene.add(e.aiLines);
}

export function resizeRenderer(e: MatchHost) {
    const w = e.canvas.clientWidth || 800, h = e.canvas.clientHeight || 500;
    e.renderer.setSize(w, h, false);
    e.camera.aspect = w / h; e.camera.updateProjectionMatrix();
  }

/**
 * Release every GPU resource owned by the scene graph: geometries, materials,
 * their textures (pitch paint, shirt numbers, ball skin) and shadow maps.
 * `renderer.dispose()` alone does none of this — it only drops the renderer's
 * internal lists — so each abandoned match used to leak its whole scene on the
 * GPU until the browser reclaimed the context. Shared assets are disposed once.
 */
export function disposeSceneGraph(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      materials.add(m);
      for (const value of Object.values(m)) {
        if ((value as THREE.Texture | null)?.isTexture) textures.add(value as THREE.Texture);
      }
    }
    const light = obj as THREE.DirectionalLight;
    if (light.isDirectionalLight && light.shadow?.map) {
      light.shadow.map.dispose();
      light.shadow.map = null;
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  scene.clear();
}
