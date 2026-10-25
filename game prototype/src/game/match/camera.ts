// Camera rig: broadcast / follow / free-debug modes.
import * as THREE from "three";
import { _v1, _v2 } from "./scratch";
import type { MatchHost } from "./host";

/** Move the camera for the current mode (broadcast / follow / free debug). */
export function updateCamera(e: MatchHost, dt: number) {
  const b = e.ball.pos;
  if (e.cameraMode === "broadcast") {
    _v1.set(b.x * 0.72, 17.5, 22.5);
    _v1.x = THREE.MathUtils.clamp(_v1.x, -14, 14);
    e.camPos.lerp(_v1, Math.min(1, dt * 2.2));
    e.camLook.lerp(_v2.set(b.x * 0.85, 0, b.z * 0.6), Math.min(1, dt * 3));
    e.camera.position.copy(e.camPos);
    e.camera.lookAt(e.camLook);
  } else if (e.cameraMode === "follow") {
    const h = e.players[e.humanIdx] ?? e.players[e.selectedIdx] ?? e.players[0];
    if (!h) return;
    const bx = h.pos.x - Math.cos(h.facing) * 7, bz = h.pos.z + Math.sin(h.facing) * 7;
    _v1.set(bx, 5.2, bz);
    e.camPos.lerp(_v1, Math.min(1, dt * 3.5));
    e.camera.position.copy(e.camPos);
    e.camera.lookAt(b.x, 0.8, b.z);
    e.camLook.set(b.x, 0.8, b.z);
  } else {
    // free debug cam: orbit ball with keys I/J/K/L + U/O zoom, drag via arrows fallback
    if (e.keys.has("j")) e.freeYaw += dt * 1.4;
    if (e.keys.has("l")) e.freeYaw -= dt * 1.4;
    if (e.keys.has("i")) e.freePitch = THREE.MathUtils.clamp(e.freePitch + dt, 0.15, 1.4);
    if (e.keys.has("k")) e.freePitch = THREE.MathUtils.clamp(e.freePitch - dt, 0.15, 1.4);
    if (e.keys.has("u")) e.freeDist = THREE.MathUtils.clamp(e.freeDist - dt * 12, 8, 60);
    if (e.keys.has("o")) e.freeDist = THREE.MathUtils.clamp(e.freeDist + dt * 12, 8, 60);
    const cx = b.x + Math.cos(e.freeYaw) * Math.cos(e.freePitch) * e.freeDist;
    const cz = b.z + Math.sin(e.freeYaw) * Math.cos(e.freePitch) * e.freeDist;
    const cy = Math.sin(e.freePitch) * e.freeDist;
    e.camera.position.set(cx, cy, cz);
    e.camera.lookAt(b.x, 0.5, b.z);
  }
}
