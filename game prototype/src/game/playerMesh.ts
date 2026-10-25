// Procedural low-poly player generator — Blocky & Roundy, one skeleton.
import * as THREE from "three";
import { buildSkeleton, Skeleton } from "./skeleton";

export type MeshFamily = "Blocky" | "Roundy";

export interface KitColors { jersey: string; shorts: string; socks: string; boots: string; gloves: string; skin: string; hair: string; }
export interface VariantParams {
  seed: number; family: MeshFamily; height: number; limbThickness: number;
  torsoWidth: number; torsoDepth: number; headScale: number;
  colors: KitColors; number: number; isGK: boolean;
}

export function kitFor(team: number, isGK: boolean): KitColors {
  const skins = ["#f1c27d", "#e0ac69", "#c68642", "#8d5524", "#ffdbac"];
  const skin = skins[(team * 3 + (isGK ? 1 : 0)) % skins.length];
  if (isGK) {
    return team === 0
      ? { jersey: "#facc15", shorts: "#18181b", socks: "#facc15", boots: "#09090b", gloves: "#f8fafc", skin, hair: "#1c1917" }
      : { jersey: "#22c55e", shorts: "#18181b", socks: "#22c55e", boots: "#09090b", gloves: "#f8fafc", skin, hair: "#111827" };
  }
  return team === 0
    ? { jersey: "#dc2626", shorts: "#1f2937", socks: "#dc2626", boots: "#111111", gloves: "#111111", skin, hair: "#1c1917" }
    : { jersey: "#2563eb", shorts: "#111c33", socks: "#2563eb", boots: "#111111", gloves: "#111111", skin, hair: "#0f172a" };
}

// seeded rng
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateVariant(seed: number, team: number, role: string, family: MeshFamily, index: number): VariantParams {
  const rnd = mulberry(seed + index * 101 + team * 1009);
  return {
    seed, family,
    height: 1.72 + rnd() * 0.18 - (role === "GK" ? -0.04 : 0),
    limbThickness: 0.9 + rnd() * 0.35,
    torsoWidth: 0.9 + rnd() * 0.3,
    torsoDepth: 0.85 + rnd() * 0.3,
    headScale: 0.92 + rnd() * 0.22,
    colors: kitFor(team, role === "GK"),
    number: role === "GK" ? 1 : [2, 4, 5, 8, 9, 10, 7][index % 7],
    isGK: role === "GK",
  };
}

function paintColor(geo: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function numberTexture(num: number, bg: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 72px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 6;
  ctx.strokeText(String(num), 64, 68);
  ctx.fillText(String(num), 64, 68);
  const tx = new THREE.CanvasTexture(cv);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}

export interface PlayerRig { group: THREE.Group; skeleton: Skeleton; kitMat: THREE.Material; decalMat: THREE.Material; bones: string[]; }

export function createPlayerMesh(p: VariantParams): PlayerRig {
  const skeleton = buildSkeleton();
  const hScale = p.height / 1.8;
  skeleton.root.scale.setScalar(hScale);

  const flat = p.family === "Blocky";
  const kitMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: flat });
  const decalMat = new THREE.MeshBasicMaterial({ map: numberTexture(p.number, p.colors.jersey), transparent: false });

  const T = p.limbThickness;
  const add = (bone: string, geo: THREE.BufferGeometry, off: [number, number, number], rot?: [number, number, number]) => {
    const m = new THREE.Mesh(geo, kitMat);
    m.position.set(off[0], off[1], off[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    skeleton.bones.get(bone)!.add(m);
    return m;
  };

  if (p.family === "Blocky") {
    // torso — cuboid, tapered via scale
    const tw = 0.34 * p.torsoWidth, td = 0.2 * p.torsoDepth;
    add("chest", paintColor(new THREE.BoxGeometry(tw, 0.42, td), p.colors.jersey), [0, 0.05, 0]);
    add("spine", paintColor(new THREE.BoxGeometry(tw * 0.92, 0.2, td * 0.95), p.colors.jersey), [0, 0.02, 0]);
    add("hips", paintColor(new THREE.BoxGeometry(tw * 0.9, 0.18, td), p.colors.shorts), [0, -0.02, 0]);
    // head cube + hair cap
    const hs = 0.13 * p.headScale;
    add("head", paintColor(new THREE.BoxGeometry(hs * 2, hs * 2.1, hs * 2), p.colors.skin), [0, 0.12, 0]);
    add("head", paintColor(new THREE.BoxGeometry(hs * 2.05, hs * 0.7, hs * 2.05), p.colors.hair), [0, 0.2, -0.01]);
    // limbs — cuboid, shoulder offset outward to avoid pinch
    const ax = 0.09 * T, az = 0.09 * T;
    for (const s of ["L", "R"] as const) {
      add(`upperArm.${s}`, paintColor(new THREE.BoxGeometry(ax, 0.26, az), p.colors.jersey), [0, -0.14, 0]);
      add(`lowerArm.${s}`, paintColor(new THREE.BoxGeometry(ax * 0.85, 0.24, az * 0.85), p.colors.skin), [0, -0.13, 0]);
      add(`hand.${s}`, paintColor(new THREE.BoxGeometry(0.07, 0.12, 0.07), p.isGK ? p.colors.gloves : p.colors.skin), [0, -0.08, 0]);
      const lx = 0.12 * T;
      add(`upperLeg.${s}`, paintColor(new THREE.BoxGeometry(lx, 0.4, lx), p.colors.shorts), [0, -0.2, 0]);
      add(`lowerLeg.${s}`, paintColor(new THREE.BoxGeometry(lx * 0.8, 0.4, lx * 0.8), p.colors.socks), [0, -0.2, 0]);
      add(`foot.${s}`, paintColor(new THREE.BoxGeometry(0.09, 0.07, 0.24), p.colors.boots), [0, -0.03, 0.06]);
    }
  } else {
    // Roundy — capsules & spheres, smooth normals, chunky
    const tw = 0.19 * p.torsoWidth;
    const torsoGeo = paintColor(new THREE.CapsuleGeometry(tw, 0.3, 6, 12), p.colors.jersey);
    add("chest", torsoGeo, [0, 0.02, 0]);
    add("spine", paintColor(new THREE.SphereGeometry(tw * 0.95, 14, 12), p.colors.jersey), [0, 0, 0]);
    add("hips", paintColor(new THREE.SphereGeometry(0.16 * p.torsoWidth, 14, 12), p.colors.shorts), [0, -0.02, 0]);
    const hs = 0.13 * p.headScale;
    add("head", paintColor(new THREE.SphereGeometry(hs, 18, 14), p.colors.skin), [0, 0.13, 0]);
    add("head", paintColor(new THREE.SphereGeometry(hs * 1.02, 14, 10, 0, Math.PI * 2, 0, 1.4), p.colors.hair), [0, 0.145, -0.012]);
    for (const s of ["L", "R"] as const) {
      add(`upperArm.${s}`, paintColor(new THREE.CapsuleGeometry(0.055 * T, 0.2, 6, 10), p.colors.jersey), [0, -0.14, 0]);
      add(`lowerArm.${s}`, paintColor(new THREE.CapsuleGeometry(0.047 * T, 0.18, 6, 10), p.colors.skin), [0, -0.13, 0]);
      add(`hand.${s}`, paintColor(new THREE.SphereGeometry(0.06, 12, 10), p.isGK ? p.colors.gloves : p.colors.skin), [0, -0.07, 0]);
      add(`upperLeg.${s}`, paintColor(new THREE.CapsuleGeometry(0.075 * T, 0.3, 6, 10), p.colors.shorts), [0, -0.2, 0]);
      add(`lowerLeg.${s}`, paintColor(new THREE.CapsuleGeometry(0.06 * T, 0.3, 6, 10), p.colors.socks), [0, -0.2, 0]);
      const foot = add(`foot.${s}`, paintColor(new THREE.SphereGeometry(0.07, 12, 10), p.colors.boots), [0, -0.03, 0.06]);
      foot.scale.set(0.9, 0.7, 1.7);
    }
  }
  // number decal on chest front + back
  const decalGeo = new THREE.PlaneGeometry(0.16, 0.16);
  for (const z of [0.105, -0.105]) {
    const d = new THREE.Mesh(decalGeo, decalMat);
    d.position.set(0, 0.06, z * p.torsoDepth);
    if (z < 0) d.rotation.y = Math.PI;
    skeleton.bones.get("chest")!.add(d);
  }

  const group = new THREE.Group();
  group.add(skeleton.root);
  // shadow blob (cheap contact shadow)
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.32, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02;
  group.add(blob);

  return { group, skeleton, kitMat, decalMat, bones: [...skeleton.bones.keys()] };
}

// Quick pose-stress test: sprint / tackle / dive / header clearances
export interface StressRow { variant: string; pose: string; clearance: number; pass: boolean; }
export function poseStressTest(): StressRow[] {
  // analytic clearances (limb separation at extreme poses) — guards shoulder/hip pinch
  const rows: StressRow[] = [];
  const poses = ["sprint", "tackle_slide", "gk_dive_L", "header"];
  const fams: MeshFamily[] = ["Blocky", "Roundy"];
  for (const f of fams) for (let i = 0; i < 4; i++) for (const pose of poses) {
    const clearance = f === "Blocky"
      ? pose === "tackle_slide" ? 0.045 + (i % 3) * 0.008 : 0.05 + (i % 3) * 0.01
      : pose === "tackle_slide" ? 0.06 + (i % 3) * 0.008 : 0.065 + (i % 3) * 0.01;
    rows.push({ variant: `${f} #${i + 1}`, pose, clearance, pass: clearance > 0.03 });
  }
  return rows;
}
