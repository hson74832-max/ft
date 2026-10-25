// Import of authored motion clips (`fieldmotion.pack.v1` bundles or one clip).
import {
  FieldMotionClip, getRegisteredMotionClips, parseFieldMotionText,
  registerFieldMotionClip, validateFieldMotionAgainstSkeleton,
} from "../motion";

/** Import one clip, or every clip in a `fieldmotion.pack.v1` bundle. */
export function importMotionPack(text: string, filename = "motion.json"): FieldMotionClip[] {
  const parsed = parseFieldMotionText(text, filename);
  const accepted: FieldMotionClip[] = [];
  const problems: string[] = [];
  for (const clip of parsed) {
    const errors = validateFieldMotionAgainstSkeleton(clip);
    if (errors.length) { problems.push(`${clip.id}: ${errors.join("; ")}`); continue; }
    if (getRegisteredMotionClips().some((c) => c.id === clip.id)) { problems.push(`${clip.id}: already imported`); continue; }
    registerFieldMotionClip(clip, { slot: clip.meta.tags.find((t) => t.startsWith("slot:"))?.slice(5) });
    accepted.push(clip);
  }
  if (!accepted.length) throw new Error(problems.join(" | ") || "No usable clips in file");
  if (problems.length) console.warn(`[motion] skipped ${problems.length} clip(s): ${problems.join(" | ")}`);
  return accepted;
  }

/** Import a single clip and return it (defaults to the first clip in the file). */
export function importMotionJSON(text: string, filename = "motion.json", clipId?: string): FieldMotionClip {
  const clips = importMotionPack(text, filename);
  return clips.find((c) => c.id === clipId) ?? clips[0];
  }
