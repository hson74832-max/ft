/**
 * Stuck-carrier probe: samples frames where the carrier desires speed > 2 but
 * moves < 0.2, and records the state that pins him.
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";

const seed = Number(process.argv[2] ?? 1234);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });

const reasons = new Map<string, number>();
let total = 0;
const examples: string[] = [];

for (let frame = 0; frame < 60 * 240; frame++) {
  e.step(1 / 60);
  const b = e.ball;
  if (b.possessedBy === null) continue;
  const o = e.players[b.possessedBy];
  if (o.role === "GK") continue;
  if (o.desiredSpeed > 2 && o.speed < 0.2) {
    total++;
    const near = e.players.filter((q) => q.idx !== o.idx).map((q) => ({ q, d: q.pos.distanceTo(o.pos) })).sort((a, b) => a.d - b.d)[0];
    const key = `action=${o.anim.actionId ?? "-"} shield=${o.shielding} stumble=${o.stumbleT > 0} recovery=${o.tackleRecoveryT > 0} protect=${o.tackleProtectionT > 0} nearest=${near ? `${near.q.role}${near.q.team === o.team ? "(mate)" : "(opp)"}@${near.d.toFixed(2)}` : "-"}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    if (examples.length < 8 && total % 40 === 0) {
      examples.push(`[${e.clock.toFixed(2)}] #${o.idx} ${o.role} pos=(${o.pos.x.toFixed(1)},${o.pos.z.toFixed(1)}) target=(${o.moveTarget.x.toFixed(1)},${o.moveTarget.z.toFixed(1)}) ${key} reason="${o.decisionReason}"`);
    }
  }
}
console.log(`seed ${seed}: ${total} stuck frames`);
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v}  ${k}`);
console.log("examples:");
for (const x of examples) console.log("  " + x);
e.dispose();
