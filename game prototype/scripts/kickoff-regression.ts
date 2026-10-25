import { kickoffRestartViolation } from "../src/game/restartRules";

function assert(name: string, actual: string | null, expected: string | null) {
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${name}`);
  }
}

// First half: RED attacks +X, BLUE must be outside the circle in the +X half.
assert(
  "first-half opponents in own half allow kickoff",
  kickoffRestartViolation([{ x: 5, z: 0 }, { x: 8, z: -3 }], 1),
  null,
);
assert(
  "first-half opponent inside circle delays kickoff",
  kickoffRestartViolation([{ x: 1, z: 1 }], 1),
  "Waiting: opponents must be outside the centre circle",
);
assert(
  "first-half opponent in wrong half delays kickoff",
  kickoffRestartViolation([{ x: -6, z: 0 }], 1),
  "Waiting: opponents must be in their own half",
);

// Second half: BLUE attacks +X after ends swap, RED is in its own (-X) half.
assert(
  "second-half opponents in own half allow kickoff",
  kickoffRestartViolation([{ x: -5, z: 0 }, { x: -8, z: 3 }], -1),
  null,
);
assert(
  "second-half opponent in wrong half delays kickoff",
  kickoffRestartViolation([{ x: 6, z: 0 }], -1),
  "Waiting: opponents must be in their own half",
);

// Mirrors MatchEngine.resetPositions() staging for both sides/halves.
for (const attackSign of [1, -1]) {
  const opponents = [
    { x: attackSign * 17.8, z: 0 },
    { x: attackSign * 8.8, z: -5.4 },
    { x: attackSign * 8.8, z: 5.4 },
    { x: attackSign * 6.4, z: -3.1 },
    { x: attackSign * 4.9, z: 2.2 },
  ];
  assert(`kickoff staging allows legal opponents (attack sign ${attackSign})`, kickoffRestartViolation(opponents, attackSign), null);
}