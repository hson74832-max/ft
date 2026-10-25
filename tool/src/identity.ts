/**
 * Player identity: colour signatures + multi-candidate association.
 *
 * Pure (no DOM / no MediaPipe runtime) so it can be unit-tested in Node.
 *
 * Why this exists: a pose model only answers "where is a person". When several
 * players are on screen it may return a different one from frame to frame. We
 * ask it for several candidates and pick the one that matches the locked
 * player by (1) appearance - jersey / shorts / hair colour, (2) where he was and
 * where his velocity says he should be, (3) his size. If nobody matches we
 * report "not found" rather than guessing, and the gap is bridged afterwards.
 */

export type Rgb = [number, number, number];
export type ColorRole = 'jersey' | 'shorts' | 'hair' | 'any';
export type ColorTarget = { id: string; role: ColorRole; rgb: Rgb };
export type IdentityOptions = {
  enabled: boolean;
  /** 0 = lenient, 1 = strict. Strict rejects more look-alikes and bridges the gap instead. */
  strictness: number;
  /** Colours the user picked by hand. They outweigh anything learned automatically. */
  targets: ColorTarget[];
};
export type Roi = { x: number; y: number; w: number; h: number };
type Role = 'jersey' | 'shorts' | 'hair' | 'legs';
export type Patches = Partial<Record<Role, Rgb>>;
export type Candidate = {
  index: number;
  /** Hip centre in normalized full-frame coordinates. */
  cx: number;
  cy: number;
  /** Body height in normalized frame-height units. */
  h: number;
  confidence: number;
  patches: Patches;
};
type P = { x: number; y: number; visibility?: number };

const ROLES: Role[] = ['jersey', 'shorts', 'hair', 'legs'];
const WEIGHTS: Record<Role, number> = { jersey: 1, shorts: 0.7, hair: 0.6, legs: 0.35 };
/** A colour distance of this many (luminance-discounted) Lab units counts as "1.0 different". */
const DE_SCALE = 22;
const MANUAL_WEIGHT = 1.6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// --- colour ---------------------------------------------------------------

const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
export function toLab([r, g, b]: Rgb): Rgb {
  const R = lin(r), G = lin(g), B = lin(b);
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/**
 * Illumination-tolerant colour distance.
 *  - Chroma is divided by lightness. Scaling a colour's linear light by k scales
 *    both L and (a,b) by ~k^(1/3), so a/L is unchanged: the same shirt in sun
 *    and in shadow lands on the same point (a plain Lab distance called a
 *    half-shadowed red shirt "borderline different").
 *  - Lightness still counts, weighted by how colourless the pair is: for
 *    white / grey / black kits chroma is meaningless and lightness is the
 *    only thing that separates the teams.
 */
export function deltaE(a: Rgb, b: Rgb): number {
  const A = toLab(a), B = toLab(b);
  const norm = (L: number, c: number) => (c / Math.max(L, 20)) * 50;
  const chroma = (x: Rgb) => Math.hypot(x[1], x[2]);
  const colourful = Math.min(1, (chroma(A) + chroma(B)) / 2 / 30);
  const wL = 0.3 + 0.45 * (1 - colourful);
  return Math.hypot((A[0] - B[0]) * wL, norm(A[0], A[1]) - norm(B[0], B[1]), norm(A[0], A[2]) - norm(B[0], B[2]));
}

function targetCost(p: Patches, t: ColorTarget): number | null {
  if (t.role === 'any') {
    let best = Infinity;
    for (const r of ROLES) { const c = p[r]; if (c) best = Math.min(best, deltaE(c, t.rgb)); }
    return best === Infinity ? null : best / DE_SCALE;
  }
  const c = p[t.role];
  return c ? deltaE(c, t.rgb) / DE_SCALE : null;
}

/** Weighted mismatch, ~0 = same look, ~1 = borderline, >2 = clearly different. NaN = nothing comparable. */
export function colourCost(p: Patches, lock: Patches | null, targets: ColorTarget[]): number {
  let sum = 0, w = 0;
  if (lock) for (const r of ROLES) { const a = lock[r], b = p[r]; if (a && b) { sum += (WEIGHTS[r] * deltaE(a, b)) / DE_SCALE; w += WEIGHTS[r]; } }
  for (const t of targets) { const c = targetCost(p, t); if (c !== null) { sum += MANUAL_WEIGHT * c; w += MANUAL_WEIGHT; } }
  return w > 0 ? sum / w : NaN;
}

// --- sampling -------------------------------------------------------------

/**
 * Samples body-part colours from a square RGBA buffer. Landmarks are in that
 * buffer's normalized coordinates. Patch size scales with the player so a small
 * distant player isn't averaged with the pitch behind him.
 */
export function samplePatches(lm: P[], px: Uint8ClampedArray, size: number): Patches {
  const vis = (i: number) => (lm[i]?.visibility ?? 0) > 0.4;
  const mid = (a: P, b: P) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const either = (a: number, b: number) => (vis(a) && vis(b) ? mid(lm[a], lm[b]) : vis(a) ? lm[a] : vis(b) ? lm[b] : null);
  const sh = vis(11) && vis(12) ? mid(lm[11], lm[12]) : null;
  const hip = vis(23) && vis(24) ? mid(lm[23], lm[24]) : null;
  const knee = either(25, 26);
  const ankle = either(27, 28);

  const grab = (p: { x: number; y: number }, rad: number): Rgb | null => {
    const cx = Math.round(p.x * size), cy = Math.round(p.y * size);
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = cy - rad; y <= cy + rad; y++) {
      if (y < 0 || y >= size) continue;
      for (let x = cx - rad; x <= cx + rad; x++) {
        if (x < 0 || x >= size) continue;
        const i = (y * size + x) * 4;
        R += px[i]; G += px[i + 1]; B += px[i + 2]; n++;
      }
    }
    return n ? [R / n, G / n, B / n] : null;
  };

  const out: Patches = {};
  const torsoPx = sh && hip ? Math.hypot(sh.x - hip.x, sh.y - hip.y) * size : 0;
  const r = clamp(Math.round(torsoPx * 0.07), 2, 9);
  if (sh && hip) {
    const a = grab(lerp(sh, hip, 0.3), r), b = grab(lerp(sh, hip, 0.55), r);
    if (a && b) out.jersey = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    else if (a || b) out.jersey = (a ?? b)!;
  }
  if (hip && knee) { const c = grab(lerp(hip, knee, 0.3), r); if (c) out.shorts = c; }
  if (knee && ankle) { const c = grab(lerp(knee, ankle, 0.4), Math.max(2, r - 1)); if (c) out.legs = c; }
  if (vis(7) && vis(8)) {
    // The ears are a reliable head-width proxy, so both the offset and the patch
    // radius are derived from them. The old code pushed the patch 0.55
    // ear-distances up with a radius clamped to 2 px: on a 128 px sampling
    // buffer that is a 5x5 patch sitting ABOVE the hairline, so it returned
    // mostly background and the hair colour was useless for matching.
    const ears = mid(lm[7], lm[8]);
    const earDist = Math.max(0.004, Math.hypot(lm[7].x - lm[8].x, lm[7].y - lm[8].y));
    // Sample at ear level only. Reaching further up overshoots a short hairline
    // and pulls in background, which made the signature change when the camera
    // panned to a different part of the pitch - worse than no hair term at all.
    // Ear level lands on the side of the head (hair or sideburn) for most
    // subjects and stays on the player as he turns.
    const r = clamp(Math.round(earDist * size * 0.35), 3, 10);
    const c = grab(ears, r);
    if (c) out.hair = c;
  }
  return out;
}

// --- association ----------------------------------------------------------

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class IdentityTracker {
  /** Frames where the detector offered someone, but nobody matched our player. */
  rejected = 0;
  private lock: Patches | null = null;
  private last: { cx: number; cy: number; h: number; time: number } | null = null;
  private vel = { x: 0, y: 0 };
  private misses = 0;

  constructor(private o: IdentityOptions, private aspect: number, private roi: Roi | null) {}

  /** The appearance learned from the locked player (for display). */
  get learned(): Patches | null { return this.lock; }

  private colourAccept() { return 1.7 - clamp(this.o.strictness, 0, 1); }

  /**
   * Choose our player among this frame's detections, or null when none match.
   * Deliberately does NOT re-lock onto a different appearance after a long gap:
   * instead the position gate widens and the colour gate relaxes (up to 2x), so
   * a genuine lighting change recovers but a different player doesn't qualify.
   */
  choose(cands: Candidate[], time: number): Candidate | null {
    if (!cands.length) { this.misses++; return null; }
    if (!this.o.enabled) return cands.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    if (!this.last) { const first = this.initial(cands); this.commit(first, time, true); return first; }

    const lead = Math.min(Math.max(0.001, time - this.last.time), 0.5);
    const px = this.last.cx + this.vel.x * lead, py = this.last.cy + this.vel.y * lead;
    const refH = Math.max(0.06, this.last.h);
    const allowed = 0.7 + 0.35 * Math.min(this.misses, 10);
    const accept = this.colourAccept() * (1 + Math.min(this.misses, 60) / 60);

    let best: Candidate | null = null, bestScore = Infinity;
    for (const c of cands) {
      const posCost = Math.hypot((c.cx - px) * this.aspect, c.cy - py) / refH / allowed;
      const sizeCost = Math.abs(Math.log(Math.max(0.02, c.h) / Math.max(0.02, this.last.h)));
      const raw = colourCost(c.patches, this.lock, this.o.targets);
      const col = Number.isFinite(raw) ? raw : 0.5; // unknowable -> let position decide
      if (posCost > 1.6 || sizeCost > 1.0 || col > accept) continue;
      const score = col + 0.9 * posCost + 0.3 * sizeCost;
      if (score < bestScore) { best = c; bestScore = score; }
    }
    if (!best) { this.rejected++; this.misses++; return null; }
    this.commit(best, time, false);
    return best;
  }

  private initial(cands: Candidate[]): Candidate {
    const roi = this.roi;
    let best = cands[0], bestScore = Infinity;
    for (const c of cands) {
      let s = 0;
      if (roi) {
        const inside = c.cx >= roi.x && c.cx <= roi.x + roi.w && c.cy >= roi.y && c.cy <= roi.y + roi.h;
        if (!inside) s += 1 + Math.hypot((c.cx - (roi.x + roi.w / 2)) * this.aspect, c.cy - (roi.y + roi.h / 2)) / Math.max(0.05, roi.h);
      }
      if (this.o.targets.length) { const m = colourCost(c.patches, null, this.o.targets); if (Number.isFinite(m)) s += m; }
      s += (roi || this.o.targets.length ? 0.15 : 1) * (1 - Math.min(1, c.h)) - 0.1 * c.confidence;
      if (s < bestScore) { best = c; bestScore = s; }
    }
    return best;
  }

  private commit(c: Candidate, time: number, init: boolean) {
    if (this.last) {
      const dt = Math.max(0.001, time - this.last.time);
      this.vel = { x: this.vel.x * 0.6 + ((c.cx - this.last.cx) / dt) * 0.4, y: this.vel.y * 0.6 + ((c.cy - this.last.cy) / dt) * 0.4 };
    }
    this.last = { cx: c.cx, cy: c.cy, h: c.h, time };
    this.misses = 0;
    if (init || !this.lock) { this.lock = { ...c.patches }; return; }
    // Slow adaptation to lighting, only from confident matches, so it can't drift onto a look-alike.
    const col = colourCost(c.patches, this.lock, []);
    if (Number.isFinite(col) && col < 0.6) {
      for (const r of ROLES) { const n = c.patches[r]; if (n) this.lock[r] = this.lock[r] ? mixRgb(this.lock[r]!, n, 0.04) : n; }
    }
  }
}

// --- multi-player tracking ------------------------------------------------

export type TrackState = 'active' | 'lost' | 'dead';
export type PlayerTrackState = {
  id: number;
  cx: number; cy: number; h: number;
  vx: number; vy: number;
  lastTime: number;
  firstTime: number;
  lock: Patches;
  hits: number;
  state: TrackState;
  /** Recent unambiguous positions, for a least-squares velocity estimate. */
  hist: Array<{ t: number; x: number; y: number }>;
};

/**
 * Least-squares slope over ~0.3 s of history. Differencing consecutive frames
 * amplifies detection noise: at 30 fps a +/-0.4% position jitter becomes
 * ~0.24 units/s of velocity noise, more than a sprinting player's actual
 * screen speed, so prediction was useless exactly when two same-kit players
 * cross and only motion can tell them apart.
 */
function lsVelocity(h: Array<{ t: number; x: number; y: number }>): { vx: number; vy: number } | null {
  if (h.length < 3 || h[h.length - 1].t - h[0].t < 0.08) return null;
  const n = h.length;
  const mt = h.reduce((s, p) => s + p.t, 0) / n, mx = h.reduce((s, p) => s + p.x, 0) / n, my = h.reduce((s, p) => s + p.y, 0) / n;
  let stt = 0, stx = 0, sty = 0;
  for (const p of h) { const dt = p.t - mt; stt += dt * dt; stx += dt * (p.x - mx); sty += dt * (p.y - my); }
  return stt > 1e-9 ? { vx: stx / stt, vy: sty / stt } : null;
}

/**
 * Tracks EVERY player at once and keeps each one's ID stable.
 *
 * Per frame:
 *  1. score every (track, detection) pair by colour + predicted position + size,
 *  2. assign GLOBALLY, cheapest pairs first, so two tracks can never claim the
 *     same detection (the failure mode of running a single-target tracker per
 *     player is that both lock onto whoever is most visible),
 *  3. unmatched detections start new tracks, but only after checking recently
 *     LOST tracks first - re-identification by colour, so a player who was
 *     occluded for a moment gets his old ID back instead of a new one.
 */
export class MultiTracker {
  readonly tracks: PlayerTrackState[] = [];
  private nextId = 1;

  constructor(
    private aspect: number,
    private o: { strictness: number; lostAfter?: number; forgetAfter?: number; minConfidence?: number } = { strictness: 0.65 },
  ) {}

  private get lostAfter() { return this.o.lostAfter ?? 0.25; }
  private get forgetAfter() { return this.o.forgetAfter ?? 3; }
  private accept() { return 1.7 - clamp(this.o.strictness, 0, 1); }

  /** Returns trackId -> candidate index for this frame. */
  update(cands: Candidate[], time: number): Map<number, number> {
    for (const t of this.tracks) {
      if (t.state === 'dead') continue;
      const gap = time - t.lastTime;
      if (gap > this.forgetAfter) t.state = 'dead';
      else if (gap > this.lostAfter) t.state = 'lost';
    }
    const live = this.tracks.filter((t) => t.state !== 'dead');
    const pred = new Map<number, { x: number; y: number }>();
    for (const t of live) {
      // Lost tracks don't keep coasting: velocity is only trusted for ~0.3 s.
      const lead = Math.min(Math.max(0.001, time - t.lastTime), t.state === 'lost' ? 0.3 : 0.5);
      pred.set(t.id, { x: t.cx + t.vx * lead, y: t.cy + t.vy * lead });
    }
    const pairs: Array<{ t: PlayerTrackState; ci: number; score: number }> = [];
    for (const t of live) {
      const gap = Math.max(0.001, time - t.lastTime);
      const { x: px, y: py } = pred.get(t.id)!;
      const refH = Math.max(0.06, t.h);
      const allowed = t.state === 'lost' ? 1 + 2.5 * gap : 0.7 + 1.2 * gap;
      const accept = t.state === 'lost' ? this.accept() * 0.8 : this.accept(); // re-id leans on colour, so be stricter
      cands.forEach((c, ci) => {
        const pos = Math.hypot((c.cx - px) * this.aspect, c.cy - py) / refH / allowed;
        const size = Math.abs(Math.log(Math.max(0.02, c.h) / Math.max(0.02, t.h)));
        const raw = colourCost(c.patches, t.lock, []);
        const col = Number.isFinite(raw) ? raw : 0.5;
        if (pos > 1.6 || size > 1 || col > accept) return;
        pairs.push({ t, ci, score: col + 0.9 * pos + 0.3 * size + (t.state === 'lost' ? 0.3 : 0) });
      });
    }
    pairs.sort((a, b) => a.score - b.score);
    const out = new Map<number, number>();
    const usedCand = new Set<number>();
    for (const { t, ci } of pairs) {
      if (out.has(t.id) || usedCand.has(ci)) continue;
      out.set(t.id, ci);
      usedCand.add(ci);
      // Ambiguous: another live track predicts (nearly) the same spot. The
      // detection may belong to either player, so update position but don't let
      // it bend this track's velocity or colour memory.
      const c = cands[ci];
      const ambiguous = live.some((o) => o !== t && o.state === 'active' && (() => {
        const q = pred.get(o.id)!;
        return Math.hypot((c.cx - q.x) * this.aspect, c.cy - q.y) < 0.35 * Math.max(0.06, o.h);
      })());
      this.commit(t, c, time, ambiguous);
    }
    const minConf = this.o.minConfidence ?? 0.5;
    cands.forEach((c, ci) => {
      if (usedCand.has(ci) || c.confidence < minConf) return;
      // Duplicate detection of someone already assigned this frame? Skip it.
      for (const used of usedCand) {
        const u = cands[used];
        if (Math.hypot((c.cx - u.cx) * this.aspect, c.cy - u.cy) < 0.15 * Math.max(0.06, u.h)) return;
      }
      const t: PlayerTrackState = { id: this.nextId++, cx: c.cx, cy: c.cy, h: c.h, vx: 0, vy: 0, lastTime: time, firstTime: time, lock: { ...c.patches }, hits: 1, state: 'active', hist: [{ t: time, x: c.cx, y: c.cy }] };
      this.tracks.push(t);
      out.set(t.id, ci);
      usedCand.add(ci);
    });
    return out;
  }

  private commit(t: PlayerTrackState, c: Candidate, time: number, ambiguous = false) {
    if (t.state !== 'active') { t.vx = 0; t.vy = 0; t.hist = []; } // re-acquired: old motion is meaningless
    if (!ambiguous) {
      t.hist.push({ t: time, x: c.cx, y: c.cy });
      while (t.hist.length && time - t.hist[0].t > 0.33) t.hist.shift();
      const v = lsVelocity(t.hist);
      if (v) { t.vx = v.vx; t.vy = v.vy; }
    }
    t.cx = c.cx; t.cy = c.cy; t.h = c.h; t.lastTime = time; t.hits++; t.state = 'active';
    if (ambiguous) return;
    const col = colourCost(c.patches, t.lock, []);
    if (Number.isFinite(col) && col < 0.6) {
      for (const r of ROLES) { const n = c.patches[r]; if (n) t.lock[r] = t.lock[r] ? mixRgb(t.lock[r]!, n, 0.04) : n; }
    } else if (!Object.keys(t.lock).length) t.lock = { ...c.patches };
  }
}
