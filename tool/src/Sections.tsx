import { memo } from 'react';
import { ArrowRight, Box, Check, Crosshair, Layers3, Sparkles, UserCheck } from 'lucide-react';
import { MOVEMENTS, type Movement } from './motion';

const steps = [
  { n: '01', title: 'Video input', body: 'Decode RGB video or animated GIF into timestamped frames.' },
  { n: '02', title: 'Pose estimation', body: 'MediaPipe Pose Landmarker detects 33 body landmarks in 3D & 2D.' },
  { n: '03', title: 'Coordinate extraction', body: 'Map world landmarks to a Y-up, hip-centered humanoid skeleton.' },
  { n: '04', title: 'Motion smoothing', body: 'Adaptive One-Euro filters suppress jitter without losing fast strikes.' },
  { n: '05', title: 'Rig retargeting', body: 'Convert bone directions into bind-pose-relative quaternions.' },
  { n: '06', title: '3D animation output', body: 'Export timed joints, root translation, and rig rotations as JSON.' },
];
const movementKeys = Object.keys(MOVEMENTS) as Movement[];

type Props = {
  movement: Movement;
  targetFps: number;
  copied: boolean;
  onCopy: () => void;
  onChoose: (movement: Movement) => void;
  onPreview: () => void;
};

/**
 * Documentational sections only. Memoized so the 60fps playhead loop does not
 * re-diff roughly 130 static elements on every animation frame.
 */
function Sections({ movement, targetFps, copied, onCopy, onChoose, onPreview }: Props) {
  return (
    <>
      <section id="pipeline" className="content-section pipeline-section">
        <div className="section-overline">THE SYSTEM / 01</div>
        <div className="section-intro">
          <div>
            <h2>From pixels to performance<span>.</span></h2>
            <p>A complete, inspectable path from ordinary footage to animation-ready skeletal data at up to 60 FPS.</p>
          </div>
          <button className="text-button" onClick={onCopy}>
            {copied ? <Check size={16} /> : <Layers3 size={16} />}
            {copied ? 'Copied flow' : 'Copy architecture'}
          </button>
        </div>
        <div className="pipeline-flow">
          {steps.map((step, index) => (
            <div className="flow-step" key={step.n}>
              <div className="flow-top">
                <span>{step.n}</span>
                {index < steps.length - 1 && <ArrowRight size={16} />}
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
        <div className="architecture-code">
          <span>PIPELINE FLOW</span>
          <code>Video / GIF Input <b>→</b> Pose Estimation ({targetFps} FPS) <b>→</b> Coordinate Extraction <b>→</b> Smoothing <b>→</b> Rig Retargeting <b>→</b> 3D Animation Output</code>
        </div>
      </section>

      <section id="mechanics" className="content-section mechanics-section">
        <div className="section-overline">BUILT FOR THE PITCH / 02</div>
        <div className="section-intro">
          <div>
            <h2>Football is not generic motion<span>.</span></h2>
            <p>Each action has its own timing, ground contact, and center-of-mass behavior.</p>
          </div>
        </div>
        <div className="mechanics-layout">
          <div className="mechanics-list">
            {movementKeys.map((key, index) => (
              <button
                key={key}
                onClick={() => onChoose(key)}
                className={`mechanic-item ${movement === key ? 'mechanic-selected' : ''}`}
              >
                <span>0{index + 1}</span>
                <strong>{MOVEMENTS[key].label}</strong>
                <small>{MOVEMENTS[key].focus}</small>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
          <div className="mechanics-detail">
            <div className="detail-top">
              <span>ACTIVE MOVEMENT PROFILE</span>
              <Crosshair size={19} />
            </div>
            <div className="detail-graphic">
              <div className="detail-ring ring-one" />
              <div className="detail-ring ring-two" />
              <div className="detail-cross">+</div>
              <div className="detail-value">
                {MOVEMENTS[movement].metric}
                <small>{MOVEMENTS[movement].metricLabel}</small>
              </div>
            </div>
            <h3>{MOVEMENTS[movement].focus}</h3>
            <p>{MOVEMENTS[movement].detail}</p>
            <button onClick={onPreview}>Preview movement <ArrowRight size={16} /></button>
          </div>
        </div>
      </section>

      <section id="implementation" className="content-section implementation-section">
        <div className="section-overline">IMPLEMENTATION NOTES / 03</div>
        <div className="section-intro">
          <div>
            <h2>Built to move into production<span>.</span></h2>
            <p>Practical decisions behind the live browser pipeline and its export format.</p>
          </div>
        </div>
        <div className="implementation-grid">
          <div>
            <span className="impl-icon"><Box size={20} /></span>
            <h3>High-Rate Pose Extraction</h3>
            <p>
              MediaPipe Pose Landmarker runs at 15, 30, or 60 FPS across video and animated GIF frames. Monotonically incremented graph timestamps preserve graph stability across multiple files.
            </p>
          </div>
          <div>
            <span className="impl-icon"><UserCheck size={20} /></span>
            <h3>Human &amp; Video Isolation</h3>
            <p>
              Switch between pure isolated human (dark calibrated pitch with spotlight aura), 2D overlay tracking, or pure clean video footage for side-by-side inspection.
            </p>
          </div>
          <div>
            <span className="impl-icon"><Sparkles size={20} /></span>
            <h3>Rig Handoff &amp; Trimmed Export</h3>
            <p>
              JSON contains timestamps, 3D joint positions, root translation, confidence, and bind-relative bone quaternions for the exact in/out output window.
            </p>
          </div>
        </div>
        <div className="implementation-note">
          <div>
            <strong>Engineering note</strong>
            <p>
              At 60 FPS, rapid ball strikes and goalkeeper dives capture twice the micro-motion samples, significantly improving One-Euro filter velocity estimations and ankle rotational accuracy.
            </p>
          </div>
          <a href="https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js" target="_blank" rel="noreferrer">
            MediaPipe docs <ArrowRight size={15} />
          </a>
        </div>
      </section>

      <footer>
        <div className="footer-brand">
          <div className="brand-mark mini"><span /><span /><span /><span /></div> FIELD<span>MOTION</span>
        </div>
        <span>From footage to form • {targetFps} FPS high-speed tracking.</span>
        <span>Built for the beautiful game.</span>
      </footer>
    </>
  );
}

export default memo(Sections);
