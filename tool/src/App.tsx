import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Anchor, ArrowDownToLine, Users, ArrowRight, Check, ChevronDown, CircleHelp,
  Code2, Crosshair, Eye, FileVideo2, Gauge, Layers3, Menu, Pause, Play,
  RotateCcw, Scissors, Settings2, SlidersHorizontal, Sparkles, UploadCloud, UserCheck, Video, Wand2
} from 'lucide-react';
import SkeletonCanvas, { DEFAULT_STYLE, THEMES, type OtherPlayer, type SceneView, type SkeletonStyle, type ThemeName } from './SkeletonCanvas';
import SourceCanvas, { DEFAULT_ISOLATION, type IsolationMode, type IsolationSettings } from './SourceCanvas';
import { demoFrame, exportAnimation, gzipJson, groundLockFrames, jitterScore, MOVEMENTS, resampleFrames, smoothFrames, type ExportOptions, type Movement, type PoseFrame } from './motion';
import { detectPeople, probeDuration, processGif, processVideo, type ColorRole, type ColorTarget, type ModelQuality, type Patches, type Person, type PlayerTrack, type Rgb, type Roi, type TargetFps } from './processor';
import Sections from './Sections';
import './index.css';

// Stable module-level fallback. Previously `demoFrame('kick', 0)` was called
// inline during render, producing a new object identity every frame and forcing
// SkeletonCanvas to re-run its whole render effect even when idle.
const FALLBACK_FRAME = demoFrame('kick', 0);
// Shown for uploaded footage before tracking: no 2D landmarks, so the demo
// skeleton is never drawn over the user's video.
const BLANK_FRAME: PoseFrame = { ...FALLBACK_FRAME, landmarks2D: undefined, bbox: undefined };
const NO_FRAMES: PoseFrame[] = [];

const IMAGE = 'https://images.pexels.com/photos/12616082/pexels-photo-12616082.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=900&w=1400';
const movementKeys = Object.keys(MOVEMENTS) as Movement[];
const themeKeys = Object.keys(THEMES) as ThemeName[];

const isGifFile = (file: File) => file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}.${String(Math.floor((safe % 1) * 10))}`;
}

export default function App() {
  const [movement, setMovement] = useState<Movement>('kick');
  // Original tracked output + the FPS it was sampled at. Retimed views are
  // derived from this, so 60 -> 15 -> 60 no longer destroys samples (the old
  // code overwrote the frames with each interpolated copy).
  const [tracked, setTracked] = useState<{ frames: PoseFrame[]; fps: TargetFps; players?: PlayerTrack[] } | null>(null);
  // All-players tracking
  const [trackMode, setTrackMode] = useState<'single' | 'all'>('single');
  const [maxPeople, setMaxPeople] = useState(6);
  const [activePlayerId, setActivePlayerId] = useState<number | null>(null);
  const [showOthers, setShowOthers] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [status, setStatus] = useState<'demo' | 'processing' | 'ready' | 'error'>('demo');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [smoothing, setSmoothing] = useState(48);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0.9);
  const [speed, setSpeed] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [rotation, setRotation] = useState(-0.15);
  const [dragging, setDragging] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [copied, setCopied] = useState(false);

  // New: Isolation mode for human vs video vs overlay
  const [isolationMode, setIsolationMode] = useState<IsolationMode>('skeleton-overlay');

  // New: Configurable pipeline FPS (15, 30, or 60)
  const [targetFps, setTargetFps] = useState<TargetFps>(30);

  // Manual human isolation
  const [iso, setIso] = useState<IsolationSettings>(DEFAULT_ISOLATION);
  const [roi, setRoi] = useState<Roi | null>(null);
  const [editingRoi, setEditingRoi] = useState(false);
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [followSubject, setFollowSubject] = useState(true);
  const [segment, setSegment] = useState(true);
  // Player identity lock (position + colour association across several detections per frame)
  const [identityOn, setIdentityOn] = useState(true);
  const [strictness, setStrictness] = useState(65);
  const [colorTargets, setColorTargets] = useState<ColorTarget[]>([]);
  const [pickRole, setPickRole] = useState<ColorRole>('jersey');
  const [picking, setPicking] = useState(false);
  const [modelQuality, setModelQuality] = useState<ModelQuality>('full');
  const [trackInfo, setTrackInfo] = useState<{ notice?: string; total: number; held: number; rejected: number; learned: Patches | null; segmentation: boolean } | null>(null);
  // Anti-levitation: pin the lowest foot to the floor until this many seconds.
  const [groundLock, setGroundLock] = useState(false);
  const [groundLockUntil, setGroundLockUntil] = useState(2);
  // Export settings. Compact + 3 dp is ~8x smaller than the old pretty-printed layout.
  const [exportLayout, setExportLayout] = useState<'compact' | 'verbose'>('compact');
  const [exportPrecision, setExportPrecision] = useState(3);
  const [exportRotations, setExportRotations] = useState(true);
  const [exportGzip, setExportGzip] = useState(false);
  const [exportSize, setExportSize] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Input (process) trim
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(0);

  // Output (play / export) trim
  const [playIn, setPlayIn] = useState(0);
  const [playOut, setPlayOut] = useState(4);
  const [paramTab, setParamTab] = useState<'skeleton' | 'timing' | 'isolate'>('isolate');
  const [style, setStyle] = useState<SkeletonStyle>(DEFAULT_STYLE);

  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(0);
  const sourceUrlRef = useRef<string | null>(null);

  // When in demo mode, generate frames at targetFps (30 or 60)
  const demoStep = 1 / targetFps;
  const demoFrames = useMemo(() => {
    const count = Math.round(4 * targetFps);
    return Array.from({ length: count }, (_, i) => demoFrame(movement, i * demoStep));
  }, [movement, targetFps, demoStep]);

  const players = tracked?.players ?? null;
  const activePlayer = useMemo(() => (players ? players.find((pl) => pl.id === activePlayerId) ?? players[0] : null), [players, activePlayerId]);
  const rawFrames = useMemo(
    () => {
      if (!tracked) return null;
      const base = activePlayer?.frames ?? tracked.frames;
      return tracked.fps === targetFps ? base : resampleFrames(base, targetFps);
    },
    [tracked, targetFps, activePlayer]
  );
  // Release decoded GIF frames when a clip is replaced.
  useEffect(() => () => {
    // Bitmaps are shared between players; close() is idempotent.
    tracked?.frames.forEach((f) => f.image?.close());
    tracked?.players?.forEach((pl) => pl.frames.forEach((f) => f.image?.close()));
  }, [tracked]);

  const source = rawFrames ?? (file ? NO_FRAMES : demoFrames);
  const clipDuration = source.at(-1)?.time ?? (file ? Math.max(0.1, clipEnd - clipStart) : 4);

  // Dragging the smoothing slider re-runs a 21-joint x 3-axis filter bank over
  // up to 900 frames. Deferring keeps the slider itself at 60fps and settles
  // the expensive recompute once the drag pauses.
  const deferredSmoothing = useDeferredValue(smoothing);
  const smoothed = useMemo(() => smoothFrames(source, deferredSmoothing), [source, deferredSmoothing]);
  const frames = useMemo(
    () => (groundLock ? groundLockFrames(smoothed, Math.min(groundLockUntil, smoothed.at(-1)?.time ?? 0)) : smoothed),
    [smoothed, groundLock, groundLockUntil]
  );
  // Same per-player pipeline as the active player. Runs for display only when
  // the others are shown (otherwise every slider drag re-filtered up to 11
  // players x 900 frames x 63 series for nothing); export calls it on demand.
  const processPlayer = useCallback((pl: PlayerTrack, smoothingAmount: number) => {
    const base = tracked && tracked.fps === targetFps ? pl.frames : resampleFrames(pl.frames, targetFps);
    const sm = smoothFrames(base, smoothingAmount);
    return groundLock ? groundLockFrames(sm, Math.min(groundLockUntil, sm.at(-1)?.time ?? 0)) : sm;
  }, [tracked, targetFps, groundLock, groundLockUntil]);
  const otherPlayers = useMemo(() => {
    if (!players || !showOthers) return [];
    return players.filter((pl) => pl.id !== activePlayer?.id).map((pl) => ({ id: pl.id, label: pl.label, color: pl.color, frames: processPlayer(pl, deferredSmoothing) }));
  }, [players, showOthers, activePlayer, processPlayer, deferredSmoothing]);

  // Static camera fit over the WHOLE clip, so the 3D view never drifts or zooms per frame.
  const sceneView = useMemo<SceneView | null>(() => {
    if (!players || players.length < 2 || !showOthers) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const pl of players) for (const f of pl.frames) {
      if (f.absent) continue;
      const pv = f.joints.pelvis;
      x0 = Math.min(x0, pv.x); x1 = Math.max(x1, pv.x); z0 = Math.min(z0, pv.z); z1 = Math.max(z1, pv.z);
    }
    if (!Number.isFinite(x0)) return null;
    const extent = Math.max(x1 - x0, z1 - z0, 1) / 2 + 0.8;
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, zoom: Math.min(1, 1.6 / extent) };
  }, [players, showOthers]);

  // Live, measurable vibration readout so smoothing is verified rather than guessed.
  const jitter = useMemo(() => jitterScore(frames), [frames]);

  // Reset output trim + playhead whenever the underlying clip changes
  useEffect(() => {
    setPlayIn(0);
    setPlayOut(clipDuration);
    setTime(0);
    setPlaying(true);
    // Keyed on the clip, not on `source`: switching the active player (or FPS)
    // must keep the playhead and trim, otherwise every switch jumped to 0:00.
  }, [tracked, movement, file]); // eslint-disable-line react-hooks/exhaustive-deps

  const inPoint = Math.min(playIn, playOut);
  const outPoint = Math.max(playIn, playOut);

  // Binary search (frames are time-sorted) instead of a linear scan per tick.
  const frameIndex = useMemo(() => {
    let lo = 0, hi = frames.length - 1;
    if (hi < 1) return 0;
    while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].time < time) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(frames[lo - 1].time - time) <= Math.abs(frames[lo].time - time) ? lo - 1 : lo;
  }, [frames, time]);

  const activeFrame = frames[frameIndex] ?? (file ? BLANK_FRAME : FALLBACK_FRAME);
  const othersNow = useMemo<OtherPlayer[]>(() => otherPlayers.map((o) => {
    // Binary search per player: all players share the same timeline.
    const fr = o.frames;
    let lo = 0, hi = fr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].time < time) lo = m + 1; else hi = m; }
    return { id: o.id, label: o.label, color: o.color, frame: fr[lo] };
  }), [otherPlayers, time]);
  const activeLabel = players && players.length > 1 ? activePlayer?.label : undefined;

  useEffect(() => {
    if (!playing || status === 'processing') return;
    let animation = 0;
    let previous = performance.now();
    let acc = 0;
    // A state update re-renders the whole app. Updating at the clip's own frame
    // rate (not the display's 60-144 Hz) gives identical visible motion - the
    // pose can only change once per clip frame - at a fraction of the React work.
    const minStep = 1 / Math.max(15, targetFps);
    const tick = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      acc += delta;
      if (acc >= minStep) {
        const adv = acc;
        acc = 0;
        setTime((current) => {
          const next = current + adv * speed;
          return next >= outPoint || next < inPoint ? inPoint : next;
        });
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, speed, inPoint, outPoint, status, targetFps]);

  useEffect(() => () => { cancelRef.current++; if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current); }, []);

  const chooseMovement = useCallback((value: Movement) => {
    cancelRef.current++;
    setMovement(value);
    setTracked(null);
    setFile(null);
    setRoi(null);
    setCandidates([]);
    setEditingRoi(false);
    setPicking(false);
    setTrackInfo(null);
    setStatus('demo');
    setMessage('');
    setPlaying(true);
    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
      setSourceUrl(null);
    }
  }, []);

  const runTracking = async (candidate: File, range: { start: number; end: number }, fps: TargetFps, subject?: Roi | null, modeOverride?: 'single' | 'all') => {
    const token = ++cancelRef.current;
    setTracked(null);
    setTrackInfo(null);
    setPicking(false);
    setCandidates([]);
    setEditingRoi(false);
    setStatus('processing');
    setProgress(0);
    setTime(0);
    setPlaying(false);
    setMessage(`Loading pose model @ ${fps} FPS`);
    try {
      const onProgress = (value: number, label: string) => {
        if (token === cancelRef.current) {
          setProgress(value);
          setMessage(label);
        }
      };
      const cancelled = () => token !== cancelRef.current;
      const opts = {
        fps, roi: subject === undefined ? roi : subject, follow: followSubject, segment, model: modelQuality,
        identity: { enabled: identityOn, strictness: strictness / 100, targets: colorTargets },
        mode: modeOverride ?? trackMode, maxPeople,
      };
      const result = await (isGifFile(candidate)
        ? processGif(candidate, range, opts, onProgress, cancelled)
        : processVideo(candidate, range, opts, onProgress, cancelled));

      if (cancelled()) { result.frames.forEach((f) => f.image?.close()); return; }
      if (result.frames.length < 2) throw new Error('Not enough usable poses were found. Try a longer range or a clearer clip.');
      setTracked({ frames: result.frames, fps, players: result.players });
      setActivePlayerId(result.players?.[0]?.id ?? null);
      setTrackInfo({ notice: result.notice, ...result.stats });
      setStatus('ready');
      setMessage(`${result.frames.length} frames tracked @ ${fps} FPS`);
      setTime(0);
      setPlaying(true);
    } catch (error) {
      if (token !== cancelRef.current) return;
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not process this file.');
    }
  };

  const handleFile = async (candidate?: File) => {
    if (!candidate) return;
    if (!isGifFile(candidate) && !candidate.type.startsWith('video/')) {
      setMessage('Choose an RGB video or animated GIF file.');
      setStatus('error');
      return;
    }
    const token = ++cancelRef.current;
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    const url = URL.createObjectURL(candidate);
    sourceUrlRef.current = url;
    setSourceUrl(url);
    setFile(candidate);
    setTracked(null);
    setRoi(null);
    setCandidates([]);
    setEditingRoi(false);
    setStatus('processing');
    setProgress(0);
    setMessage('Reading source metadata');

    let duration = 0;
    try { duration = await probeDuration(candidate); } catch { duration = 0; }
    if (token !== cancelRef.current) return;
    setSourceDuration(duration);
    setClipStart(0);
    setClipEnd(duration);
    await runTracking(candidate, { start: 0, end: duration }, targetFps, null);
  };

  const exportFrames = useMemo(
    () => frames.filter((f) => f.time >= inPoint - 1e-4 && f.time <= outPoint + 1e-4).map((f) => ({ ...f, time: f.time - inPoint })),
    [frames, inPoint, outPoint]
  );

  // Changing FPS re-times an already-tracked clip by interpolation instead of
  // forcing another full pose-estimation pass over the source file. Re-tracking
  // is more accurate (real landmark samples) but costs another inference run.
  const changeFps = (next: TargetFps, mode: 'retime' | 'retrack') => {
    setTargetFps(next);
    if (mode === 'retime') return; // derived from `tracked` via useMemo
    if (file) runTracking(file, { start: clipStart, end: clipEnd }, next);
  };

  const previewMovement = useCallback(() => {
    chooseMovement(movement);
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth' });
  }, [chooseMovement, movement]);

  // --- Colour lock ---------------------------------------------------------
  const addColor = (rgb: Rgb) => {
    setColorTargets((t) => [...t, { id: `${Date.now()}-${t.length}`, role: pickRole, rgb }].slice(-4));
    setPicking(false);
    setPlaying(true);
  };
  const removeColor = (id: string) => setColorTargets((t) => t.filter((c) => c.id !== id));
  const retrackWithLock = () => { if (file) runTracking(file, { start: clipStart, end: clipEnd }, targetFps); };
  const css = (c: Rgb) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

  // --- Manual human isolation -------------------------------------------
  const findPeople = async () => {
    if (!file || detecting) return;
    // Supersede any in-flight tracking FIRST: the people-scan is queued behind
    // it, and the cancelled run now exits at the next frame instead of racing.
    cancelRef.current++;
    // The superseded tracking run returns early WITHOUT touching `status`, so it
    // would stay 'processing' forever: the overlay never cleared and the person
    // boxes below could not render. Restore a visible state before scanning.
    setStatus(tracked ? 'ready' : 'demo');
    setDetecting(true); setEditingRoi(false); setPicking(false); setPlaying(false);
    try {
      const people = await detectPeople(file, clipStart + time, modelQuality);
      setCandidates(people);
      setMessage(people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'} found. Click one to isolate.` : 'No people found on this frame. Draw the region manually.');
      if (!people.length) setEditingRoi(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Person detection failed.');
    } finally { setDetecting(false); }
  };
  const applySubject = (subject: Roi) => {
    setRoi(subject); setCandidates([]); setEditingRoi(false);
    if (file) runTracking(file, { start: clipStart, end: clipEnd }, targetFps, subject);
  };
  const clearSubject = () => {
    setRoi(null); setCandidates([]); setEditingRoi(false);
    if (file) runTracking(file, { start: clipStart, end: clipEnd }, targetFps, null);
  };

  const download = async () => {
    const opts: ExportOptions = { layout: exportLayout, precision: exportPrecision, rotations: exportRotations };
    const trim = (fr: PoseFrame[]) => {
      const t = fr.filter((f) => f.time >= inPoint - 1e-4 && f.time <= outPoint + 1e-4).map((f) => ({ ...f, time: f.time - inPoint }));
      return t.length >= 2 ? t : fr;
    };
    const activeFr = exportFrames.length >= 2 ? exportFrames : frames;
    const single = exportAnimation(activeFr, file?.name ?? `demo-${movement}`, opts);
    // Multi-player: every player on the shared timeline and scene. Frames where a
    // player is not in the clip carry p:0 (compact) / present:false (verbose).
    const presence = (exp: ReturnType<typeof exportAnimation>, fr: PoseFrame[]) =>
      ({ ...exp, frames: exp.frames.map((f, i) => (fr[i]?.absent ? { ...f, ...(exportLayout === 'compact' ? { p: 0 } : { present: false }) } : f)) });
    const data = players && players.length > 1 ? {
      format: exportLayout === 'compact' ? 'fieldmotion.multi.v2' : 'fieldmotion.multi.v1',
      source: file?.name ?? 'clip', coordinateSystem: single.coordinateSystem,
      note: `One entry per tracked player, all in one shared scene and timeline. ${exportLayout === 'compact' ? 'p:0' : 'present:false'} marks frames where the player is not in the clip.`,
      players: [
        { id: activePlayer!.id, label: activePlayer!.label, color: activePlayer!.color, coverage: activePlayer!.coverage, ...presence(single, activeFr) },
        ...players.filter((pl) => pl.id !== activePlayer?.id).map((pl) => {
          const fr = trim(processPlayer(pl, smoothing));
          return { id: pl.id, label: pl.label, color: pl.color, coverage: pl.coverage, ...presence(exportAnimation(fr, file?.name ?? 'clip', opts), fr) };
        }),
      ],
    } : single;
    // No pretty-printing: indentation alone was ~40% of the old file.
    const text = JSON.stringify(data);
    const gz = exportGzip ? await gzipJson(text) : null;
    const blob = gz ?? new Blob([text], { type: 'application/json' });
    const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);
    setExportSize(gz ? `${kb(blob.size)} gzipped (${kb(text.length)} raw)` : kb(blob.size));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const base = `${(file?.name ?? movement).replace(/\.[^.]+$/, '')}-${players && players.length > 1 ? `${players.length}-players-` : ''}${targetFps}fps-motion`;
    link.download = gz ? `${base}.json.gz` : `${base}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyFlow = useCallback(async () => {
    const text = 'Video / GIF Input -> Pose Estimation -> Coordinate Extraction -> One-Euro Smoothing -> Rig Retargeting -> 3D Animation Output';
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('async clipboard unavailable');
      setCopied(true);
    } catch {
      // Fallback for non-secure contexts, where the async clipboard API is absent.
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); } catch { /* nothing more we can do */ }
      ta.remove();
    }
    setTimeout(() => setCopied(false), 1800);
  }, []);

  const randomize = () =>
    setStyle((s) => ({
      ...s,
      size: 0.82 + Math.random() * 0.5,
      height: 0.82 + Math.random() * 0.45,
      build: 0.75 + Math.random() * 0.6,
      jointSize: 3.5 + Math.random() * 5,
      boneThickness: 1 + Math.random() * 3,
      theme: themeKeys[Math.floor(Math.random() * themeKeys.length)],
      glow: Math.random() > 0.5,
    }));

  const sliderStyle = (value: number, min: number, max: number) =>
    ({ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties);

  const clipLabel = file ? (isGifFile(file) ? 'GIF' : 'VIDEO') : 'REFERENCE';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><span /><span /><span /><span /></div>
          <div className="brand-type">FIELD<span>MOTION</span><small>CAPTURE STUDIO</small></div>
        </div>
        <div className="sidebar-group-label">WORKSPACE</div>
        <nav className="side-nav">
          <a href="#studio" className="nav-item active" onClick={() => setMobileMenu(false)}>
            <Activity size={17} /> Motion studio <span className="nav-active-line" />
          </a>
          <a href="#pipeline" className="nav-item" onClick={() => setMobileMenu(false)}>
            <Layers3 size={17} /> Pipeline
          </a>
          <a href="#mechanics" className="nav-item" onClick={() => setMobileMenu(false)}>
            <Crosshair size={17} /> Football mechanics
          </a>
          <a href="#implementation" className="nav-item" onClick={() => setMobileMenu(false)}>
            <Code2 size={17} /> Implementation
          </a>
        </nav>
        <div className="sidebar-group-label sample-label">MOTION LIBRARY</div>
        <div className="sample-list">
          {movementKeys.map((key) => (
            <button
              key={key}
              className={`sample-item ${movement === key && status === 'demo' ? 'selected' : ''}`}
              onClick={() => chooseMovement(key)}
            >
              <span className="sample-dot" />{MOVEMENTS[key].label}<ArrowRight size={14} />
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <span className="online-dot" /> LOCAL PROCESSING <span className="version">V 1.2 • {targetFps}FPS</span>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button className="mobile-toggle" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle menu">
            <Menu size={21} />
          </button>
          <div className="topbar-crumb">Workspace <span>/</span> <strong>Motion studio</strong></div>
          <div className="topbar-right">
            <span className="topbar-status"><span /> ENGINE READY ({targetFps} FPS)</span>
            <a href="#implementation" className="help-link"><CircleHelp size={17} /> Documentation</a>
          </div>
        </header>

        <main>
          <section id="studio" className="studio-section">
            <div className="page-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> HUMAN MOTION INTELLIGENCE / 001</div>
                <h1>Motion <em>Studio</em><span className="heading-period">.</span></h1>
                <p>Turn football footage into clean, rig-ready 3D motion with real-time human isolation and high-rate 30/60 FPS extraction.</p>
              </div>
              <div className="heading-actions">
                {/* Quick FPS selector right in the header */}
                <div className="fps-pill" title="Target capture frame rate">
                  <Gauge size={14} />
                  <span>FPS:</span>
                  {([15, 30, 60] as TargetFps[]).map((f) => (
                    <button
                      key={f}
                      className={targetFps === f ? 'fps-btn-active' : ''}
                      onClick={() => changeFps(f, 'retime')}
                      title={`Retime playback at ${f} FPS`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <button className="primary-button heading-upload" onClick={() => inputRef.current?.click()}>
                  <UploadCloud size={17} /> Upload footage
                </button>
              </div>
            </div>

            <div className="workspace-grid">
              {/* PANE 1: SOURCE FOOTAGE & HUMAN ISOLATION */}
              <div className="workspace-pane source-pane">
                <div className="pane-toolbar">
                  <div className="pane-title">
                    <span className="pane-number">01</span>
                    <span>Source & Isolation</span>
                  </div>
                  <div className="toolbar-right">
                    {/* View isolation toggles */}
                    <div className="isolation-chips">
                      <button
                        className={isolationMode === 'isolate-human' ? 'iso-active' : ''}
                        onClick={() => setIsolationMode('isolate-human')}
                        title="Isolate player on dark pitch canvas"
                      >
                        <UserCheck size={13} /> Isolate human
                      </button>
                      <button
                        className={isolationMode === 'skeleton-overlay' ? 'iso-active' : ''}
                        onClick={() => setIsolationMode('skeleton-overlay')}
                        title="Video with 2D skeleton tracking overlay"
                      >
                        <Eye size={13} /> Overlay
                      </button>
                      <button
                        className={isolationMode === 'isolate-video' ? 'iso-active' : ''}
                        onClick={() => setIsolationMode('isolate-video')}
                        title="Pure clean video footage"
                      >
                        <Video size={13} /> Pure video
                      </button>
                    </div>
                    <button className="icon-button" title="Upload footage" onClick={() => inputRef.current?.click()}>
                      <UploadCloud size={17} />
                    </button>
                  </div>
                </div>

                <div
                  className={`source-visual ${dragging ? 'dragging' : ''}`}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => { event.preventDefault(); setDragging(false); handleFile(event.dataTransfer.files[0]); }}
                >
                    <SourceCanvas
                    frame={activeFrame}
                    mode={isolationMode}
                    sourceUrl={sourceUrl}
                    isGif={Boolean(file && isGifFile(file))}
                    time={time}
                    clipStart={clipStart}
                    playing={playing}
                    processing={status === 'processing'}
                    speed={speed}
                    fallbackImage={IMAGE}
                    iso={iso}
                    roi={roi}
                    editingRoi={editingRoi}
                    candidates={candidates}
                    pickColor={picking}
                    onColorPicked={addColor}
                    onRoiDrawn={applySubject}
                    onPickCandidate={applySubject}
                    others={othersNow}
                    activeLabel={activeLabel}
                    onSelectPlayer={players ? setActivePlayerId : undefined}
                  />
                  {picking && status !== 'processing' && (
                    <div className="roi-hint">
                      Click the player&apos;s {pickRole === 'any' ? 'distinctive colour' : pickRole === 'hair' ? 'hair' : pickRole === 'shorts' ? 'shorts' : 'jersey'} · it will be matched on every frame
                      <button onClick={() => setPicking(false)}>Cancel</button>
                    </div>
                  )}
                  {(editingRoi || candidates.length > 0) && status !== 'processing' && (
                    <div className="roi-hint">
                      {editingRoi ? 'Drag a box around ONE player · their pose and mask will be tracked from it' : 'Click a highlighted person to isolate them'}
                      <button onClick={() => { setEditingRoi(false); setCandidates([]); }}>Cancel</button>
                    </div>
                  )}

                  <div className="source-vignette" />
                  <div className="visual-topline">
                    <span className="visual-tag">
                      {isolationMode === 'isolate-human'
                        ? 'HUMAN ISOLATED'
                        : isolationMode === 'isolate-video'
                        ? 'VIDEO ISOLATED'
                        : file ? 'YOUR FOOTAGE' : 'DEMO REFERENCE'}
                    </span>
                    <span className="visual-frame">{targetFps} FPS / {clipLabel}</span>
                  </div>

                  {status === 'processing' ? (
                    <div className="processing-overlay">
                      <div className="processing-spinner" />
                      <strong>{message}</strong>
                      <span>Running high-rate {targetFps} FPS pose estimation locally in browser</span>
                      <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
                      <small>{progress}% COMPLETE</small>
                    </div>
                  ) : status === 'error' ? (
                    <div className="processing-overlay error-overlay">
                      <strong>Tracking interrupted</strong>
                      <span>{message}</span>
                      <div className="error-actions">{file && <button onClick={retrackWithLock}>Retry tracking</button>}<button onClick={() => inputRef.current?.click()}>Try another file <ArrowRight size={14} /></button></div>
                    </div>
                  ) : !file ? (
                    <button className="source-upload-prompt" onClick={() => inputRef.current?.click()}>
                      <UploadCloud size={18} /><span>Drop a clip here or <u>browse files</u></span>
                    </button>
                  ) : null}

                  <div className="visual-bottomline">
                    <span>
                      <span className="rec-dot" />
                      {file?.name ?? 'KICK_SEQUENCE_01.MP4'}
                    </span>
                    <span>{formatTime(time)} / {formatTime(clipDuration)}</span>
                  </div>
                </div>

                {players && players.length > 0 && status === 'ready' && (
                  <div className="player-strip">
                    <span className="player-strip-title"><Users size={13} /> {players.length} PLAYERS</span>
                    {players.map((pl) => (
                      <button key={pl.id} className={`player-chip ${pl.id === activePlayer?.id ? 'active' : ''}`} onClick={() => setActivePlayerId(pl.id)} title={`Make ${pl.label} the active player (3D output, export, smoothing). Visible in ${Math.round(pl.coverage * 100)}% of frames.`}>
                        <i style={{ background: pl.color }} />
                        {pl.jersey && <b style={{ background: pl.jersey }} title="Learned jersey colour" />}
                        {pl.label}<small>{Math.round(pl.coverage * 100)}%</small>
                      </button>
                    ))}
                    <button className={`player-chip toggle ${showOthers ? 'active' : ''}`} onClick={() => setShowOthers(!showOthers)} title="Show or hide the other players in both views">
                      {showOthers ? 'Showing all' : 'Active only'}
                    </button>
                  </div>
                )}

                {trackInfo && status === 'ready' && (
                  <div className={`track-strip ${!players && trackInfo.total && trackInfo.held / trackInfo.total > 0.2 ? 'track-warn' : ''}`}>
                    <span>{players && players.length > 1 ? <><b>{players.length}</b> players tracked · {activePlayer?.label} visible <b>{Math.round((activePlayer?.coverage ?? 0) * 100)}%</b></> : <><b>{trackInfo.total - trackInfo.held}</b>/{trackInfo.total} frames locked on the player</>}</span>
                    {trackInfo.rejected > 0 && <span>· {trackInfo.rejected} look-alike detections rejected</span>}
                    {trackInfo.held > 0 && <span>· {trackInfo.held} bridged</span>}
                    {!trackInfo.segmentation && segment && <span>· pixel mask off</span>}
                    {!players && trackInfo.total > 0 && trackInfo.held / trackInfo.total > 0.2 && <span className="track-tip">Lost him often — pick his jersey/hair colour or tighten the subject box, then re-track.</span>}
                    {trackInfo.notice && <span className="track-tip">{trackInfo.notice}</span>}
                  </div>
                )}

                {file && status !== 'processing' ? (
                  <div className="trim-bar">
                    <span className="trim-title"><Scissors size={14} /> INPUT RANGE</span>
                    <label>
                      START
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, clipEnd - 0.1)}
                        step={0.1}
                        value={clipStart.toFixed(1)}
                        onChange={(e) => setClipStart(Math.max(0, Math.min(Number(e.target.value), clipEnd - 0.1)))}
                      />
                    </label>
                    <label>
                      END
                      <input
                        type="number"
                        min={clipStart + 0.1}
                        max={sourceDuration}
                        step={0.1}
                        value={clipEnd.toFixed(1)}
                        onChange={(e) => setClipEnd(Math.min(sourceDuration, Math.max(Number(e.target.value), clipStart + 0.1)))}
                      />
                    </label>
                    <div className="fps-dropdown">
                      <span>FPS:</span>
                      <select
                        aria-label="Target frames per second"
                        value={targetFps}
                        onChange={(e) => setTargetFps(Number(e.target.value) as TargetFps)}
                      >
                        <option value={15}>15 FPS (Fast)</option>
                        <option value={30}>30 FPS (Fluid)</option>
                        <option value={60}>60 FPS (Ultra)</option>
                      </select>
                    </div>
                    <div className="mode-switch" role="group" aria-label="Tracking mode">
                      <button className={trackMode === 'single' ? 'on' : ''} onClick={() => { if (trackMode !== 'single') { setTrackMode('single'); if (file) runTracking(file, { start: clipStart, end: clipEnd }, targetFps, undefined, 'single'); } }}><UserCheck size={12} /> One</button>
                      <button className={trackMode === 'all' ? 'on' : ''} onClick={() => { if (trackMode !== 'all') { setTrackMode('all'); if (file) runTracking(file, { start: clipStart, end: clipEnd }, targetFps, undefined, 'all'); } }}><Users size={12} /> All players</button>
                    </div>
                    {trackMode === 'single' && (
                      <button className="trim-select" onClick={() => { setParamTab('isolate'); findPeople(); }} disabled={detecting} title="Pick which player to isolate">
                        <UserCheck size={13} /> {roi ? 'Change player' : 'Select player'}
                      </button>
                    )}
                    <button className="trim-apply" onClick={() => file && runTracking(file, { start: clipStart, end: clipEnd }, targetFps)}>
                      Re-track @ {targetFps} FPS
                    </button>
                  </div>
                ) : (
                  <div className="pane-footer">
                    <span><FileVideo2 size={15} /> MP4, MOV, WEBM, GIF • {targetFps} FPS</span>
                    <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'Sample reference image'}</span>
                  </div>
                )}
              </div>

              {/* PANE 2: 3D SKELETON OUTPUT */}
              <div className="workspace-pane output-pane">
                <div className="pane-toolbar">
                  <div className="pane-title">
                    <span className="pane-number">02</span>
                    <span>3D Skeleton Output</span>
                  </div>
                  <div className="toolbar-right">
                    <span className="output-badge"><span /> {status === 'ready' ? `TRACKED (${targetFps} FPS)` : 'LIVE PREVIEW'}</span>
                    <button className="icon-button" title="Reset camera" onClick={() => setRotation(-0.15)}>
                      <RotateCcw size={16} />
                    </button>
                  </div>
                </div>

                <div className={`ground-bar ${groundLock ? 'ground-on' : ''}`}>
                  <button className="ground-toggle" onClick={() => setGroundLock(!groundLock)} aria-pressed={groundLock} title="Pin the lowest foot to the floor until the timer, removing floating / sinking.">
                    <Anchor size={14} /> Anti-levitation <span className="switch"><i /></span>
                  </button>
                  <label className={groundLock ? '' : 'dim'}>keep on ground until
                    <input type="number" min={0} max={Math.max(0.1, clipDuration)} step={0.1} value={Math.min(groundLockUntil, clipDuration).toFixed(1)} disabled={!groundLock}
                      onChange={(e) => setGroundLockUntil(Math.max(0, Math.min(clipDuration, Number(e.target.value) || 0)))} /> s
                  </label>
                  <button className="ground-mini" disabled={!groundLock} onClick={() => setGroundLockUntil(clipDuration)}>Whole clip</button>
                  <button className="ground-mini" disabled={!groundLock} onClick={() => setGroundLockUntil(Math.min(clipDuration, time))} title="Set the timer to the current playhead">At playhead</button>
                </div>

                <div className="skeleton-stage">
                  <div className="stage-glow" />
                  <SkeletonCanvas
                    others={othersNow}
                    view={sceneView}
                    activeLabel={activeLabel}
                    frame={activeFrame}
                    showGrid={showGrid}
                    showLabels={showLabels}
                    rotation={rotation}
                    onRotate={setRotation}
                    style={style}
                  />
                  <div className="stage-axis">
                    <span className="axis-y">Y</span>
                    <span className="axis-z">Z</span>
                    <span className="axis-x">X</span>
                  </div>
                  <div className="stage-hint">DRAG TO ROTATE VIEW <span>↗</span></div>
                  <div className="stage-scale">Y-UP <span>/</span> METERS</div>
                </div>

                <div className="pane-footer">
                  <div className="legend">
                    <span><i style={{ background: THEMES[style.theme].left }} /> LEFT</span>
                    <span><i style={{ background: THEMES[style.theme].right }} /> RIGHT</span>
                    <span><i style={{ background: THEMES[style.theme].center }} /> CENTER</span>
                    <span><i style={{ background: THEMES[style.theme].head }} /> HEAD</span>
                  </div>
                  <div className="rig-metrics">
                    <span>21 JOINTS</span>
                    {frames.length > 2 && (
                      <span className={`jitter-pill ${jitter > 6 ? 'jitter-high' : jitter > 2.5 ? 'jitter-mid' : 'jitter-low'}`} title="Mean pose curvature per frame in millimetres — residual vibration after smoothing. Lower is steadier.">
                        JITTER {jitter.toFixed(1)} mm
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* TIMELINE PANEL WITH IN/OUT POINTS & SPEED */}
            <div className="timeline-panel">
              <div className="timeline-top">
                <div className="timeline-heading">
                  <Activity size={17} />
                  <strong>Motion timeline</strong>
                  <span>{status === 'ready' ? `TRACKED CLIP (${targetFps} FPS)` : `PROCEDURAL DEMO (${targetFps} FPS)`}</span>
                </div>
                <div className="timeline-actions">
                  <button onClick={() => setShowGrid(!showGrid)} className={showGrid ? 'toggle-active' : ''}>
                    <Layers3 size={15} /> Grid
                  </button>
                  <button onClick={() => setShowLabels(!showLabels)} className={showLabels ? 'toggle-active' : ''}>
                    <Settings2 size={15} /> Labels
                  </button>
                  <button onClick={() => setGroundLock(!groundLock)} className={groundLock ? 'toggle-active' : ''} title="Anti-levitation: pin feet to the floor until the timer set in Speed & smoothing">
                    <Anchor size={15} /> Ground
                  </button>
                  <span className="timeline-divider" />
                  <span className="fps-text">{targetFps} FPS</span>
                </div>
              </div>

              <div className="playback-row">
                <button className="play-button" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
                  {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                </button>
                <span className="time-readout">{formatTime(time)}</span>
                <div className="timeline-range-wrap">
                  <div className="timeline-ticks" />
                  <div
                    className="timeline-trim"
                    style={{
                      left: `${(inPoint / Math.max(clipDuration, 0.01)) * 100}%`,
                      right: `${100 - (outPoint / Math.max(clipDuration, 0.01)) * 100}%`,
                    }}
                  />
                  {groundLock && <div className="timeline-ground" style={{ width: `${Math.min(100, (groundLockUntil / Math.max(clipDuration, 0.01)) * 100)}%` }} title="Anti-levitation active" />}
                  <input
                    aria-label="Seek motion timeline"
                    className="timeline-range"
                    type="range"
                    min="0"
                    max={clipDuration}
                    step="0.01"
                    value={Math.min(time, clipDuration)}
                    style={sliderStyle(Math.min(time, clipDuration), 0, Math.max(clipDuration, 0.01))}
                    onChange={(event) => {
                      setTime(Number(event.target.value));
                      setPlaying(false);
                    }}
                  />
                </div>
                <span className="time-readout end-time">{formatTime(clipDuration)}</span>
                <button className="speed-button" onClick={() => setSpeed(1)} title="Reset speed to 1.0x">
                  {speed.toFixed(2)}x <ChevronDown size={13} />
                </button>
              </div>

              <div className="trim-row">
                <span className="trim-label"><Scissors size={13} /> OUTPUT IN</span>
                <input
                  aria-label="Output in point"
                  type="range"
                  min="0"
                  max={clipDuration}
                  step="0.01"
                  value={inPoint}
                  style={sliderStyle(inPoint, 0, Math.max(clipDuration, 0.01))}
                  onChange={(e) => setPlayIn(Math.min(Number(e.target.value), outPoint - 0.05))}
                />
                <strong>{formatTime(inPoint)}</strong>

                <span className="trim-label out"><Scissors size={13} /> OUTPUT OUT</span>
                <input
                  aria-label="Output out point"
                  type="range"
                  min="0"
                  max={clipDuration}
                  step="0.01"
                  value={outPoint}
                  style={sliderStyle(outPoint, 0, Math.max(clipDuration, 0.01))}
                  onChange={(e) => setPlayOut(Math.max(Number(e.target.value), inPoint + 0.05))}
                />
                <strong>{formatTime(outPoint)}</strong>
              </div>
            </div>

            {/* EXPANDABLE PARAMETERS & ISOLATION CONTROL PANEL */}
            <div className="params-panel">
              <div className="params-tabs">
                <button
                  className={paramTab === 'isolate' ? 'active' : ''}
                  onClick={() => setParamTab('isolate')}
                >
                  <UserCheck size={14} /> Isolation & capture FPS
                </button>
                <button
                  className={paramTab === 'skeleton' ? 'active' : ''}
                  onClick={() => setParamTab('skeleton')}
                >
                  <Sparkles size={14} /> Skeleton variety ({themeKeys.length} themes)
                </button>
                <button
                  className={paramTab === 'timing' ? 'active' : ''}
                  onClick={() => setParamTab('timing')}
                >
                  <SlidersHorizontal size={14} /> Speed & smoothing
                </button>

                {paramTab === 'skeleton' && (
                  <>
                    <button className="params-ghost" onClick={randomize}>
                      <Wand2 size={14} /> Randomize
                    </button>
                    <button className="params-ghost" onClick={() => setStyle(DEFAULT_STYLE)}>
                      <RotateCcw size={13} /> Reset
                    </button>
                  </>
                )}
              </div>

              {paramTab === 'isolate' ? (
                <div className="params-grid">
                  <div className="param param-wide">
                    <label>HUMAN & VIDEO ISOLATION MODES</label>
                    <div className="isolation-mode-cards">
                      <div
                        className={`iso-card ${isolationMode === 'isolate-human' ? 'iso-card-selected' : ''}`}
                        onClick={() => setIsolationMode('isolate-human')}
                      >
                        <div className="iso-card-icon"><UserCheck size={20} /></div>
                        <div>
                          <strong>Isolate Human</strong>
                          <p>Cuts the player out of the footage with a per-pixel segmentation mask (or a pose-hull fallback) and places them on a clean background.</p>
                        </div>
                      </div>

                      <div
                        className={`iso-card ${isolationMode === 'skeleton-overlay' ? 'iso-card-selected' : ''}`}
                        onClick={() => setIsolationMode('skeleton-overlay')}
                      >
                        <div className="iso-card-icon"><Eye size={20} /></div>
                        <div>
                          <strong>Skeleton Overlay</strong>
                          <p>Draws 2D color-coded kinematic skeleton lines and landmarks directly over the original video footage.</p>
                        </div>
                      </div>

                      <div
                        className={`iso-card ${isolationMode === 'isolate-video' ? 'iso-card-selected' : ''}`}
                        onClick={() => setIsolationMode('isolate-video')}
                      >
                        <div className="iso-card-icon"><Video size={20} /></div>
                        <div>
                          <strong>Isolate Video</strong>
                          <p>Hides all skeletal annotations and overlays to inspect clean source video timing and camera motion.</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="param param-wide">
                    <label>TRACKING MODE<em>{trackMode === 'all' ? `ALL PLAYERS · UP TO ${maxPeople}` : 'ONE PLAYER'}</em></label>
                    <div className="subject-actions">
                      <div className="mode-switch big" role="group" aria-label="Tracking mode">
                        <button className={trackMode === 'single' ? 'on' : ''} onClick={() => setTrackMode('single')}><UserCheck size={13} /> One player</button>
                        <button className={trackMode === 'all' ? 'on' : ''} onClick={() => setTrackMode('all')}><Users size={13} /> All players</button>
                      </div>
                      <select aria-label="Maximum people per frame" className="role-select" value={maxPeople} disabled={trackMode !== 'all'} onChange={(e) => setMaxPeople(Number(e.target.value))}>
                        {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Up to {n} people</option>)}
                      </select>
                      <button className="subject-btn" disabled={!file || status === 'processing'} onClick={retrackWithLock}>
                        <RotateCcw size={13} /> Track {trackMode === 'all' ? 'all players' : 'one player'} now
                      </button>
                    </div>
                    <span className="param-hint">
                      <b>All players</b> detects up to {maxPeople} people per frame and gives each one a stable ID (P1, P2…, ordered by screen time), using jersey/hair colour and motion so IDs survive crossings and short occlusions. Everyone appears in both views and in one shared 3D scene; click a player on the video or in the player list to make him the active one (3D focus, smoothing, ground lock, export). <b>Export</b> then writes every player. A drawn subject box limits the area analysed (e.g. to exclude the bench). Colours picked with the eyedropper apply to one-player mode only. Uses the pose-hull cutout (no pixel mask) and is slower per frame than one-player mode.
                    </span>
                  </div>

                  <div className="param param-wide">
                    <label>MANUAL SUBJECT ISOLATION<em>{roi ? 'SUBJECT LOCKED' : 'WHOLE FRAME'}</em></label>
                    <div className="subject-actions">
                      <button className="subject-btn" disabled={!file || detecting || status === 'processing'} onClick={findPeople}>
                        <UserCheck size={14} /> {detecting ? 'Detecting people…' : 'Detect people on this frame'}
                      </button>
                      <button className={`subject-btn ${editingRoi ? 'subject-btn-on' : ''}`} disabled={!file || status === 'processing'} onClick={() => { setCandidates([]); setEditingRoi(!editingRoi); setPlaying(false); setIsolationMode('skeleton-overlay'); }}>
                        <Scissors size={14} /> {editingRoi ? 'Drawing… drag on the video' : 'Draw subject box'}
                      </button>
                      <button className="subject-btn" disabled={!roi || status === 'processing'} onClick={clearSubject}>
                        <RotateCcw size={13} /> Clear subject
                      </button>
                    </div>
                    <div className="subject-toggles">
                      <button className={followSubject ? 'chip-on' : ''} onClick={() => setFollowSubject(!followSubject)} title="Re-centre the subject box on the player each frame"><Check size={13} /> Follow moving player</button>
                      <button className={segment ? 'chip-on' : ''} onClick={() => setSegment(!segment)} title="Per-pixel person mask. Slower; off = pose-hull cutout"><Check size={13} /> Pixel segmentation mask</button>
                      <button className={iso.showSkeleton ? 'chip-on' : ''} onClick={() => setIso({ ...iso, showSkeleton: !iso.showSkeleton })}><Check size={13} /> Skeleton on cutout</button>
                    </div>
                    <span className="param-hint">
                      {file
                        ? 'Pick the player in multi-person footage (teammates, referee, keeper) by detecting people or drawing a box. Tracking then runs only inside that region and follows the player. Follow, segmentation and jersey-lock changes apply on the next re-track.'
                        : 'Upload footage to select a subject. The demo uses an approximate pose-hull cutout.'}
                    </span>
                  </div>

                  <div className="param param-wide identity-panel">
                    <label>PLAYER IDENTITY LOCK<em>{identityOn ? `STRICTNESS ${strictness}%` : 'OFF'}</em></label>
                    <div className="subject-toggles">
                      <button className={identityOn ? 'chip-on' : ''} onClick={() => setIdentityOn(!identityOn)} title="Ask the detector for several people per frame and pick the one that matches the locked player by colour, position and size."><Check size={13} /> Keep the same player</button>
                      <button className={modelQuality === 'full' ? 'chip-on' : ''} onClick={() => setModelQuality(modelQuality === 'full' ? 'lite' : 'full')} title="The full model is more accurate and steadier (less jitter), but slower and a larger download."><Check size={13} /> Accurate model (slower)</button>
                    </div>
                    <input aria-label="Identity lock strictness" type="range" min="0" max="100" value={strictness} disabled={!identityOn} style={sliderStyle(strictness, 0, 100)} onChange={(e) => setStrictness(Number(e.target.value))} />
                    <span className="param-hint">
                      Strictness: higher rejects any detection whose jersey / shorts / hair colours or position don&apos;t match, and bridges the gap instead of switching to someone else. Lower tolerates colour changes (shadow, different lighting). If it still swaps players, pick the jersey or hair colour below.
                    </span>
                    <div className="color-targets">
                      {trackInfo?.learned && (['jersey', 'shorts', 'hair'] as const).map((r) => trackInfo.learned?.[r] && (
                        <span key={r} className="color-chip learned" title={`Learned automatically from the locked player: ${r}`}><i style={{ background: css(trackInfo.learned![r]!) }} />{r} · auto</span>
                      ))}
                      {colorTargets.map((t) => (
                        <span key={t.id} className="color-chip" title="Picked by you; outweighs auto-learned colours"><i style={{ background: css(t.rgb) }} />{t.role}<button aria-label="Remove colour" onClick={() => removeColor(t.id)}>×</button></span>
                      ))}
                    </div>
                    <div className="subject-actions">
                      <select aria-label="What part of the player is this colour?" className="role-select" value={pickRole} onChange={(e) => setPickRole(e.target.value as ColorRole)}>
                        <option value="jersey">Jersey / shirt</option>
                        <option value="hair">Hair</option>
                        <option value="shorts">Shorts</option>
                        <option value="any">Anything else</option>
                      </select>
                      <button className={`subject-btn ${picking ? 'subject-btn-on' : ''}`} disabled={!file || status === 'processing'} onClick={() => { setPicking(!picking); setCandidates([]); setEditingRoi(false); setPlaying(false); setIsolationMode('skeleton-overlay'); }}>
                        <Crosshair size={14} /> {picking ? 'Click the player on the video…' : 'Pick colour from video'}
                      </button>
                      <button className="subject-btn" disabled={!file || status === 'processing'} onClick={retrackWithLock}>
                        <RotateCcw size={13} /> Re-track with this lock
                      </button>
                    </div>
                  </div>

                  <div className="param">
                    <label>MASK THRESHOLD<em>{Math.round(iso.threshold * 100)}%</em></label>
                    <input aria-label="Mask threshold" type="range" min="0.15" max="0.85" step="0.01" value={iso.threshold} style={sliderStyle(iso.threshold, 0.15, 0.85)} onChange={(e) => setIso({ ...iso, threshold: Number(e.target.value) })} />
                    <span className="param-hint">Lower keeps boots and hair; higher cuts tighter.</span>
                  </div>
                  <div className="param">
                    <label>EDGE FEATHER · SOFT EDGE<em>{iso.feather.toFixed(1)}px</em></label>
                    <input aria-label="Edge feather" type="range" min="0" max="5" step="0.1" value={iso.feather} style={sliderStyle(iso.feather, 0, 5)} onChange={(e) => setIso({ ...iso, feather: Number(e.target.value) })} />
                    <span className="param-hint"><b>Feather</b> softens the cut-out border: it blurs the mask edge by this many pixels so the player blends into the new background instead of having a hard, jagged outline. 0 = razor-sharp edge, 1–2 = natural, 4+ = glowing halo.</span>
                  </div>
                  <div className="param">
                    <label>HULL WIDTH (NO MASK)<em>{iso.expand.toFixed(2)}x</em></label>
                    <input aria-label="Pose hull width" type="range" min="0.6" max="2" step="0.05" value={iso.expand} style={sliderStyle(iso.expand, 0.6, 2)} onChange={(e) => setIso({ ...iso, expand: Number(e.target.value) })} />
                  </div>
                  <div className="param param-wide">
                    <label>CUTOUT BACKGROUND</label>
                    <div className="theme-row">
                      {([['pitch', 'Dark pitch'], ['black', 'Black'], ['green', 'Chroma green'], ['dim', 'Dimmed footage']] as const).map(([key, label]) => (
                        <button key={key} className={`theme-chip ${iso.background === key ? 'theme-active' : ''}`} onClick={() => { setIso({ ...iso, background: key }); setIsolationMode('isolate-human'); }}>{label}</button>
                      ))}
                    </div>
                  </div>

                  <div className="param param-wide">
                    <label>CAPTURE FRAME RATE (FPS)<em>{targetFps} FPS CURRENT</em></label>
                    <div className="fps-selector-grid">
                      {([15, 30, 60] as TargetFps[]).map((f) => (
                        <button
                          key={f}
                          className={`fps-card ${targetFps === f ? 'fps-card-selected' : ''}`}
                          onClick={() => changeFps(f, 'retime')}
                        >
                          <span className="fps-number">{f}</span>
                          <span className="fps-unit">FPS</span>
                          <small>
                            {f === 15 ? 'Fastest processing; lower memory' : f === 30 ? 'Standard match rate; smooth kinetics' : 'Ultra-fluid; ideal for ball strike analysis'}
                          </small>
                        </button>
                      ))}
                    </div>
                    {file && (
                      <button className="retrack-button" onClick={() => runTracking(file, { start: clipStart, end: clipEnd }, targetFps)}>
                        <RotateCcw size={13} /> Re-track from source at {targetFps} FPS
                      </button>
                    )}
                    <span className="param-hint">
                      {file
                        ? 'Selecting a rate instantly re-times the tracked clip by interpolation. Use "Re-track from source" for freshly sampled landmarks at that rate.'
                        : 'Pose sampling density for uploaded footage. Demo motion regenerates at this rate.'}
                      {' '}At 60 FPS the analysed window is capped at {Math.floor(900 / 60)}s per run to keep the browser responsive.
                    </span>
                  </div>
                </div>
              ) : paramTab === 'skeleton' ? (
                <div className="params-grid">
                  <div className="param">
                    <label>OVERALL SIZE<em>{style.size.toFixed(2)}x</em></label>
                    <input
                      aria-label="Overall skeleton scale"
                      type="range"
                      min="0.6"
                      max="1.6"
                      step="0.01"
                      value={style.size}
                      style={sliderStyle(style.size, 0.6, 1.6)}
                      onChange={(e) => setStyle({ ...style, size: Number(e.target.value) })}
                    />
                  </div>
                  <div className="param">
                    <label>HEIGHT / STATURE<em>{style.height.toFixed(2)}x</em></label>
                    <input
                      aria-label="Height stature scale"
                      type="range"
                      min="0.7"
                      max="1.4"
                      step="0.01"
                      value={style.height}
                      style={sliderStyle(style.height, 0.7, 1.4)}
                      onChange={(e) => setStyle({ ...style, height: Number(e.target.value) })}
                    />
                  </div>
                  <div className="param">
                    <label>BUILD / WIDTH<em>{style.build.toFixed(2)}x</em></label>
                    <input
                      aria-label="Build width scale"
                      type="range"
                      min="0.7"
                      max="1.5"
                      step="0.01"
                      value={style.build}
                      style={sliderStyle(style.build, 0.7, 1.5)}
                      onChange={(e) => setStyle({ ...style, build: Number(e.target.value) })}
                    />
                  </div>
                  <div className="param">
                    <label>JOINT SIZE<em>{style.jointSize.toFixed(1)}</em></label>
                    <input
                      aria-label="Joint circle size"
                      type="range"
                      min="2"
                      max="10"
                      step="0.1"
                      value={style.jointSize}
                      style={sliderStyle(style.jointSize, 2, 10)}
                      onChange={(e) => setStyle({ ...style, jointSize: Number(e.target.value) })}
                    />
                  </div>
                  <div className="param">
                    <label>BONE THICKNESS<em>{style.boneThickness.toFixed(1)}</em></label>
                    <input
                      aria-label="Bone line thickness"
                      type="range"
                      min="0.5"
                      max="5"
                      step="0.1"
                      value={style.boneThickness}
                      style={sliderStyle(style.boneThickness, 0.5, 5)}
                      onChange={(e) => setStyle({ ...style, boneThickness: Number(e.target.value) })}
                    />
                  </div>
                  <div className="param">
                    <label>PERSPECTIVE<em>{style.perspective.toFixed(2)}</em></label>
                    <input
                      aria-label="Perspective depth"
                      type="range"
                      min="0"
                      max="0.2"
                      step="0.005"
                      value={style.perspective}
                      style={sliderStyle(style.perspective, 0, 0.2)}
                      onChange={(e) => setStyle({ ...style, perspective: Number(e.target.value) })}
                    />
                  </div>
                  <div className="param param-wide">
                    <label>COLOR THEME</label>
                    <div className="theme-row">
                      {themeKeys.map((key) => (
                        <button
                          key={key}
                          className={`theme-chip ${style.theme === key ? 'theme-active' : ''}`}
                          onClick={() => setStyle({ ...style, theme: key })}
                        >
                          <i style={{ background: THEMES[key].left }} />
                          <i style={{ background: THEMES[key].right }} />
                          <i style={{ background: THEMES[key].head }} />
                          {THEMES[key].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="param param-toggles">
                    <button
                      className={style.showShadow ? 'chip-on' : ''}
                      onClick={() => setStyle({ ...style, showShadow: !style.showShadow })}
                    >
                      <Check size={13} /> Ground shadow
                    </button>
                    <button
                      className={style.glow ? 'chip-on' : ''}
                      onClick={() => setStyle({ ...style, glow: !style.glow })}
                    >
                      <Check size={13} /> Neon glow
                    </button>
                  </div>
                </div>
              ) : (
                <div className="params-grid">
                  <div className="param param-wide">
                    <label>PLAYBACK SPEED<em>{speed.toFixed(2)}x</em></label>
                    <input
                      aria-label="Playback speed"
                      type="range"
                      min="0.1"
                      max="3"
                      step="0.05"
                      value={speed}
                      style={sliderStyle(speed, 0.1, 3)}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                    />
                    <div className="speed-presets">
                      {[0.25, 0.5, 1, 1.5, 2].map((s) => (
                        <button
                          key={s}
                          className={Math.abs(speed - s) < 0.001 ? 'preset-on' : ''}
                          onClick={() => setSpeed(s)}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="param param-wide">
                    <label>MOTION SMOOTHING<em>{smoothing}%</em></label>
                    <input
                      aria-label="Temporal smoothing strength"
                      type="range"
                      min="0"
                      max="100"
                      value={smoothing}
                      style={sliderStyle(smoothing, 0, 100)}
                      onChange={(e) => setSmoothing(Number(e.target.value))}
                    />
                    <div className="speed-presets anti-vibe">
                      <button className={smoothing >= 75 ? 'preset-on' : ''} onClick={() => setSmoothing(82)}>Anti-vibration</button>
                      <button className={smoothing <= 20 ? 'preset-on' : ''} onClick={() => setSmoothing(15)}>Maximum snap</button>
                      <button onClick={() => setSmoothing(48)}>Balanced</button>
                    </div>
                    <span className="param-hint">
                      Median spike removal + 3-sample velocity One-Euro. Residual pose curvature is shown live in the 3D pane: {jitter.toFixed(1)} mm. If it stays high, raise smoothing or re-track with the subject box selected.
                    </span>
                  </div>
                  <div className="param param-wide">
                    <label>ANTI-LEVITATION (GROUND LOCK)<em>{groundLock ? `ON · UNTIL ${formatTime(Math.min(groundLockUntil, clipDuration))}` : 'OFF'}</em></label>
                    <div className="subject-toggles">
                      <button className={groundLock ? 'chip-on' : ''} onClick={() => setGroundLock(!groundLock)}><Anchor size={13} /> Keep player on the ground</button>
                    </div>
                    <input
                      aria-label="Ground lock timer"
                      type="range" min="0" max={clipDuration} step="0.05"
                      value={Math.min(groundLockUntil, clipDuration)}
                      style={sliderStyle(Math.min(groundLockUntil, clipDuration), 0, Math.max(clipDuration, 0.01))}
                      onChange={(e) => { setGroundLockUntil(Number(e.target.value)); if (!groundLock) setGroundLock(true); }}
                    />
                    <span className="param-hint">
                      Pins the lowest foot to the floor from the start of the clip until the timer ({formatTime(Math.min(groundLockUntil, clipDuration))}), then fades out over 0.5s. Kills residual floating/sinking from monocular depth noise while still allowing a jump, header or dive after the timer. Set the timer to the clip end to ground the whole clip.
                    </span>
                  </div>

                  <div className="param param-wide">
                    <label>EXPORT FILE<em>{exportSize ? `LAST: ${exportSize}` : `${exportLayout.toUpperCase()} · ${exportPrecision} DP`}</em></label>
                    <div className="subject-toggles">
                      <button className={exportLayout === 'compact' ? 'chip-on' : ''} onClick={() => setExportLayout('compact')} title="Flat number arrays per frame. About 8x smaller than the verbose layout."><Check size={13} /> Compact layout</button>
                      <button className={exportLayout === 'verbose' ? 'chip-on' : ''} onClick={() => setExportLayout('verbose')} title="Named joints and bones per frame. Easiest to read, largest file."><Check size={13} /> Verbose layout</button>
                      <button className={exportRotations ? 'chip-on' : ''} onClick={() => setExportRotations(!exportRotations)} title="Per-bone quaternions. Turn off for position-only pipelines to roughly halve the file."><Check size={13} /> Bone rotations</button>
                      <button className={exportGzip ? 'chip-on' : ''} onClick={() => setExportGzip(!exportGzip)} title="Writes .json.gz — typically another 4-6x smaller. Most tools and all languages can read gzip."><Check size={13} /> Gzip (.json.gz)</button>
                    </div>
                    <div className="speed-presets">
                      {([[2, '1 cm'], [3, '1 mm'], [4, '0.1 mm']] as const).map(([p, label]) => (
                        <button key={p} className={exportPrecision === p ? 'preset-on' : ''} onClick={() => setExportPrecision(p)} title={`Round coordinates to ${label}`}>{p} dp · {label}</button>
                      ))}
                    </div>
                    <span className="param-hint">
                      Exports {exportFrames.length >= 2 ? exportFrames.length : frames.length} frames from {formatTime(inPoint)} to {formatTime(outPoint)} @ {targetFps} FPS, re-based to 00:00.0. Measured for a 900-frame (30 s) clip: old verbose + pretty-print 3.7 MB · compact 3 dp 555 KB · without rotations 330 KB · gzipped 105 KB (65 KB without rotations). Tracked data is accurate to about 1 cm, so 3 dp (1 mm) loses nothing; 2 dp (1 cm) is still within the tracking error.
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="control-strip">
              <div className="control-info">
                <div className="control-icon"><SlidersHorizontal size={18} /></div>
                <div>
                  <strong>Motion refinement • {targetFps} FPS</strong>
                  <span>Trim input range, isolate human or video, customize skeleton variety, then export.</span>
                </div>
              </div>
              <div className="smoothing-control">
                <span>SMOOTHING</span>
                <input
                  aria-label="Smoothing strength"
                  type="range"
                  min="0"
                  max="100"
                  value={smoothing}
                  style={sliderStyle(smoothing, 0, 100)}
                  onChange={(event) => setSmoothing(Number(event.target.value))}
                />
                <strong>{smoothing}%</strong>
              </div>
              <button className="export-button" onClick={download}>
                <ArrowDownToLine size={16} /> {players && players.length > 1 ? `Export all ${players.length} players` : `Export motion JSON (${targetFps} FPS)`}
              </button>
            </div>
          </section>

          <Sections
            movement={movement}
            targetFps={targetFps}
            copied={copied}
            onCopy={copyFlow}
            onChoose={chooseMovement}
            onPreview={previewMovement}
          />
        </main>
      </div>

      <input
        ref={inputRef}
        className="hidden-input"
        type="file"
        accept="video/*,image/gif,.gif"
        onChange={(event) => {
          handleFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}
