import { useEffect, useLayoutEffect, useRef } from 'react';
import { MEDIAPIPE_CONNECTIONS, type MaskData, type PoseFrame } from './motion';
import type { Person, Rgb, Roi } from './processor';
import type { OtherPlayer } from './SkeletonCanvas';

export type IsolationMode = 'isolate-human' | 'isolate-video' | 'skeleton-overlay';
export type IsolationBackground = 'pitch' | 'black' | 'green' | 'dim';
export type IsolationSettings = {
  background: IsolationBackground;
  /** Mask cut-off, 0..1. Lower keeps more of the edge (hair, boots), higher cuts tighter. */
  threshold: number;
  /** Edge softness in mask pixels. */
  feather: number;
  /** Width multiplier for the pose-hull cutout used when no segmentation mask exists. */
  expand: number;
  showSkeleton: boolean;
};
export const DEFAULT_ISOLATION: IsolationSettings = { background: 'pitch', threshold: 0.5, feather: 1.5, expand: 1, showSkeleton: true };

type Props = {
  frame: PoseFrame;
  mode: IsolationMode;
  sourceUrl: string | null;
  isGif: boolean;
  time: number;
  clipStart: number;
  playing: boolean;
  processing: boolean;
  speed: number;
  fallbackImage: string;
  iso: IsolationSettings;
  roi: Roi | null;
  editingRoi: boolean;
  candidates: Person[];
  /** Eyedropper armed: the next click samples a colour instead of selecting. */
  pickColor: boolean;
  onColorPicked: (rgb: Rgb) => void;
  onRoiDrawn: (roi: Roi) => void;
  onPickCandidate: (roi: Roi) => void;
  /** All-players mode: everyone except the active player. */
  others: OtherPlayer[];
  activeLabel?: string;
  onSelectPlayer?: (id: number) => void;
};

type Fit = { x: number; y: number; w: number; h: number };
const BODY_CONNECTIONS = MEDIAPIPE_CONNECTIONS.filter(([a, b]) => a >= 11 && b >= 11);
const COLORS = { left: '#f17a70', right: '#5ca7ff', mid: '#e5eaf1', head: '#f7cb62' } as const;
const side = (i: number) => (i <= 10 ? 'head' : i % 2 === 1 ? 'left' : 'right');

export default function SourceCanvas(props: Props) {
  const { sourceUrl, isGif, time, clipStart, playing, processing, speed, fallbackImage } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const fitRef = useRef<Fit>({ x: 0, y: 0, w: 1, h: 1 });
  const draftRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dirtyRef = useRef(true);
  const mediaRef = useRef<{ media: CanvasImageSource; mw: number; mh: number } | null>(null);
  const live = useRef(props);
  // Layout effect, not a render-time write: a discarded concurrent render
  // must not publish props the screen never committed.
  useLayoutEffect(() => { live.current = props; });

  // Native playback at the timeline's speed. Without playbackRate the video ran
  // at 1x while the pose timeline ran at e.g. 0.5x, drifting and re-seeking
  // (stuttering) every 0.35s.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isGif || !sourceUrl) return;
    video.playbackRate = Math.min(4, Math.max(0.1, speed));
    if (playing && !processing) {
      if (video.paused) video.play().catch(() => { /* autoplay blocked; scrubbing still works */ });
    } else if (!video.paused) video.pause();
  }, [playing, processing, speed, isGif, sourceUrl]);

  // Seek only on visible drift (or any change while paused, i.e. scrubbing).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isGif || !sourceUrl || processing) return;
    const target = time + clipStart;
    if (!Number.isFinite(target)) return;
    const tolerance = playing ? 0.3 : 0.02;
    if (Math.abs(video.currentTime - target) > tolerance) {
      try { video.currentTime = Math.max(0, target); } catch { /* not seekable yet */ }
    }
  }, [time, clipStart, playing, isGif, sourceUrl, processing]);

  // ONE render loop for the component's lifetime; all inputs read via refs.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const layer = document.createElement('canvas');
    const lctx = layer.getContext('2d')!;
    const maskCanvas = document.createElement('canvas');
    const mctx = maskCanvas.getContext('2d')!;
    const softCanvas = document.createElement('canvas');
    const sctx = softCanvas.getContext('2d')!;
    // Pose-hull alpha mask drawn SMALL (<= 256 px), then scaled onto the layer.
    // Blurring here is cheap; `ctx.filter = blur()` on the full-resolution layer
    // (up to ~5.7 MP at 2x DPR) was the single most expensive thing in the app.
    const hullCanvas = document.createElement('canvas');
    const hctx = hullCanvas.getContext('2d')!;
    const HULL_MAX = 256;
    // The cutout layer is capped at ~1 MP: it is composited with a mask that is
    // itself <= 192 px, so extra layer resolution is invisible.
    const LAYER_MAX = 1024;
    let maskKey: { mask: MaskData; threshold: number; feather: number } | null = null;
    let lastVideoTime = -1;
    let lastImage: ImageBitmap | null = null;
    let lastSource: string | null = null;
    let last: { frame: PoseFrame; mode: string; iso: IsolationSettings; roi: Roi | null; editing: boolean; cands: Roi[]; url: string | null; others: OtherPlayer[] } | null = null;
    let animation = 0;

    /** Threshold + feather a mask into softCanvas. Cached: only rebuilt when the mask or settings change. */
    const buildMask = (mask: MaskData, threshold: number, feather: number) => {
      if (maskKey && maskKey.mask === mask && maskKey.threshold === threshold && maskKey.feather === feather) return;
      if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) { maskCanvas.width = mask.width; maskCanvas.height = mask.height; }
      const img = mctx.createImageData(mask.width, mask.height);
      const lo = (threshold - 0.12) * 255, range = 0.24 * 255;
      for (let i = 0; i < mask.data.length; i++) {
        const a = (mask.data[i] - lo) / range;
        img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
      }
      mctx.putImageData(img, 0, 0);
      const pad = Math.ceil(feather * 2);
      softCanvas.width = mask.width + pad * 2; softCanvas.height = mask.height + pad * 2;
      sctx.clearRect(0, 0, softCanvas.width, softCanvas.height);
      // Blur on a ~192px canvas is cheap, unlike ctx.filter on a full-size frame.
      sctx.filter = feather > 0 ? `blur(${feather}px)` : 'none';
      sctx.drawImage(maskCanvas, pad, pad);
      sctx.filter = 'none';
      maskKey = { mask, threshold, feather };
    };

    const drawBackground = (cw: number, ch: number, bg: IsolationBackground, media: CanvasImageSource | null, fit: Fit) => {
      if (bg === 'green') { ctx.fillStyle = '#00b140'; ctx.fillRect(0, 0, cw, ch); return; }
      ctx.fillStyle = '#05080b'; ctx.fillRect(0, 0, cw, ch);
      if (bg === 'dim' && media) { ctx.globalAlpha = 0.22; ctx.drawImage(media, fit.x, fit.y, fit.w, fit.h); ctx.globalAlpha = 1; return; }
      if (bg === 'pitch') {
        const g = ctx.createRadialGradient(cw / 2, ch / 2, 20, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
        g.addColorStop(0, '#101a1d'); g.addColorStop(1, '#060a0d');
        ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
        ctx.strokeStyle = 'rgba(74,100,90,.2)'; ctx.lineWidth = 1; ctx.beginPath();
        const gy = ch * 0.88;
        for (let x = 0; x <= cw; x += 32) { ctx.moveTo(x, gy); ctx.lineTo(cw / 2 + (x - cw / 2) * 1.6, ch); }
        for (let y = gy; y <= ch; y += 14) { ctx.moveTo(0, y); ctx.lineTo(cw, y); }
        ctx.stroke();
      }
    };

    const draw = () => {
      animation = requestAnimationFrame(draw);
      const p = live.current;
      const video = videoRef.current;
      // Field-wise comparison: a render caused only by the playhead advancing must
      // not invalidate the canvas unless the frame/mode/settings actually changed.
      if (!last || last.frame !== p.frame || last.mode !== p.mode || last.iso !== p.iso || last.roi !== p.roi ||
          last.editing !== p.editingRoi || last.cands !== p.candidates || last.url !== p.sourceUrl || last.others !== p.others) {
        dirtyRef.current = true;
        last = { frame: p.frame, mode: p.mode, iso: p.iso, roi: p.roi, editing: p.editingRoi, cands: p.candidates, url: p.sourceUrl, others: p.others };
      }
      // Never show a previous file's GIF frame (its bitmap may also be closed).
      if (p.sourceUrl !== lastSource) { lastSource = p.sourceUrl; lastImage = null; maskKey = null; }

      // Pick the source: synced GIF frame > live video > static image.
      let media: CanvasImageSource | null = null;
      let mw = 0, mh = 0;
      if (p.isGif && p.frame.image) lastImage = p.frame.image;
      if (p.isGif && lastImage) { media = lastImage; mw = lastImage.width; mh = lastImage.height; }
      else if (!p.isGif && video && p.sourceUrl && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        media = video; mw = video.videoWidth; mh = video.videoHeight;
        if (video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; dirtyRef.current = true; }
      } else if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
        media = imgRef.current; mw = imgRef.current.naturalWidth; mh = imgRef.current.naturalHeight;
      }
      mediaRef.current = media ? { media, mw, mh } : null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.round(rect.width * dpr), ph = Math.round(rect.height * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cw = rect.width, ch = rect.height;

      // CONTAIN fit, shared by media, landmarks, masks and ROI. The old code drew
      // media with "cover" but plotted landmarks at x*canvasWidth, so the overlay
      // drifted off the player whenever the aspect ratios differed.
      const aspect = mw && mh ? mw / mh : 16 / 9;
      const fit: Fit = aspect > cw / ch ? { x: 0, y: (ch - cw / aspect) / 2, w: cw, h: cw / aspect } : { x: (cw - ch * aspect) / 2, y: 0, w: ch * aspect, h: ch };
      fitRef.current = fit;
      const X = (nx: number) => fit.x + nx * fit.w;
      const Y = (ny: number) => fit.y + ny * fit.h;
      // An absent player (multi mode: not in the clip at this moment) is not drawn.
      const pts = p.frame.absent ? undefined : p.frame.landmarks2D;
      const visible = (i: number) => !!pts?.[i] && (pts[i].visibility ?? 1) >= 0.3;
      const present = p.others.filter((o) => !o.frame.absent && o.frame.landmarks2D);

      const safeDraw = (target: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
        // An ImageBitmap from a replaced clip may already be closed.
        try { if (media) target.drawImage(media, x, y, w, h); } catch { /* closed bitmap */ }
      };

      if (p.mode === 'isolate-human') {
        drawBackground(cw, ch, p.iso.background, media, fit);
        /** Add one player's pose hull to the small hull mask (white = keep). */
        const drawHull = (hp: NonNullable<PoseFrame['landmarks2D']>, hb: PoseFrame['bbox']) => {
          const hw = hullCanvas.width, hh = hullCanvas.height;
          const vis = (i: number) => !!hp[i] && (hp[i].visibility ?? 1) >= 0.3;
          const body = Math.max(6, ((hb?.[3] ?? 1) - (hb?.[1] ?? 0)) * hh);
          const lx = (i: number) => hp[i].x * hw, ly = (i: number) => hp[i].y * hh;
          hctx.fillStyle = '#fff'; hctx.strokeStyle = '#fff';
          hctx.lineCap = 'round'; hctx.lineJoin = 'round';
          hctx.lineWidth = body * 0.1 * p.iso.expand;
          hctx.beginPath();
          for (const [a, b] of BODY_CONNECTIONS) if (vis(a) && vis(b)) { hctx.moveTo(lx(a), ly(a)); hctx.lineTo(lx(b), ly(b)); }
          hctx.stroke();
          if ([11, 12, 24, 23].every(vis)) {
            hctx.beginPath(); hctx.moveTo(lx(11), ly(11)); hctx.lineTo(lx(12), ly(12)); hctx.lineTo(lx(24), ly(24)); hctx.lineTo(lx(23), ly(23)); hctx.closePath(); hctx.fill();
          }
          const headIdx = [0, 7, 8].filter(vis);
          if (headIdx.length) {
            const hx = headIdx.reduce((s2, i) => s2 + lx(i), 0) / headIdx.length;
            const hy = headIdx.reduce((s2, i) => s2 + ly(i), 0) / headIdx.length;
            hctx.beginPath(); hctx.arc(hx, hy, body * 0.075 * p.iso.expand, 0, Math.PI * 2); hctx.fill();
          }
        };
        if (media && (p.frame.mask || pts || present.length)) {
          const lscale = Math.min(1, LAYER_MAX / Math.max(fit.w * dpr, fit.h * dpr));
          const lw = Math.max(1, Math.round(fit.w * dpr * lscale)), lh = Math.max(1, Math.round(fit.h * dpr * lscale));
          if (layer.width !== lw || layer.height !== lh) { layer.width = lw; layer.height = lh; }
          lctx.setTransform(1, 0, 0, 1, 0, 0);
          lctx.globalCompositeOperation = 'source-over';
          lctx.clearRect(0, 0, lw, lh);
          safeDraw(lctx, 0, 0, lw, lh);
          // Build ONE small alpha mask: the active player's pixel mask (if any),
          // plus pose hulls for the active player without a mask and for every
          // other present player. Then apply it to the layer in a single
          // destination-in draw. One blur on a <=256 px canvas replaces what used
          // to be a blur per player on the full-resolution layer.
          const mask = p.frame.mask;
          const hs = Math.min(1, HULL_MAX / Math.max(lw, lh));
          const hw = Math.max(1, Math.round(lw * hs)), hh = Math.max(1, Math.round(lh * hs));
          if (hullCanvas.width !== hw || hullCanvas.height !== hh) { hullCanvas.width = hw; hullCanvas.height = hh; }
          hctx.setTransform(1, 0, 0, 1, 0, 0);
          hctx.globalCompositeOperation = 'source-over';
          hctx.filter = 'none';
          hctx.clearRect(0, 0, hw, hh);
          if (mask) {
            buildMask(mask, p.iso.threshold, p.iso.feather);
            const [rx, ry, rw, rh] = mask.rect;
            const pad = (softCanvas.width - mask.width) / 2;
            const sx = (rw * hw) / mask.width, sy = (rh * hh) / mask.height;
            hctx.imageSmoothingEnabled = true;
            hctx.drawImage(softCanvas, rx * hw - pad * sx, ry * hh - pad * sy, softCanvas.width * sx, softCanvas.height * sy);
          } else if (pts) {
            drawHull(pts, p.frame.bbox);
          }
          for (const o of present) drawHull(o.frame.landmarks2D!, o.frame.bbox);
          lctx.globalCompositeOperation = 'destination-in';
          lctx.imageSmoothingEnabled = true;
          // Feather the hull edges (the pixel mask is already feathered in buildMask).
          lctx.filter = !mask && p.iso.feather > 0 ? `blur(${Math.min(6, p.iso.feather * 1.5)}px)` : 'none';
          lctx.drawImage(hullCanvas, 0, 0, lw, lh);
          lctx.filter = 'none';
          lctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(layer, fit.x, fit.y, fit.w, fit.h);
        }
        if (!p.frame.mask && pts && media) {
          ctx.fillStyle = 'rgba(8,14,12,.82)'; ctx.fillRect(fit.x + 8, fit.y + fit.h - 26, 178, 18);
          ctx.fillStyle = '#e7b85c'; ctx.font = '500 9px "IBM Plex Mono", monospace';
          ctx.fillText('APPROX. POSE-HULL CUTOUT', fit.x + 14, fit.y + fit.h - 13);
        }
      } else {
        ctx.fillStyle = '#0b1117'; ctx.fillRect(0, 0, cw, ch);
        if (media) safeDraw(ctx, fit.x, fit.y, fit.w, fit.h);
      }

      // Subject ROI, candidates, and the in-progress manual selection.
      const box = (r: Roi, color: string, label: string, dash: number[]) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
        ctx.strokeRect(X(r.x), Y(r.y), r.w * fit.w, r.h * fit.h);
        ctx.setLineDash([]);
        ctx.font = '600 9px "IBM Plex Mono", monospace';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(8,14,12,.85)'; ctx.fillRect(X(r.x), Y(r.y) - 16, tw, 15);
        ctx.fillStyle = color; ctx.fillText(label, X(r.x) + 5, Y(r.y) - 5);
      };
      p.candidates.forEach((c, i) => {
        box(c, '#f7cb62', `PERSON ${i + 1} · CLICK`, [5, 4]);
        if (c.color) { // the jersey colour the matcher would lock onto
          ctx.fillStyle = c.color; ctx.fillRect(X(c.x) + 4, Y(c.y) + 4, 11, 11);
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(X(c.x) + 4.5, Y(c.y) + 4.5, 10, 10);
        }
      });
      if (p.roi && p.mode !== 'isolate-video') box(p.roi, '#b8f675', p.editingRoi ? 'SUBJECT · REDRAW' : 'SUBJECT REGION', [6, 4]);
      const d = draftRef.current;
      if (d) box({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }, '#ffffff', 'NEW SUBJECT', [3, 3]);

      if (p.mode === 'isolate-video') return;
      const showSkeleton = p.mode === 'skeleton-overlay' || p.iso.showSkeleton;
      if (p.mode === 'skeleton-overlay' && p.frame.bbox) {
        const [x0, y0, x1, y1] = p.frame.bbox;
        ctx.strokeStyle = 'rgba(184,246,117,.35)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.strokeRect(X(x0), Y(y0), (x1 - x0) * fit.w, (y1 - y0) * fit.h); ctx.setLineDash([]);
      }
      if (showSkeleton) {
        for (const o of present) {
          const op = o.frame.landmarks2D!;
          const ov = (i: number) => !!op[i] && (op[i].visibility ?? 1) >= 0.3;
          ctx.globalAlpha = o.frame.held ? 0.4 : 0.9;
          ctx.strokeStyle = o.color; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
          ctx.beginPath();
          for (const [a, b] of MEDIAPIPE_CONNECTIONS) if (a >= 11 && b >= 11 && ov(a) && ov(b)) { ctx.moveTo(X(op[a].x), Y(op[a].y)); ctx.lineTo(X(op[b].x), Y(op[b].y)); }
          ctx.stroke();
          if (o.frame.bbox) {
            const [bx0, by0] = o.frame.bbox;
            ctx.font = '700 10px "IBM Plex Mono", monospace';
            const tw = ctx.measureText(o.label).width + 8;
            ctx.fillStyle = 'rgba(8,14,12,.85)'; ctx.fillRect(X(bx0), Y(by0) - 15, tw, 14);
            ctx.fillStyle = o.color; ctx.fillText(o.label, X(bx0) + 4, Y(by0) - 4);
          }
          ctx.globalAlpha = 1;
        }
        if (p.activeLabel && pts && p.frame.bbox) {
          const [bx0, by0] = p.frame.bbox;
          ctx.font = '700 10px "IBM Plex Mono", monospace';
          const label = `${p.activeLabel} ★ ACTIVE`;
          const tw = ctx.measureText(label).width + 8;
          ctx.fillStyle = '#b8f675'; ctx.fillRect(X(bx0), Y(by0) - 15, tw, 14);
          ctx.fillStyle = '#0b1117'; ctx.fillText(label, X(bx0) + 4, Y(by0) - 4);
        }
      }
      if (!showSkeleton || !pts || pts.length < 33) return;

      // Batched per colour group; a bone is "left"/"right" only if BOTH ends are.
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (const group of ['left', 'right', 'mid', 'head'] as const) {
        ctx.strokeStyle = COLORS[group]; ctx.beginPath();
        for (const [a, b] of MEDIAPIPE_CONNECTIONS) {
          if (!visible(a) || !visible(b)) continue;
          const sa = side(a), sb = side(b);
          const g = sa === 'head' && sb === 'head' ? 'head' : sa === sb ? sa : 'mid';
          if (g !== group) continue;
          ctx.moveTo(X(pts[a].x), Y(pts[a].y)); ctx.lineTo(X(pts[b].x), Y(pts[b].y));
        }
        ctx.stroke();
      }
      for (const group of ['head', 'left', 'right'] as const) {
        ctx.fillStyle = COLORS[group]; ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          if (!visible(i) || side(i) !== group) continue;
          const r = group === 'head' ? 3 : 4;
          ctx.moveTo(X(pts[i].x) + r, Y(pts[i].y)); ctx.arc(X(pts[i].x), Y(pts[i].y), r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    };

    animation = requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => { dirtyRef.current = true; });
    observer.observe(canvas);
    return () => { cancelAnimationFrame(animation); observer.disconnect(); };
  }, []);

  /** Average a small patch of the SOURCE frame (not the canvas), so overlays can't pollute the colour. */
  const sampleColor = (nx: number, ny: number): Rgb | null => {
    const m = mediaRef.current;
    if (!m) return null;
    const c = document.createElement('canvas');
    c.width = 9; c.height = 9;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (!cx) return null;
    try {
      cx.drawImage(m.media, Math.round(nx * m.mw) - 4, Math.round(ny * m.mh) - 4, 9, 9, 0, 0, 9, 9);
      const d = cx.getImageData(0, 0, 9, 9).data;
      let R = 0, G = 0, B = 0;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      const n = d.length / 4;
      return [R / n, G / n, B / n];
    } catch { return null; }
  };

  /** Canvas pixel -> normalized frame coordinate, using the same fit as drawing. */
  const toNorm = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = fitRef.current;
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left - f.x) / f.w)), y: Math.min(1, Math.max(0, (e.clientY - r.top - f.y) / f.h)) };
  };

  return (
    <div className="source-canvas-wrap">
      {sourceUrl && !isGif ? (
        <video ref={videoRef} src={sourceUrl} muted playsInline preload="auto" className="hidden-media" />
      ) : (
        <img ref={imgRef} src={sourceUrl || fallbackImage} alt="" className="hidden-media" crossOrigin={sourceUrl ? undefined : 'anonymous'} />
      )}
      <canvas
        ref={canvasRef}
        className={`source-canvas ${props.pickColor ? 'color-picking' : props.editingRoi ? 'roi-editing' : props.candidates.length || props.others.length ? 'roi-picking' : ''}`}
        aria-label="Source footage with isolation view"
        onPointerDown={(e) => {
          const n = toNorm(e);
          if (props.pickColor) {
            const rgb = sampleColor(n.x, n.y);
            if (rgb) props.onColorPicked(rgb);
            return;
          }
          const hit = props.candidates.find((c) => n.x >= c.x && n.x <= c.x + c.w && n.y >= c.y && n.y <= c.y + c.h);
          if (hit && !props.editingRoi) { props.onPickCandidate(hit); return; }
          if (!props.editingRoi && props.onSelectPlayer) {
            const who = props.others.find((o) => !o.frame.absent && o.frame.bbox && n.x >= o.frame.bbox[0] && n.x <= o.frame.bbox[2] && n.y >= o.frame.bbox[1] && n.y <= o.frame.bbox[3]);
            if (who) { props.onSelectPlayer(who.id); return; }
          }
          if (!props.editingRoi) return;
          draftRef.current = { x0: n.x, y0: n.y, x1: n.x, y1: n.y };
          e.currentTarget.setPointerCapture(e.pointerId);
          dirtyRef.current = true;
        }}
        onPointerMove={(e) => {
          if (!draftRef.current) return;
          const n = toNorm(e);
          draftRef.current = { ...draftRef.current, x1: n.x, y1: n.y };
          dirtyRef.current = true;
        }}
        onPointerUp={() => {
          const d = draftRef.current;
          draftRef.current = null;
          dirtyRef.current = true;
          if (!d) return;
          const roi = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
          if (roi.w > 0.03 && roi.h > 0.05) props.onRoiDrawn(roi);
        }}
        onPointerCancel={() => { draftRef.current = null; dirtyRef.current = true; }}
      />
    </div>
  );
}
