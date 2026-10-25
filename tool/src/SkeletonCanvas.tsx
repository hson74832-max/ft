import { useEffect, useRef } from 'react';
import { BONES, type JointName, type PoseFrame, type Vec3 } from './motion';

export type ThemeName = 'classic' | 'mono' | 'neon' | 'sunset';
export const THEMES: Record<ThemeName, { label: string; left: string; right: string; center: string; head: string; shadow: string }> = {
  // Classic: coral left, azure right, clean white spine/center, amber head node (matching provided reference)
  classic: { label: 'Classic', left: '#f17a70', right: '#5ca7ff', center: '#e5eaf1', head: '#f7cb62', shadow: 'rgba(135,220,167,.29)' },
  mono: { label: 'Mono lime', left: '#9fe06a', right: '#d7f3b4', center: '#eef7e2', head: '#f4ffd6', shadow: 'rgba(184,246,117,.3)' },
  neon: { label: 'Neon', left: '#ff4d9d', right: '#4dd2ff', center: '#f2ff7a', head: '#ffd24d', shadow: 'rgba(77,210,255,.32)' },
  sunset: { label: 'Sunset', left: '#ff8f6b', right: '#ffd36b', center: '#ffb8a2', head: '#fff0c2', shadow: 'rgba(255,180,120,.3)' },
};

export type SkeletonStyle = {
  size: number;
  height: number;
  build: number;
  jointSize: number;
  boneThickness: number;
  perspective: number;
  theme: ThemeName;
  showShadow: boolean;
  glow: boolean;
};

export const DEFAULT_STYLE: SkeletonStyle = {
  size: 1,
  height: 1,
  build: 1,
  jointSize: 5.5,
  boneThickness: 1.5,
  perspective: 0.075,
  theme: 'classic',
  showShadow: true,
  glow: false,
};

/** Another tracked player, drawn in his own colour behind the active one. */
export type OtherPlayer = { id: number; label: string; color: string; frame: PoseFrame };
/** Static camera fit for multi-player scenes: centre and zoom, computed once per clip so the view doesn't drift. */
export type SceneView = { cx: number; cz: number; zoom: number };

type Props = {
  others?: OtherPlayer[];
  view?: SceneView | null;
  activeLabel?: string;
  frame: PoseFrame;
  showGrid: boolean;
  showLabels: boolean;
  rotation: number;
  onRotate: (value: number) => void;
  style: SkeletonStyle;
};

const LABELS: JointName[] = ['head', 'pelvis', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];

export default function SkeletonCanvas({ frame, showGrid, showLabels, rotation, onRotate, style, others, view, activeLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; rotation: number } | null>(null);

  // Read through a ref so the render loop is subscribed once for the lifetime of
  // the component rather than being torn down and rebuilt on every pose frame.
  const live = useRef({ frame, showGrid, showLabels, rotation, style, others, view, activeLabel });
  live.current = { frame, showGrid, showLabels, rotation, style, others, view, activeLabel };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let animation = 0;
    let dirty = true;
    // Compare the fields that actually affect drawing. (Comparing the whole ref
    // object marked dirty on every React render - i.e. 60x/second during
    // playback - even when the visible pose had not changed.)
    let last: { frame: PoseFrame; rot: number; st: SkeletonStyle; grid: boolean; labels: boolean; others?: OtherPlayer[]; view?: SceneView | null } | null = null;

    const render = () => {
      const cur = live.current;
      if (!last || last.frame !== cur.frame || last.rot !== cur.rotation || last.st !== cur.style || last.grid !== cur.showGrid || last.labels !== cur.showLabels || last.others !== cur.others || last.view !== cur.view) {
        dirty = true;
        last = { frame: cur.frame, rot: cur.rotation, st: cur.style, grid: cur.showGrid, labels: cur.showLabels, others: cur.others, view: cur.view };
      }
      const { frame: fr, showGrid: grid, showLabels: labels, rotation: rot, style: st } = cur;
      if (!dirty) {
        animation = requestAnimationFrame(render);
        return;
      }
      dirty = false;

      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        animation = requestAnimationFrame(render);
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.round(rect.width * dpr);
      const ph = Math.round(rect.height * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        dirty = true;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width;
      const h = rect.height;
      context.clearRect(0, 0, w, h);

      const theme = THEMES[st.theme];
      const scale = Math.min(w * 0.31, h * 0.35);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);

      // Body shape is scaled around the player's own pelvis (not the scene
      // origin) so build/size sliders don't slide distant players around; the
      // scene view then centres and zooms the whole group.
      const V = cur.view;
      const shapeFor = (frame: PoseFrame) => {
        const cache = new Map<JointName, Vec3>();
        const pel = frame.joints.pelvis;
        return (name: JointName): Vec3 => {
          let c = cache.get(name);
          if (!c) {
            const p = frame.joints[name] || pel;
            let x = pel.x + (p.x - pel.x) * st.build * st.size;
            let y = p.y * st.height * st.size;
            let z = pel.z + (p.z - pel.z) * st.build * st.size;
            if (V) { x = (x - V.cx) * V.zoom; y *= V.zoom; z = (z - V.cz) * V.zoom; }
            c = { x, y, z };
            cache.set(name, c);
          }
          return c;
        };
      };
      const shape = shapeFor(fr);

      // Project 3D vector to screen space
      const project = (p: Vec3) => {
        const x = p.x * cos - p.z * sin;
        const z = p.x * sin + p.z * cos;
        const perspective = 1 / (1 + z * st.perspective);
        return {
          x: w * 0.5 + x * scale * perspective,
          y: h * 0.83 - p.y * scale * perspective + z * scale * 0.27,
          depth: z,
        };
      };

      // Project all joints once
      const projected = new Map<JointName, { x: number; y: number; depth: number }>();
      for (const name of Object.keys(fr.joints) as JointName[]) {
        projected.set(name, project(shape(name)));
      }

      const line = (a: JointName, b: JointName, color: string, width: number) => {
        const pa = projected.get(a);
        const pb = projected.get(b);
        if (!pa || !pb) return;
        context.beginPath();
        context.moveTo(pa.x, pa.y);
        context.lineTo(pb.x, pb.y);
        context.strokeStyle = color;
        context.lineWidth = width;
        context.stroke();
      };

      // 1. Perspective Floor Pitch Grid
      if (grid) {
        context.strokeStyle = '#26313c';
        context.lineWidth = 0.8;
        context.beginPath();
        for (let x = -8; x <= 8; x++) {
          const pa = project({ x: x * 0.35, y: 0, z: -3 });
          const pb = project({ x: x * 0.35, y: 0, z: 3 });
          context.moveTo(pa.x, pa.y);
          context.lineTo(pb.x, pb.y);
        }
        for (let z = -9; z <= 9; z++) {
          const pa = project({ x: -3, y: 0, z: z * 0.35 });
          const pb = project({ x: 3, y: 0, z: z * 0.35 });
          context.moveTo(pa.x, pa.y);
          context.lineTo(pb.x, pb.y);
        }
        context.stroke();

        // Origin baseline
        const pa = project({ x: -3, y: 0, z: 0 });
        const pb = project({ x: 3, y: 0, z: 0 });
        context.beginPath();
        context.moveTo(pa.x, pa.y);
        context.lineTo(pb.x, pb.y);
        context.strokeStyle = '#34434a';
        context.lineWidth = 1;
        context.stroke();
      }

      // 1b. Other tracked players, behind the active one, each in his own colour.
      for (const o of cur.others ?? []) {
        if (o.frame.absent) continue;
        const sh = shapeFor(o.frame);
        const pr = new Map<JointName, { x: number; y: number }>();
        for (const n of Object.keys(o.frame.joints) as JointName[]) pr.set(n, project(sh(n)));
        context.globalAlpha = o.frame.held ? 0.35 : 0.8;
        context.strokeStyle = o.color;
        context.lineWidth = Math.max(1, st.boneThickness * 0.85);
        context.beginPath();
        for (const [a, b] of BONES) { const pa = pr.get(a), pb = pr.get(b); if (pa && pb) { context.moveTo(pa.x, pa.y); context.lineTo(pb.x, pb.y); } }
        context.stroke();
        context.fillStyle = o.color;
        context.beginPath();
        const r = Math.max(1.5, st.jointSize * 0.55);
        for (const pt of pr.values()) { context.moveTo(pt.x + r, pt.y); context.arc(pt.x, pt.y, r, 0, Math.PI * 2); }
        context.fill();
        const head = pr.get('head');
        if (head) { context.font = '600 10px "IBM Plex Mono", monospace'; context.fillText(o.label, head.x - 8, head.y - 12); }
        context.globalAlpha = 1;
      }
      // An absent active player (before he appears / after he leaves) is not drawn.
      if (fr.absent) { animation = requestAnimationFrame(render); return; }

      // 2. Ground Contact Shadow Rings under feet (matching reference green rings)
      if (st.showShadow) {
        for (const foot of ['leftAnkle', 'rightAnkle'] as const) {
          const p = shape(foot);
          const s = project({ x: p.x, y: 0, z: p.z });
          context.beginPath();
          context.ellipse(s.x, s.y, 14, 4, 0, 0, Math.PI * 2);
          context.strokeStyle = theme.shadow;
          context.lineWidth = 2;
          context.stroke();
        }

        // Center-of-mass ground projection plumb-line and marker (gray ring as shown in reference)
        const pelvisP = shape('pelvis');
        const plumbTop = projected.get('pelvis');
        const plumbBase = project({ x: pelvisP.x, y: 0, z: pelvisP.z });
        if (plumbTop) {
          context.beginPath();
          context.moveTo(plumbTop.x, plumbTop.y);
          context.lineTo(plumbBase.x, plumbBase.y);
          context.strokeStyle = 'rgba(229, 234, 241, 0.45)';
          context.lineWidth = 1;
          context.setLineDash([2, 4]);
          context.stroke();
          context.setLineDash([]);

          context.beginPath();
          context.arc(plumbBase.x, plumbBase.y, 4, 0, Math.PI * 2);
          context.fillStyle = '#6b7a84';
          context.fill();
        }
      }

      const colorFor = (name: JointName) =>
        name === 'head' || name === 'neck'
          ? theme.head
          : name.startsWith('left')
          ? theme.left
          : name.startsWith('right')
          ? theme.right
          : theme.center;

      context.shadowBlur = st.glow ? 12 : 0;

      // 3. Draw Bones in depth-sorted order (back-to-front)
      const sortedBones = [...BONES].sort(
        (a, b) => (shape(a[0]).z + shape(a[1]).z) - (shape(b[0]).z + shape(b[1]).z)
      );
      for (const [from, to, group] of sortedBones) {
        const color =
          group === 'head'
            ? theme.head
            : group === 'left'
            ? theme.left
            : group === 'right'
            ? theme.right
            : theme.center;
        if (st.glow) context.shadowColor = color;
        line(from, to, color, st.boneThickness);
      }

      // 4. Draw Joint Nodes in depth-sorted order
      const names = (Object.keys(fr.joints) as JointName[]).sort((a, b) => shape(a).z - shape(b).z);
      for (const name of names) {
        const point = projected.get(name);
        if (!point) continue;
        const color = colorFor(name);
        if (st.glow) context.shadowColor = color;
        context.beginPath();
        const rad = name === 'head' ? st.jointSize * 1.3 : st.jointSize;
        context.arc(point.x, point.y, rad, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
      }
      context.shadowBlur = 0;

      if (cur.activeLabel) {
        const head = projected.get('head');
        if (head) {
          context.font = '700 11px "IBM Plex Mono", monospace';
          context.fillStyle = theme.center;
          context.fillText(`${cur.activeLabel} ★`, head.x - 14, head.y - 14);
        }
      }

      // 5. Anatomical Joint Name Labels
      if (labels) {
        context.font = '10px monospace';
        context.fillStyle = '#a6b0bd';
        for (const name of LABELS) {
          const point = projected.get(name);
          if (point) {
            context.fillText(name.replace(/([A-Z])/g, ' $1').toUpperCase(), point.x + 11, point.y - 7);
          }
        }
      }

      animation = requestAnimationFrame(render);
    };

    animation = requestAnimationFrame(render);
    const observer = new ResizeObserver(() => {
      dirty = true;
    });
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(animation);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="skeleton-canvas"
      onPointerDown={(event) => {
        dragRef.current = { x: event.clientX, rotation };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragRef.current) {
          onRotate(dragRef.current.rotation + (event.clientX - dragRef.current.x) * 0.009);
        }
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      aria-label="Interactive 3D skeleton preview. Drag to rotate."
    />
  );
}
