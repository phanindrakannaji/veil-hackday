/**
 * Media Rights Graph — dual-write:
 * in-memory is source of truth for fast API responses;
 * Neo4j MERGEs when connected (Person / Pass / Clip + CAPTURED / EXPORTED).
 */

import { v4 as uuid } from "uuid";
import { getDriver, isNeo4jReady, countVeilGraph } from "./neo4j.js";

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

/** Fire-and-forget Neo4j write; never blocks / never throws to callers. */
function neoWrite(label: string, work: () => Promise<void>): void {
  if (!isNeo4jReady()) return;
  void work().catch((err) => {
    console.warn(`[neo4j] ${label} failed:`, (err as Error).message);
  });
}

async function mergeCapture(clip: ClipStub): Promise<void> {
  const driver = getDriver();
  if (!driver) return;
  const session = driver.session();
  try {
    await session.run(
      `
      MERGE (person:Person {name: $subject})
      MERGE (pass:Pass {token_id: $token_id})
        ON CREATE SET pass.subject = $subject
        ON MATCH SET pass.subject = $subject
      MERGE (person)-[:HOLDS]->(pass)
      MERGE (clip:Clip {clip_id: $clip_id})
        ON CREATE SET
          clip.label = $label,
          clip.export_status = $export_status,
          clip.captured_at = $captured_at,
          clip.track_id = $track_id,
          clip.policy_version = $policy_version
        ON MATCH SET
          clip.label = $label,
          clip.export_status = $export_status,
          clip.track_id = $track_id,
          clip.policy_version = $policy_version
      MERGE (pass)-[:CAPTURED]->(clip)
      `,
      {
        subject: clip.subject,
        token_id: clip.token_id,
        clip_id: clip.clip_id,
        label: clip.label,
        export_status: clip.export_status,
        captured_at: clip.captured_at,
        track_id: clip.track_id,
        policy_version: clip.policy_version,
      }
    );
  } finally {
    await session.close();
  }
}

async function mergeExport(
  clip: ClipStub,
  action: string,
  ts: string
): Promise<void> {
  const driver = getDriver();
  if (!driver) return;
  const session = driver.session();
  try {
    await session.run(
      `
      MERGE (person:Person {name: $subject})
      MERGE (pass:Pass {token_id: $token_id})
        ON CREATE SET pass.subject = $subject
      MERGE (person)-[:HOLDS]->(pass)
      MERGE (clip:Clip {clip_id: $clip_id})
      SET clip.export_status = $export_status,
          clip.policy_version = $policy_version,
          clip.label = coalesce(clip.label, $label),
          clip.track_id = coalesce(clip.track_id, $track_id),
          clip.captured_at = coalesce(clip.captured_at, $captured_at)
      MERGE (pass)-[:CAPTURED]->(clip)
      MERGE (person)-[e:EXPORTED]->(clip)
      SET e.action = $action,
          e.policy_version = $policy_version,
          e.ts = $ts
      `,
      {
        subject: clip.subject,
        token_id: clip.token_id,
        clip_id: clip.clip_id,
        export_status: clip.export_status,
        policy_version: clip.policy_version,
        label: clip.label,
        track_id: clip.track_id,
        captured_at: clip.captured_at,
        action,
        ts,
      }
    );
  } finally {
    await session.close();
  }
}

async function detachDeleteVeil(): Promise<void> {
  const driver = getDriver();
  if (!driver) return;
  const session = driver.session();
  try {
    await session.run(
      `MATCH (n) WHERE n:Person OR n:Pass OR n:Clip DETACH DELETE n`
    );
  } finally {
    await session.close();
  }
}

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
  neoWrite("capture", () => mergeCapture(clip));
  return clip;
}

export function listClips(): ClipStub[] {
  return Array.from(clips.values());
}

export function getClip(clipId: string): ClipStub | undefined {
  return clips.get(clipId);
}

export function getLatestClip(): ClipStub | null {
  const all = listClips();
  if (!all.length) return null;
  return all.sort(
    (a, b) =>
      new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
  )[0];
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
  const ts = new Date().toISOString();
  edges.push({
    person: clip.subject,
    clip_id: clip.clip_id,
    token_id: clip.token_id,
    policy_version: clip.policy_version,
    action,
    ts,
  });
  neoWrite("export", () => mergeExport(clip, action, ts));
  return clip;
}

export function getRightsGraph(): RightsEdge[] {
  return [...edges];
}

export function clearClipsAndEdges(): void {
  clips.clear();
  edges.length = 0;
  neoWrite("clear", () => detachDeleteVeil());
}

export type RightsGraphBackend = "neo4j" | "memory";

/** Enriched payload for GET /api/rights-graph */
export async function getRightsGraphPayload(): Promise<{
  backend: RightsGraphBackend;
  edges: RightsEdge[];
  clips: ClipStub[];
  neo4j?: { nodes: number; relationships: number };
}> {
  const backend: RightsGraphBackend = isNeo4jReady() ? "neo4j" : "memory";
  const payload: {
    backend: RightsGraphBackend;
    edges: RightsEdge[];
    clips: ClipStub[];
    neo4j?: { nodes: number; relationships: number };
  } = {
    backend,
    edges: getRightsGraph(),
    clips: listClips(),
  };
  if (backend === "neo4j") {
    const counts = await countVeilGraph();
    if (counts) payload.neo4j = counts;
  }
  return payload;
}
