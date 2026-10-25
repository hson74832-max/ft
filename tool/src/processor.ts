import { FilesetResolver, PoseLandmarker, type MPMask, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { bridgeHeld, finalizeClip, landmarksToFrame, type MaskData, type PoseFrame } from './motion';
import { MultiTracker } from './identity';
import { IdentityTracker, samplePatches, type Candidate, type IdentityOptions, type Patches, type Roi } from './identity';

export type { ColorRole, ColorTarget, IdentityOptions, Patches, Rgb, Roi } from './identity';
export type ModelQuality = 'lite' | 'full';
export type Range = { start: number; end: number };
export type TargetFps = 15 | 30 | 60;
export type Person = Roi & { color?: string };
export type TrackOptions = {
  fps: TargetFps;
  /** Manually selected subject region. null = whole frame. */
  roi: Roi | null;
  /** Move the analysis window with the player (rarely, with hysteresis). */
  follow: boolean;
  /** Per-pixel person mask for true background removal. */
  segment: boolean;
  model: ModelQuality;
  identity: IdentityOptions;
  /** 'single' = follow one locked player; 'all' = track everyone with stable IDs. */
  mode: 'single' | 'all';
  /** All-players mode: maximum people detected per frame (2-6). */
  maxPeople: number;
};
export type PlayerTrack = {
  id: number;
  /** P1, P2, ... ordered by how much of the clip the player is visible for. */
  label: string;
  /** Distinct drawing colour for overlays. */
  color: string;
  /** Learned jersey colour, for display. */
  jersey?: string;
  /** Fraction of sampled frames where this player was actually detected. */
  coverage: number;
  frames: PoseFrame[];
};
export type TrackResult = {
  frames: PoseFrame[];
  /** Something the user should know (e.g. the engine crashed and we recovered). */
  notice?: string;
  stats: { total: number; held: number; rejected: number; learned: Patches | null; segmentation: boolean };
  /** All-players mode: every tracked player. `frames` is players[0]. */
  players?: PlayerTrack[];
};

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
const MODEL_URLS: Record<ModelQuality, string> = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

/** Hard per-run sample budget. Keeps the main thread responsive in-browser. */
export const FRAME_BUDGET = 900;
/**
 * EVERY frame is fed to the model as exactly S x S pixels. Variable input sizes
 * (the old follow-crop changed size each frame) are a classic way to crash the
 * WASM graph, especially with segmentation, whose buffers are sized per input.
 */
const S = 512;
const MASK_MAX = 192;
const GIF_PREVIEW_MAX = 320;
const GIF_PREVIEW_COUNT = 300;

// MediaPipe's VIDEO graph needs strictly increasing timestamps per instance.
let clock = 0;
const stamp = (deltaMs: number) => (clock += Math.max(1, Math.round(deltaMs)));

// ---------------------------------------------------------------------------
// Engine management.
//  * ONE queue: MediaPipe calls from different runs can never interleave.
//  * ONE engine alive at a time: previously up to three WASM instances (video,
//    video+mask, image) were resident, which is a memory-pressure abort risk.
//  * VIDEO engines are created fresh for every run and closed after it, so the
//    internal tracker never carries stale state from a previous player/crop.
//  * Crashes ("Aborted()") are caught, the engine is rebuilt, and the run is
//    retried with progressively safer settings instead of failing.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

let fileset: ReturnType<typeof FilesetResolver.forVisionTasks> | undefined;
const modelBytes = new Map<ModelQuality, Promise<ArrayBuffer>>();
let engine: { key: string; model: PoseLandmarker } | null = null;
/** Last thing we were doing; included in crash messages so failures are diagnosable. */
let stage = 'idle';

function closeEngine() {
  if (!engine) return;
  try { engine.model.close(); } catch { /* already dead */ }
  engine = null;
}

async function openEngine(kind: 'VIDEO' | 'IMAGE', numPoses: number, segment: boolean, quality: ModelQuality, reuse: boolean): Promise<PoseLandmarker> {
  const key = `${kind}|${numPoses}|${segment}|${quality}`;
  if (reuse && engine && engine.key === key) return engine.model;
  closeEngine();
  stage = 'loading the pose model';
  if (!fileset) fileset = FilesetResolver.forVisionTasks(WASM_URL);
  let bytes = modelBytes.get(quality);
  if (!bytes) {
    bytes = fetch(MODEL_URLS[quality]).then((r) => {
      if (!r.ok) throw new Error(`Could not download the ${quality} pose model (HTTP ${r.status}).`);
      return r.arrayBuffer();
    });
    modelBytes.set(quality, bytes);
    bytes.catch(() => modelBytes.delete(quality));
  }
  let fs, buf;
  try { [fs, buf] = await Promise.all([fileset, bytes]); } catch (e) { fileset = undefined; throw e; }
  stage = 'starting the engine';
  const model = await PoseLandmarker.createFromOptions(fs, {
    // CPU delegate: masks come back blank on GPU in several browsers (mediapipe#4757).
    baseOptions: { modelAssetBuffer: new Uint8Array(buf.slice(0)), delegate: 'CPU' },
    runningMode: kind, numPoses,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    outputSegmentationMasks: segment,
  });
  engine = { key, model };
  return model;
}

const isAbort = (e: unknown) => /abort|out of memory|memory access|unreachable|runtimeerror/i.test(String(e instanceof Error ? `${e.name} ${e.message}` : e));

async function guarded<T>(run: (attempt: number) => Promise<T>, onRetry: (attempt: number, where: string) => void): Promise<T> {
  let where = 'running';
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await run(attempt); } catch (e) {
      if (!isAbort(e)) throw e instanceof Error ? e : new Error(String(e));
      where = stage;
      closeEngine();
      onRetry(attempt, where);
    }
  }
  throw new Error(`The tracking engine crashed while ${where} and did not recover after 3 attempts. Try a shorter range, turn off the pixel mask, or reload the page.`);
}

/** Each retry trades quality for stability. */
const degrade = (o: TrackOptions, attempt: number): TrackOptions => (attempt === 0 ? o : attempt === 1 ? { ...o, segment: false } : { ...o, segment: false, model: 'lite' });
const noticeFor = (o: TrackOptions, attempt: number) =>
  attempt === 0 ? undefined
    : attempt === 1 ? (o.segment ? 'The segmentation engine crashed, so tracking was redone without the pixel mask (a pose-hull cutout is used instead).' : 'The tracking engine crashed once and was restarted automatically.')
      : 'The engine crashed twice; tracking was redone with the lite model and no pixel mask.';

// ---------------------------------------------------------------------------

const yieldUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const isGif = (file: File) => file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');

/**
 * Seek, but don't wait for `seeked` if the video has to decode from a keyframe
 * far away: rely on it plus a safety timeout so one stuck seek can't hang a run.
 */
const seek = (video: HTMLVideoElement, time: number) => new Promise<void>((resolve, reject) => {
  if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { resolve(); return; }
  let settled = false;
  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    video.removeEventListener('seeked', done);
    video.removeEventListener('error', fail);
    err ? reject(err) : resolve();
  };
  const done = () => finish();
  const fail = () => finish(new Error('Could not decode this video frame.'));
  // 4 s is generous even for a 10 s GOP at 4K; past that the decoder is wedged.
  const timer = setTimeout(() => finish(new Error(`Video decoder stalled seeking to ${time.toFixed(2)}s. Try re-encoding the clip (e.g. H.264, keyframe every 1-2 s).`)), 4000);
  video.addEventListener('seeked', done, { once: true });
  video.addEventListener('error', fail, { once: true });
  video.currentTime = time;
});

/**
 * Pull frames by PLAYING the video and catching each presented frame with
 * requestVideoFrameCallback. Playback decodes sequentially (fast), whereas
 * seeking forces a keyframe + forward decode for every sample. Falls back to
 * seeking when the API is missing or the browser presents fewer frames than we
 * need (e.g. a 24 fps source sampled at 60). Yields (frame time, mediaTime).
 */
type VideoWithRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number; cancelVideoFrameCallback?: (h: number) => void };
async function* playbackFrames(video: VideoWithRVFC, start: number, end: number, fps: number, cancelled: () => boolean) {
  const step = 1 / fps;
  let next = start;
  await seek(video, start);
  video.playbackRate = Math.min(4, Math.max(0.25, fps / 30)); // decode roughly as fast as we consume
  video.muted = true;
  let resolveFrame: ((m: number | null) => void) | null = null;
  let handle = 0;
  const onFrame = (_: number, meta: { mediaTime: number }) => { resolveFrame?.(meta.mediaTime); resolveFrame = null; handle = video.requestVideoFrameCallback!(onFrame); };
  handle = video.requestVideoFrameCallback!(onFrame);
  const onEnd = () => { resolveFrame?.(null); resolveFrame = null; };
  video.addEventListener('ended', onEnd);
  video.addEventListener('pause', onEnd);
  try {
    await video.play();
    while (next < end && !cancelled()) {
      const mediaTime = await new Promise<number | null>((r) => { resolveFrame = r; });
      if (mediaTime === null) break;
      // Emit every sample instant this presented frame covers (it may cover several at 60 fps).
      // Emit once per presented frame. If the source is slower than the sample
      // rate (24 fps source @ 60), later sample slots are skipped here and the
      // frame is REUSED below rather than duplicated, so timing stays truthful.
      if (mediaTime + 1e-3 >= next) {
        yield { sample: next, mediaTime };
        next += step;
        while (next < end && mediaTime - next > step * 0.5) next += step; // we fell behind: skip, don't fake
      }
    }
  } finally {
    video.removeEventListener('ended', onEnd);
    video.removeEventListener('pause', onEnd);
    video.cancelVideoFrameCallback?.(handle);
    video.pause();
    video.playbackRate = 1;
  }
  // Anything left (clip ended early / API missing): the caller seeks for it.
  while (next < end && !cancelled()) { yield { sample: next, mediaTime: NaN }; next += step; }
}

function loadVideo(url: string) {
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.playsInline = true; video.src = url;
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(video), { once: true });
    video.addEventListener('error', () => reject(new Error('This video format is not supported by your browser.')), { once: true });
    video.load();
  });
}
const releaseVideo = (video: HTMLVideoElement) => { video.removeAttribute('src'); video.load(); };

let gifCache: { name: string; size: number; duration: number; buffer: ArrayBuffer } | null = null;
export async function probeDuration(file: File): Promise<number> {
  if (isGif(file)) {
    if (gifCache && gifCache.name === file.name && gifCache.size === file.size) return gifCache.duration;
    const buffer = await file.arrayBuffer();
    const frames = decompressFrames(parseGIF(buffer), false);
    const duration = Math.max(0.1, frames.reduce((s, f) => s + Math.max(20, f.delay || 100), 0) / 1000);
    gifCache = { name: file.name, size: file.size, duration, buffer };
    return duration;
  }
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideo(url);
    const d = Number.isFinite(video.duration) ? video.duration : 0;
    releaseVideo(video);
    return Math.max(0.1, d);
  } finally { URL.revokeObjectURL(url); }
}

// --- fixed-size model input ---------------------------------------------------

const makeCanvas = () => {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
};
const work = makeCanvas();
const probe = makeCanvas(); // people-scan has its own canvas so it can never clobber the tracking input
/**
 * Colour sampling happens on a 128 px copy. Reading the full 512 px canvas is a
 * 1 MB copy per frame (~900 MB of transient allocation over a long clip); the
 * patches we average are only a few pixels wide, so 128 px is plenty and costs
 * 1/16 as much. Normalized landmark coordinates are identical on both.
 */
const SS = 128;
const sampler = (() => { const c = document.createElement('canvas'); c.width = SS; c.height = SS; return { c, ctx: c.getContext('2d', { willReadFrequently: true })! }; })();
function samplePixels(from: HTMLCanvasElement): Uint8ClampedArray | null {
  sampler.ctx.drawImage(from, 0, 0, SS, SS);
  try { return sampler.ctx.getImageData(0, 0, SS, SS).data; } catch { return null; }
}
/** Size to pass to samplePatches for a buffer returned by samplePixels(). */
export const SAMPLE_SIZE = SS;

const FULL: Roi = { x: 0, y: 0, w: 1, h: 1 };
type Placement = { x: number; y: number; w: number; h: number };

/** Never let a NaN / zero / out-of-range crop reach the engine (a 0x0 canvas aborts it). */
function sanitizeRoi(r: Roi): Roi {
  const f = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const w = clamp(f(r.w, 1), 0.02, 1), h = clamp(f(r.h, 1), 0.02, 1);
  return { x: clamp(f(r.x, 0), 0, 1 - w), y: clamp(f(r.y, 0), 0, 1 - h), w, h };
}
const inflate = (r: Roi, k: number): Roi => sanitizeRoi({ x: r.x - (r.w * (k - 1)) / 2, y: r.y - (r.h * (k - 1)) / 2, w: r.w * k, h: r.h * k });

/**
 * Draw a square window around `roi` into the S x S canvas. The window takes
 * extra real image content around the subject (rather than black bars) and only
 * letterboxes where it would run past the frame edge. Returns the normalized
 * full-frame rectangle the S x S input covers, for mapping results back.
 */
function prepare(src: CanvasImageSource, srcW: number, srcH: number, roiIn: Roi, target = work): Placement {
  const roi = sanitizeRoi(roiIn);
  const side = Math.max(roi.w * srcW, roi.h * srcH);
  const ww = Math.min(side, srcW), wh = Math.min(side, srcH);
  const wx = clamp((roi.x + roi.w / 2) * srcW - ww / 2, 0, srcW - ww);
  const wy = clamp((roi.y + roi.h / 2) * srcH - wh / 2, 0, srcH - wh);
  const s = Math.min(S / ww, S / wh, 3);
  const dw = ww * s, dh = wh * s, ox = (S - dw) / 2, oy = (S - dh) / 2;
  target.ctx.fillStyle = '#000';
  target.ctx.fillRect(0, 0, S, S);
  target.ctx.drawImage(src, wx, wy, ww, wh, ox, oy, dw, dh);
  return { x: (wx - ox / s) / srcW, y: (wy - oy / s) / srcH, w: S / s / srcW, h: S / s / srcH };
}

function readMask(mask: MPMask, place: Placement): MaskData {
  // Respect the real storage type: a Uint8 mask read as Float32 clamps to solid white.
  const isFloat = mask.hasFloat32Array();
  const raw = isFloat ? mask.getAsFloat32Array() : mask.getAsUint8Array();
  const scale = isFloat ? 255 : 1;
  const s = Math.min(1, MASK_MAX / Math.max(mask.width, mask.height));
  const w = Math.max(1, Math.round(mask.width * s)), h = Math.max(1, Math.round(mask.height * s));
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.min(mask.height - 1, Math.floor(y / s)) * mask.width;
    for (let x = 0; x < w; x++) data[y * w + x] = raw[row + Math.min(mask.width - 1, Math.floor(x / s))] * scale;
  }
  return { data, width: w, height: h, rect: [place.x, place.y, place.w, place.h] };
}

// --- candidate building (shared by both modes) ---------------------------

type DetectResult = ReturnType<PoseLandmarker['detectForVideo']>;
function buildCandidates(res: DetectResult, place: Placement, time: number, aspect: number, px: Uint8ClampedArray | null) {
  const cands: Candidate[] = [];
  const frameOf = new Map<number, PoseFrame>();
  res.landmarks.forEach((lm, i) => {
    const wl = res.worldLandmarks[i];
    if (!lm || !wl || lm.length < 33 || wl.length < 33) return;
    // Un-crop: landmarks are relative to the S x S input; the app wants full-frame coordinates.
    const full: NormalizedLandmark[] = lm.map((p) => ({ ...p, x: place.x + p.x * place.w, y: place.y + p.y * place.h }));
    const f = landmarksToFrame(wl, full, time, aspect);
    frameOf.set(i, f);
    const b = f.bbox ?? [0, 0, 1, 1];
    const hips = [23, 24].filter((k) => (full[k].visibility ?? 0) > 0.3).map((k) => full[k]);
    const sh = [11, 12].filter((k) => (full[k].visibility ?? 0) > 0.3).map((k) => full[k]);
    const ref = hips.length ? hips : sh.length ? sh : null;
    cands.push({
      index: i,
      cx: ref ? ref.reduce((s, p) => s + p.x, 0) / ref.length : (b[0] + b[2]) / 2,
      cy: ref ? ref.reduce((s, p) => s + p.y, 0) / ref.length : (b[1] + b[3]) / 2,
      h: Math.max(0.02, b[3] - b[1]), confidence: f.confidence,
      patches: px ? samplePatches(lm, px, SAMPLE_SIZE) : {},
    });
  });
  return { cands, frameOf };
}

interface Session {
  /** Analyse one frame. Returns true when a sample was recorded for it. */
  step(src: CanvasImageSource, time: number, deltaMs: number): boolean;
  /** Attach a preview bitmap to the sample recorded by the last step(). */
  setImage(img: ImageBitmap): void;
  finish(noPlayerMessage: string): TrackResult;
}

// --- one tracking run -------------------------------------------------------

class TrackSession implements Session {
  readonly frames: PoseFrame[] = [];
  private tracker: IdentityTracker;
  private win: Roi | null;
  private missStreak = 0;
  private lastGood: PoseFrame | null = null;
  private aspect: number;

  constructor(private model: PoseLandmarker, private opts: TrackOptions, private srcW: number, private srcH: number) {
    this.aspect = srcW / srcH;
    const roi = opts.roi ? sanitizeRoi(opts.roi) : null;
    this.tracker = new IdentityTracker(opts.identity, this.aspect, roi);
    this.win = roi ? inflate(roi, 1.4) : null; // a little context so look-alikes are visible to the matcher
  }

  step(src: CanvasImageSource, time: number, deltaMs: number): boolean {
    const place = prepare(src, this.srcW, this.srcH, this.win ?? FULL);
    const res = this.model.detectForVideo(work.c, stamp(deltaMs));
    let picked: PoseFrame | null = null;
    try {
      const px = this.opts.identity.enabled && res.landmarks.length ? samplePixels(work.c) : null;
      const { cands, frameOf } = buildCandidates(res, place, time, this.aspect, px);
      const pick = this.tracker.choose(cands, time);
      if (pick) {
        picked = frameOf.get(pick.index)!;
        const masks = res.segmentationMasks;
        // Only the picked person's own mask; masks[0] would composite someone else.
        const m = this.opts.segment && masks && pick.index < masks.length ? masks[pick.index] : undefined;
        if (m) { stage = 'reading the segmentation mask'; picked.mask = readMask(m, place); }
      }
    } finally {
      for (const m of res.segmentationMasks ?? []) m.close();
    }
    this.updateWindow(picked);
    if (picked) { this.lastGood = picked; this.frames.push(picked); return true; }
    if (this.lastGood) {
      // Not found: hold the last pose. bridgeHeld() interpolates short gaps afterwards.
      this.frames.push({ ...this.lastGood, time, confidence: 0, held: true, mask: undefined, image: undefined });
      return true;
    }
    return false;
  }

  setImage(img: ImageBitmap) {
    const last = this.frames[this.frames.length - 1];
    if (last) last.image = img;
  }

  /**
   * Window follow with hysteresis. It used to re-centre every frame, which moves
   * the image under MediaPipe's internal tracker and is a prime cause of it
   * hopping to another player. Now it moves only when the player nears the
   * edge or his size changes a lot; the matcher absorbs the one-frame jump.
   */
  private updateWindow(p: PoseFrame | null) {
    if (!this.opts.follow) return;
    if (!p?.bbox) {
      if (++this.missStreak >= 3 && this.win) {
        const w = this.win, nh = Math.min(1, w.h * 1.15), nw = Math.min(1, w.w * 1.15);
        this.win = nh >= 0.9 ? null : sanitizeRoi({ x: w.x + w.w / 2 - nw / 2, y: w.y + w.h / 2 - nh / 2, w: nw, h: nh });
      }
      return;
    }
    this.missStreak = 0;
    const b = p.bbox;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const Hn = clamp((b[3] - b[1]) * 2.4, 0.3, 1);
    if (Hn >= 0.85) { this.win = null; return; } // large subject: the whole frame is the right window
    const Wn = Math.min(1, (Hn * this.srcH) / this.srcW);
    const cur = this.win ?? FULL;
    const off = Math.max(Math.abs(cx - (cur.x + cur.w / 2)) * this.aspect, Math.abs(cy - (cur.y + cur.h / 2)));
    if (!this.win || off > 0.18 * cur.h || Math.abs(Math.log(Hn / cur.h)) > 0.3) this.win = sanitizeRoi({ x: cx - Wn / 2, y: cy - Hn / 2, w: Wn, h: Hn });
  }

  finish(noPlayerMessage: string): TrackResult {
    if (!this.frames.length) throw new Error(noPlayerMessage);
    stage = 'stabilising bone lengths and grounding';
    const frames = finalizeClip(bridgeHeld(this.frames));
    return {
      frames,
      stats: { total: frames.length, held: frames.filter((f) => f.held).length, rejected: this.tracker.rejected, learned: this.tracker.learned, segmentation: this.opts.segment },
    };
  }
}

/** Distinct overlay colours for players P1..Pn. */
const PALETTE = ['#b8f675', '#ff9f43', '#4dd2ff', '#ff6b9d', '#c792ea', '#ffd166', '#06d6a0', '#ef476f', '#a0c4ff', '#f4a261', '#8ecae6', '#e9c46a'];
/** 2*tan(vfov/2) for an assumed ~35 degree broadcast lens; only affects how far apart players appear in depth. */
const FOV_K = 0.63;
const medianOf = (values: number[]) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
};
const cssRgb = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;

/**
 * All-players session. Every detection on every frame is assigned to a stable
 * player ID by MultiTracker; at the end each player becomes a full-length clip
 * on the SHARED timeline (absent before he appears / after he leaves), and all
 * players are placed in one scene so their relative positions are preserved.
 */
class MultiSession implements Session {
  private times: number[] = [];
  private images: (ImageBitmap | undefined)[] = [];
  private detections = new Map<number, Map<number, PoseFrame>>();
  private tracker: MultiTracker;
  private aspect: number;
  private win: Roi;

  constructor(private model: PoseLandmarker, private opts: TrackOptions, private srcW: number, private srcH: number) {
    this.aspect = srcW / srcH;
    this.tracker = new MultiTracker(this.aspect, { strictness: opts.identity.strictness });
    // A drawn region restricts the analysis area (e.g. exclude the bench and crowd). It does not move.
    this.win = opts.roi ? sanitizeRoi(opts.roi) : FULL;
  }

  step(src: CanvasImageSource, time: number, deltaMs: number): boolean {
    const place = prepare(src, this.srcW, this.srcH, this.win);
    const res = this.model.detectForVideo(work.c, stamp(deltaMs));
    try {
      const px = res.landmarks.length ? samplePixels(work.c) : null;
      const { cands, frameOf } = buildCandidates(res, place, time, this.aspect, px);
      const idx = this.times.length;
      this.times.push(time);
      for (const [id, ci] of this.tracker.update(cands, time)) {
        const f = frameOf.get(cands[ci].index);
        if (!f) continue;
        let m = this.detections.get(id);
        if (!m) { m = new Map(); this.detections.set(id, m); }
        m.set(idx, f);
      }
    } finally {
      for (const m of res.segmentationMasks ?? []) m.close();
    }
    return true;
  }

  setImage(img: ImageBitmap) { this.images[this.times.length - 1] = img; }

  finish(noPlayerMessage: string): TrackResult {
    const n = this.times.length;
    if (!n) throw new Error(noPlayerMessage);
    stage = 'building player tracks';
    // Short-lived tracks are false detections (a referee's arm, a ball boy at the edge).
    const minHits = Math.max(6, Math.round(0.4 * this.opts.fps));
    // ...and so is a recurring false detection: it can be re-identified across
    // blips and slowly gather "hits", but a real player is detected on most of
    // the frames between his first and last appearance. Require >= 25% density.
    const dense = (m: Map<number, PoseFrame>) => {
      const k = [...m.keys()];
      return m.size / (Math.max(...k) - Math.min(...k) + 1);
    };
    const kept = [...this.detections.entries()]
      .filter(([, m]) => m.size >= minHits && dense(m) >= 0.25)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, PALETTE.length);
    if (!kept.length) throw new Error(noPlayerMessage);

    const all = kept.flatMap(([, m]) => [...m.values()]);
    const x0 = medianOf(all.map((f) => f.meta?.hipX ?? NaN));
    const mpu0 = medianOf(kept.map(([, m]) => medianOf([...m.values()].map((f) => f.meta?.mpu ?? NaN))));
    const scene = { x0: Number.isFinite(x0) ? x0 : 0.5, mpu0: Number.isFinite(mpu0) ? mpu0 : 1.9, fovK: FOV_K };

    stage = 'stabilising every player';
    const players: PlayerTrack[] = kept.map(([id, m], rank) => {
      const idxs = [...m.keys()].sort((a, b) => a - b);
      const first = idxs[0], last = idxs[idxs.length - 1];
      let prev = m.get(first)!;
      const dense: PoseFrame[] = [];
      for (let i = 0; i < n; i++) {
        const f = m.get(i);
        if (f) { prev = f; dense.push({ ...f, time: this.times[i], image: this.images[i] }); continue; }
        dense.push({ ...prev, time: this.times[i], confidence: 0, held: true, absent: i < first || i > last, mask: undefined, image: this.images[i] });
      }
      const jersey = this.tracker.tracks.find((t) => t.id === id)?.lock.jersey;
      return { id, label: `P${rank + 1}`, color: PALETTE[rank], jersey: jersey ? cssRgb(jersey) : undefined, coverage: m.size / n, frames: finalizeClip(bridgeHeld(dense), scene) };
    });
    const main = players[0];
    const mainLock = this.tracker.tracks.find((t) => t.id === main.id)?.lock ?? null;
    return { frames: main.frames, players, stats: { total: n, held: main.frames.filter((f) => f.held).length, rejected: 0, learned: mainLock, segmentation: false } };
  }
}

const makeSession = (model: PoseLandmarker, opts: TrackOptions, w: number, h: number): Session =>
  opts.mode === 'all' ? new MultiSession(model, opts, w, h) : new TrackSession(model, opts, w, h);

const emptyResult = (o: TrackOptions): TrackResult => ({ frames: [], stats: { total: 0, held: 0, rejected: 0, learned: null, segmentation: o.segment } });
type Progress = (value: number, label: string) => void;
const poses = (o: TrackOptions) => (o.mode === 'all' ? clamp(Math.round(o.maxPeople), 2, 6) : o.identity.enabled ? 3 : 1);
/** Masks are per-person and multiply memory by the player count, so all-players mode uses the pose-hull cutout. */
const effective = (o: TrackOptions): TrackOptions => (o.mode === 'all' ? { ...o, segment: false } : o);

export function processVideo(file: File, range: Range, opts: TrackOptions, progress: Progress, cancelled: () => boolean): Promise<TrackResult> {
  return exclusive(async () => {
    let used = 0;
    const base = effective(opts);
    const result = await guarded((attempt) => { used = attempt; return videoRun(file, range, degrade(base, attempt), progress, cancelled); },
      (attempt, where) => progress(1, `Engine crashed while ${where}. Restarting (${attempt + 1}/3)…`));
    return { ...result, notice: noticeFor(effective(opts), used) };
  });
}

async function videoRun(file: File, range: Range, opts: TrackOptions, progress: Progress, cancelled: () => boolean): Promise<TrackResult> {
  progress(2, opts.segment ? 'Starting pose + segmentation engine' : 'Starting pose engine');
  const model = await openEngine('VIDEO', poses(opts), opts.segment, opts.model, false);
  const url = URL.createObjectURL(file);
  let video: HTMLVideoElement | null = null;
  try {
    if (cancelled()) return emptyResult(opts);
    stage = 'loading the video';
    video = await loadVideo(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error('This file has no decodable video track.');
    // Some containers report NaN (no metadata) or Infinity (streamed) here;
    // Math.max(0.1, NaN) is NaN, which would poison every range computation
    // below and surface as a misleading "no player found". Fall back to the
    // requested range end.
    const full = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Math.max(0.1, range.end);
    const start = clamp(range.start, 0, Math.max(0, full - 0.05));
    const end = clamp(range.end > start ? range.end : full, start + 0.05, full);
    // Clamp the WINDOW, not the sample count, so the requested FPS is always honoured.
    const span = Math.min(end - start, FRAME_BUDGET / opts.fps);
    if (span < end - start) { progress(3, `${opts.fps} FPS limit: analysing the first ${span.toFixed(1)}s of the range`); await yieldUI(); }
    const count = clamp(Math.ceil(span * opts.fps), 2, FRAME_BUDGET);
    const session = makeSession(model, opts, video.videoWidth, video.videoHeight);
    const rvfc = typeof (video as VideoWithRVFC).requestVideoFrameCallback === 'function';
    let i = 0;
    const analyse = async (absolute: number) => {
      // Re-check AFTER any await - the exact point a superseded run used to hit the engine.
      if (cancelled()) return false;
      stage = `detecting poses on frame ${i + 1}`;
      session.step(video!, absolute - start, 1000 / opts.fps);
      i++;
      progress(Math.round(5 + (i / count) * 93), `Tracking @ ${opts.fps} FPS: frame ${i} of ${count}`);
      if (i % 3 === 0) await yieldUI();
      return true;
    };
    if (rvfc) {
      // Fast path: sequential decode via playback.
      for await (const { sample, mediaTime } of playbackFrames(video as VideoWithRVFC, start, start + span - 0.001, opts.fps, cancelled)) {
        if (Number.isNaN(mediaTime)) { stage = `seeking to frame ${i + 1}`; await seek(video, Math.min(sample, start + span - 0.001)); }
        // Record the time the pixels really come from (<= 1 source frame away from the slot).
        if (!(await analyse(Number.isNaN(mediaTime) ? sample : Math.max(start, Math.min(mediaTime, sample))))) return emptyResult(opts);
        if (i >= count) break;
      }
    } else {
      for (; i < count;) {
        if (cancelled()) return emptyResult(opts);
        const absolute = Math.min(start + i / opts.fps, start + span - 0.001);
        stage = `seeking to frame ${i + 1}`;
        await seek(video, absolute);
        if (!(await analyse(absolute))) return emptyResult(opts);
      }
    }
    return session.finish(opts.roi ? 'No player found in the selected region. Redraw the box around one full body.' : 'No player was detected. Try a clear full-body clip, or select the player manually.');
  } finally {
    if (video) releaseVideo(video);
    URL.revokeObjectURL(url);
    closeEngine(); // VIDEO engines are single-use
  }
}

/** Composites GIF frames honouring disposal modes. */
async function* gifFrames(file: File, limit: number) {
  const cached = gifCache && gifCache.name === file.name && gifCache.size === file.size ? gifCache : null;
  const gif = parseGIF(cached ? cached.buffer : await file.arrayBuffer());
  const decoded = decompressFrames(gif, true);
  gifCache = null;
  if (!decoded.length) throw new Error('This GIF has no readable frames.');
  const canvas = document.createElement('canvas');
  canvas.width = gif.lsd.width; canvas.height = gif.lsd.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const patch = document.createElement('canvas');
  const pctx = patch.getContext('2d')!;
  let elapsed = 0, prevDisposal = 0;
  let prevDims = { left: 0, top: 0, width: 0, height: 0 };
  let restore: ImageData | null = null;
  const n = Math.min(decoded.length, limit);
  for (let i = 0; i < n; i++) {
    const f = decoded[i];
    if (prevDisposal === 2) ctx.clearRect(prevDims.left, prevDims.top, prevDims.width, prevDims.height);
    if (prevDisposal === 3 && restore) ctx.putImageData(restore, 0, 0);
    restore = f.disposalType === 3 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
    patch.width = f.dims.width; patch.height = f.dims.height;
    pctx.putImageData(new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height), 0, 0);
    ctx.drawImage(patch, f.dims.left, f.dims.top);
    prevDisposal = f.disposalType; prevDims = f.dims;
    yield { canvas, time: elapsed / 1000, index: i, total: n };
    elapsed += Math.max(20, f.delay || 100);
  }
}

const previewOf = (canvas: HTMLCanvasElement) => {
  const s = Math.min(1, GIF_PREVIEW_MAX / Math.max(canvas.width, canvas.height));
  return createImageBitmap(canvas, { resizeWidth: Math.max(1, Math.round(canvas.width * s)), resizeHeight: Math.max(1, Math.round(canvas.height * s)), resizeQuality: 'medium' });
};

export function processGif(file: File, range: Range, opts: TrackOptions, progress: Progress, cancelled: () => boolean): Promise<TrackResult> {
  return exclusive(async () => {
    let used = 0;
    const base = effective(opts);
    const result = await guarded((attempt) => { used = attempt; return gifRun(file, range, degrade(base, attempt), progress, cancelled); },
      (attempt, where) => progress(1, `Engine crashed while ${where}. Restarting (${attempt + 1}/3)…`));
    return { ...result, notice: noticeFor(effective(opts), used) };
  });
}

async function gifRun(file: File, range: Range, opts: TrackOptions, progress: Progress, cancelled: () => boolean): Promise<TrackResult> {
  progress(2, opts.segment ? 'Starting pose + segmentation engine' : 'Starting pose engine');
  const model = await openEngine('VIDEO', poses(opts), opts.segment, opts.model, false);
  const start = Math.max(0, range.start);
  const end = range.end > start ? Math.min(range.end, start + FRAME_BUDGET / opts.fps) : start + FRAME_BUDGET / opts.fps;
  const stride = Math.max(1, Math.ceil(((end - start) * opts.fps) / GIF_PREVIEW_COUNT));
  let session: Session | null = null;
  let lastSample = -Infinity;
  let sampled = 0;
  const created: ImageBitmap[] = [];
  try {
    for await (const { canvas, time, index, total } of gifFrames(file, FRAME_BUDGET * 2)) {
      if (cancelled()) { created.forEach((b) => b.close()); return emptyResult(opts); }
      if (time > end) break;
      if (time >= start && (time - lastSample >= 1 / opts.fps - 0.001 || !session)) {
        session ??= makeSession(model, opts, canvas.width, canvas.height);
        const delta = sampled ? (time - lastSample) * 1000 : 1000 / opts.fps;
        stage = `detecting poses on GIF frame ${index + 1}`;
        const recorded = session.step(canvas, time - start, delta);
        // Keep a downscaled copy of the exact analysed frame so preview and overlay stay in sync.
        if (recorded && sampled % stride === 0) { const img = await previewOf(canvas); created.push(img); session.setImage(img); }
        sampled++;
        lastSample = time;
      }
      progress(Math.round(5 + ((index + 1) / total) * 93), `Tracking GIF @ ${opts.fps} FPS: frame ${index + 1} of ${total}`);
      if (index % 3 === 0) await yieldUI();
    }
    if (!session) throw new Error('No frames fell inside the selected range.');
    return session.finish(opts.roi ? 'No player found in the selected region. Redraw the box around one full body.' : 'No player was detected. Try selecting the player manually.');
  } catch (e) { created.forEach((b) => b.close()); throw e; } finally { closeEngine(); }
}

/** Detect everyone visible on one frame so the user can click the player to isolate. */
export function detectPeople(file: File, time: number, quality: ModelQuality = 'full'): Promise<Person[]> {
  return exclusive(() => guarded(() => peopleRun(file, time, quality), () => undefined));
}

async function peopleRun(file: File, time: number, quality: ModelQuality): Promise<Person[]> {
  const model = await openEngine('IMAGE', 6, false, quality, true);
  let video: HTMLVideoElement | null = null;
  const url = isGif(file) ? null : URL.createObjectURL(file);
  try {
    let src: CanvasImageSource, w: number, h: number;
    if (isGif(file)) {
      let picked: HTMLCanvasElement | null = null;
      for await (const g of gifFrames(file, FRAME_BUDGET * 2)) { picked = g.canvas; if (g.time >= time) break; }
      if (!picked) return [];
      src = picked; w = picked.width; h = picked.height;
    } else {
      stage = 'loading the video';
      video = await loadVideo(url!);
      await seek(video, clamp(time, 0, Math.max(0, video.duration - 0.05)));
      src = video; w = video.videoWidth; h = video.videoHeight;
    }
    const place = prepare(src, w, h, FULL, probe);
    stage = 'scanning for people';
    const res = model.detect(probe.c);
    const px = res.landmarks.length ? samplePixels(probe.c) : null;
    return res.landmarks.map((lms): Person => {
      const full = lms.map((p) => ({ x: place.x + p.x * place.w, y: place.y + p.y * place.h, visibility: p.visibility }));
      const seen = full.filter((p) => (p.visibility ?? 1) > 0.3);
      const pool = seen.length >= 4 ? seen : full;
      const xs = pool.map((p) => p.x), ys = pool.map((p) => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const bw = Math.min(1, (x1 - x0) * 1.5 + 0.04), bh = Math.min(1, (y1 - y0) * 1.25 + 0.05);
      const jersey = px ? samplePatches(lms, px, SAMPLE_SIZE).jersey : undefined;
      return {
        ...sanitizeRoi({ x: (x0 + x1) / 2 - bw / 2, y: (y0 + y1) / 2 - bh / 2, w: bw, h: bh }),
        color: jersey ? `rgb(${jersey.map((v) => Math.round(v)).join(',')})` : undefined,
      };
    }).sort((a, b) => a.x - b.x);
  } finally {
    if (video) releaseVideo(video);
    if (url) URL.revokeObjectURL(url);
  }
}
