/**
 * Browser face detection + lightweight multi-face tracker (MediaPipe BlazeFace).
 * Detection = geometry. Identity still comes from Veil Pass bind — not biometrics.
 */

const VISION_VER = "0.10.14";
const WASM =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VER}/wasm`;
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const MAX_FACES = 12;
const MISS_LIMIT = 18; // frames without match before dropping unbound track
const PAD = 0.55; // expand face box (hair + shoulders) for demo blur

let detector = null;
let loadError = null;
let lastDetectTs = -1;

export async function loadFaceDetector() {
  if (detector) return detector;
  try {
    const { FaceDetector, FilesetResolver } = await import(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VER}/+esm`
    );
    const vision = await FilesetResolver.forVisionTasks(WASM);
    detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.45,
      minSuppressionThreshold: 0.3,
    });
    loadError = null;
    return detector;
  } catch (err) {
    // CPU fallback
    try {
      const { FaceDetector, FilesetResolver } = await import(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VER}/+esm`
      );
      const vision = await FilesetResolver.forVisionTasks(WASM);
      detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.45,
        minSuppressionThreshold: 0.3,
      });
      loadError = null;
      return detector;
    } catch (err2) {
      loadError = err2?.message || String(err2);
      throw err2;
    }
  }
}

export function faceTrackerStatus() {
  return { ready: !!detector, error: loadError };
}

/**
 * Map video-pixel bbox → pane % under object-fit: cover (+ optional mirror).
 */
export function videoBoxToPanePercent(box, video, pane, mirrored) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const pw = pane.clientWidth || 1;
  const ph = pane.clientHeight || 1;
  const scale = Math.max(pw / vw, ph / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offX = (pw - dispW) / 2;
  const offY = (ph - dispH) / 2;

  let x = box.originX * scale + offX;
  let y = box.originY * scale + offY;
  let w = box.width * scale;
  let h = box.height * scale;

  // Expand for hair + shoulders (BlazeFace box is tight on face)
  const padX = w * 0.45;
  const padTop = h * 0.85; // cover hairline / crown
  const padBot = h * 1.15; // upper chest
  x -= padX;
  y -= padTop;
  w += padX * 2;
  h += padTop + padBot;

  if (mirrored) {
    x = pw - (x + w);
  }

  return {
    x: clamp((x / pw) * 100, 0, 99),
    y: clamp((y / ph) * 100, 0, 99),
    w: clamp((w / pw) * 100, 4, 100),
    h: clamp((h / ph) * 100, 6, 100),
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function iou(a, b) {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

function centerDist(a, b) {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  return Math.hypot(acx - bcx, acy - bcy);
}

/**
 * Detect faces on video and sync into tracks[].
 * Bound tracks stick by nearest match; unbound auto tracks spawn/drop for crowd.
 */
export function syncTracksFromVideo(opts) {
  const {
    video,
    pane,
    tracks,
    mirrored = true,
    addTrack,
    maxFaces = MAX_FACES,
    autoTrack = true,
  } = opts;

  if (!detector || !autoTrack || !video || video.readyState < 2) {
    return { faces: 0 };
  }
  if (draggingGuard(opts)) return { faces: 0 };

  const now = performance.now();
  if (now - lastDetectTs < 66) return { faces: -1 }; // ~15 fps
  lastDetectTs = now;

  let result;
  try {
    result = detector.detectForVideo(video, now);
  } catch {
    return { faces: 0 };
  }

  const detections = (result?.detections || [])
    .map((d) => {
      const bb = d.boundingBox;
      if (!bb) return null;
      return videoBoxToPanePercent(bb, video, pane, mirrored);
    })
    .filter(Boolean)
    .slice(0, maxFaces);

  // Match existing auto tracks (or any track) greedily by IoU then distance
  const usedDet = new Set();
  const usedTrack = new Set();

  // Pass 1: high IoU
  for (const track of tracks) {
    if (track.manualLock) continue;
    let best = -1;
    let bestScore = 0.12;
    detections.forEach((det, i) => {
      if (usedDet.has(i)) return;
      const score = iou(track, det);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) {
      assign(track, detections[best]);
      usedDet.add(best);
      usedTrack.add(track.id);
    }
  }

  // Pass 2: nearest center for remaining (helps when person turns)
  for (const track of tracks) {
    if (track.manualLock || usedTrack.has(track.id)) continue;
    let best = -1;
    let bestD = 18; // % of pane
    detections.forEach((det, i) => {
      if (usedDet.has(i)) return;
      const d = centerDist(track, det);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      assign(track, detections[best]);
      usedDet.add(best);
      usedTrack.add(track.id);
    } else {
      track.misses = (track.misses || 0) + 1;
    }
  }

  // Spawn tracks for unmatched faces (crowd)
  detections.forEach((det, i) => {
    if (usedDet.has(i)) return;
    if (tracks.length >= maxFaces) return;
    const t = addTrack({
      x: det.x,
      y: det.y,
      w: det.w,
      h: det.h,
      label: `Person ${tracks.length + 1}`,
      subject: "unknown",
      auto: true,
    });
    t.misses = 0;
    t.auto = true;
  });

  // Drop stale unbound auto tracks
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (t.token_id || t.manualLock) continue;
    if (!t.auto) continue;
    if ((t.misses || 0) > MISS_LIMIT) tracks.splice(i, 1);
  }

  return { faces: detections.length };
}

function assign(track, det) {
  // Light smoothing so box doesn't jitter
  const a = 0.55;
  track.x = track.x * (1 - a) + det.x * a;
  track.y = track.y * (1 - a) + det.y * a;
  track.w = track.w * (1 - a) + det.w * a;
  track.h = track.h * (1 - a) + det.h * a;
  track.misses = 0;
  track.auto = true;
}

function draggingGuard(opts) {
  return !!opts.dragging;
}
