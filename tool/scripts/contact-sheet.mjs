// Renders a contact sheet of the generated game pack, one row per clip, so the
// animation can be eyeballed without launching the studio or the game.
//
//   node scripts/contact-sheet.mjs "../../game prototype/public/motions/game-motion-pack.json" "../../game prototype/docs/motion-contact-sheet.svg"
//
// Side view (forward = +X of the clip, i.e. left-to-right in the drawing) of four
// evenly spaced frames per clip. Bones are read from src/rig.ts so the drawing always
// matches the skeleton the clips were authored on.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packPath = resolve(process.argv[2] ?? "../../game prototype/public/motions/game-motion-pack.json");
const outPath = resolve(process.argv[3] ?? "../../game prototype/docs/motion-contact-sheet.svg");
const pack = JSON.parse(readFileSync(packPath, "utf8"));

// ---- bones from the shared rig -------------------------------------------------
const rigText = readFileSync(resolve(here, "../src/rig.ts"), "utf8");
const boneBlock = rigText.slice(rigText.indexOf("export const BONES"), rigText.indexOf("const v = "));
const bones = [...boneBlock.matchAll(/\['([a-zA-Z]+)',\s*'([a-zA-Z]+)'/g)].map((m) => [m[1], m[2]]);
if (bones.length < 15) throw new Error("could not read BONES from rig.ts");

const ROWS = [
  "gen_walk", "gen_jog", "gen_sprint",
  "gen_pass_short", "gen_pass_long", "gen_shoot_normal", "gen_shoot_finesse",
  "gen_tackle_slide", "gen_gk_dive_l", "gen_gk_catch", "gen_throw_in", "gen_corner_kick",
];
const COLS = 4;
const CELL_W = 168, CELL_H = 150, LEFT = 132, TOP = 34, SCALE_Y = 46; // px per metre

const cellFrames = (clip) => {
  const n = clip.frames.length;
  const contact = clip.metadata.contactFrame;
  return Array.from({ length: COLS }, (_, i) => {
    const p = contact === undefined ? i / (COLS - 1) * 0.85 : Math.max(0, Math.min(1, contact - 0.16 + i * 0.11));
    return clip.frames[Math.min(n - 1, Math.round(p * (n - 1)))];
  });
};

// Side view: the clip's forward axis (+Z) runs left-to-right, gravity is -Y.
const toSvg = (joints, ox, oy, view) => {
  const groundY = oy + CELL_H - 20;
  const px = (z) => ox + 20 + (z - view.origin) * view.scaleX;
  const py = (y) => groundY - y * SCALE_Y;
  const parts = [];
  for (const [from, to] of bones) {
    const a = joints[from], b = joints[to];
    if (!a || !b) continue;
    const limb = (from.includes("Hip") && to.includes("Knee")) || (from.includes("Knee") && to.includes("Ankle"));
    const near = from.includes("left") || to.includes("left");
    const color = limb ? "#c8f31d" : near ? "#7d8590" : "#e6e8ea";
    parts.push(`<line x1="${px(a.z).toFixed(1)}" y1="${py(a.y).toFixed(1)}" x2="${px(b.z).toFixed(1)}" y2="${py(b.y).toFixed(1)}" stroke="${color}" stroke-width="${limb ? 3 : 2.2}" stroke-linecap="round"/>`);
  }
  const head = joints.head;
  if (head) parts.push(`<circle cx="${px(head.z).toFixed(1)}" cy="${py(head.y).toFixed(1)}" r="6" fill="none" stroke="#e6e8ea" stroke-width="2.4"/>`);
  return parts.join("");
};

const svg = [];
const width = LEFT + COLS * CELL_W + 20;
const height = TOP + ROWS.length * CELL_H + 26;
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`);
svg.push(`<rect width="${width}" height="${height}" fill="#0b0d0f"/>`);
svg.push(`<text x="16" y="22" fill="#c8f31d" font-size="13" font-weight="700">Generated game pack · side view · green = thigh/shin, contact frame highlighted</text>`);
const byId = new Map(pack.clips.map((c) => [c.metadata.id, c]));
for (const [row, id] of ROWS.entries()) {
  const clip = byId.get(id);
  if (!clip) continue;
  const oy = TOP + row * CELL_H;
  const index = new Map(clip.jointOrder.map((name, i) => [name, i]));
  const meta = clip.metadata;
  svg.push(`<text x="16" y="${oy + 46}" fill="#e6e8ea" font-size="11" font-weight="700">${meta.slot}</text>`);
  svg.push(`<text x="16" y="${oy + 62}" fill="#7d8590" font-size="9">${meta.duration.toFixed(2)}s${meta.contactFrame !== undefined ? ` · contact ${(meta.contactFrame * 100).toFixed(0)}%` : ""}${meta.rootMotion ? " · root" : ""}</text>`);
  const sampled = cellFrames(clip);
  // Framing uses the whole clip, so a sliding tackle is scaled down to fit its cell.
  const pelvisZ = clip.frames.map((f) => f.j[index.get("pelvis") * 3 + 2]);
  const travel = Math.max(0.4, Math.max(...pelvisZ) - Math.min(...pelvisZ));
  const view = { origin: Math.min(...pelvisZ) - 0.5, scaleX: Math.min(74, 100 / travel) };
  for (const [col, frame] of sampled.entries()) {
    const ox = LEFT + col * CELL_W;
    const joints = {};
    for (const [name, i] of index) joints[name] = { x: frame.j[i * 3], y: frame.j[i * 3 + 1], z: frame.j[i * 3 + 2] };
    const isContact = meta.contactFrame !== undefined
      && Math.abs(frame.t / meta.duration - meta.contactFrame) < 0.055;
    svg.push(`<rect x="${ox}" y="${oy}" width="${CELL_W - 6}" height="${CELL_H - 8}" rx="6" fill="${isContact ? "#1b2410" : "#12161a"}" stroke="${isContact ? "#2f3d16" : "#1b2026"}"/>`);
    svg.push(`<line x1="${ox + 10}" y1="${oy + CELL_H - 18}" x2="${ox + CELL_W - 16}" y2="${oy + CELL_H - 18}" stroke="#2a3138" stroke-dasharray="3 4"/>`);
    svg.push(toSvg(joints, ox, oy, view));
    svg.push(`<text x="${ox + 8}" y="${oy + CELL_H - 8}" fill="#5c6670" font-size="8">t ${frame.t.toFixed(2)}s</text>`);
  }
}
svg.push("</svg>");
writeFileSync(outPath, svg.join("\n"));
console.log(`wrote ${outPath} (${ROWS.length} clips × ${COLS} frames, ${bones.length} bones)`);
