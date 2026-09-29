/**
 * Media Rights Graph — simple in-memory list:
 * person → clip → policy version → action
 */

import { v4 as uuid } from "uuid";

export interface ClipStub {
  clip_id: string;
  track_id: string;
  subject: string;
  token_id: string;
  policy_version: number;
  captured_at: string;
  label: string;
  export_status: "pending" | "allowed" | "blocked" | "transformed";
}

export interface RightsEdge {
  person: string;
  clip_id: string;
  token_id: string;
  policy_version: number;
  action: string;
  ts: string;
}

const clips = new Map<string, ClipStub>();
const edges: RightsEdge[] = [];

export function createClip(input: {
  track_id: string;
  subject: string;
  token_id: string;
  label?: string;
}): ClipStub {
  const clip: ClipStub = {
    clip_id: uuid(),
    track_id: input.track_id,
    subject: input.subject,
    token_id: input.token_id,
    policy_version: 1,
    captured_at: new Date().toISOString(),
    label: input.label ?? `clip-${Date.now()}`,
    export_status: "pending",
  };
  clips.set(clip.clip_id, clip);
  edges.push({
    person: clip.subject,
    clip_id: clip.clip_id,
    token_id: clip.token_id,
    policy_version: clip.policy_version,
    action: "captured",
    ts: clip.captured_at,
  });
  return clip;
}

export function listClips(): ClipStub[] {
  return Array.from(clips.values());
}

export function getClip(clipId: string): ClipStub | undefined {
  return clips.get(clipId);
}

export function updateClipExport(
  clipId: string,
  status: ClipStub["export_status"],
  action: string,
  policyVersion?: number
): ClipStub | null {
  const clip = clips.get(clipId);
  if (!clip) return null;
  clip.export_status = status;
  if (policyVersion) clip.policy_version = policyVersion;
  else clip.policy_version += 1;
  edges.push({
    person: clip.subject,
    clip_id: clip.clip_id,
    token_id: clip.token_id,
    policy_version: clip.policy_version,
    action,
    ts: new Date().toISOString(),
  });
  return clip;
}

export function getRightsGraph(): RightsEdge[] {
  return [...edges];
}
