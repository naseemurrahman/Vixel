/**
 * Open, brand-agnostic compression inspired by Axis Zipstream concepts.
 *
 * Goals (static scenes → typically ≥80% size reduction vs camera bitstream):
 * 1. Dynamic temporal sampling — drop near-duplicate frames (mpdecimate)
 * 2. Long GoV / GOP — fewer I-frames when the scene is still; scenecut inserts I on motion
 * 3. Adaptive B/P structure — b-adapt + refs so predictors reuse static background
 * 4. Spatial AQ — spend bits on textured/moving regions, starve flat walls
 * 5. Standards codecs only (H.265 / H.264 / AV1) — any player can decode
 *
 * Works with any RTSP camera (Axis, Hikvision, Dahua, Uniview, ONVIF, etc.).
 */

export const COMPRESSION_PROFILES = ["zipstream", "balanced", "forensic"] as const;
export type CompressionProfile = (typeof COMPRESSION_PROFILES)[number];

export type StrategyInput = {
  codec: string;
  preset: string;
  crf: number;
  profile: CompressionProfile;
  gopSize: number;
  bframes: number;
  mpdecimate: boolean;
  audio: boolean;
};

export type StrategyPlan = {
  name: CompressionProfile;
  description: string;
  videoFilters: string[];
  x265Params: string;
  x264Params: string;
  svtav1Params: string[];
  expectedStaticSavings: string;
};

const PROFILE_META: Record<
  CompressionProfile,
  { description: string; expectedStaticSavings: string; defaultGop: number; defaultB: number; defaultCrf: number }
> = {
  zipstream: {
    description:
      "Zipstream-class: drop static duplicates, long GoV, strong AQ — best for quiet scenes (≥80% typical).",
    expectedStaticSavings: "80–95% on static / low-motion scenes",
    defaultGop: 300,
    defaultB: 8,
    defaultCrf: 30,
  },
  balanced: {
    description: "Moderate GoV and light frame decimation — good default for mixed activity.",
    expectedStaticSavings: "65–85% depending on motion",
    defaultGop: 120,
    defaultB: 4,
    defaultCrf: 28,
  },
  forensic: {
    description: "Shorter GoV, no frame drop — prioritize detail over size.",
    expectedStaticSavings: "40–70%",
    defaultGop: 60,
    defaultB: 3,
    defaultCrf: 24,
  },
};

export function profileDefaults(profile: CompressionProfile) {
  return PROFILE_META[profile];
}

/**
 * Build mpdecimate filter tuned per profile.
 * hi/lo are SSD thresholds (scaled); frac is proportion of blocks that must change.
 * Static lobby/corridor → most frames discarded → large bitrate collapse.
 */
function decimateFilter(profile: CompressionProfile): string {
  if (profile === "zipstream") {
    // Aggressive: drop frames that barely change
    return "mpdecimate=hi=64*12:lo=64*7:frac=0.12";
  }
  if (profile === "balanced") {
    return "mpdecimate=hi=64*14:lo=64*9:frac=0.2";
  }
  return "";
}

/**
 * GoV math (open model of Zipstream dynamic GOP):
 * - keyint = max distance between I-frames (long when static → many cheap P/B frames)
 * - min-keyint = floor; scenecut can still force an I when motion spikes
 * - bframes / b-adapt = bidirectional predictors (high reuse on static background)
 */
function govParams(gop: number, bframes: number, profile: CompressionProfile): {
  x265: string;
  x264: string;
} {
  const minKey = Math.max(1, Math.floor(gop / 10));
  const scenecut = profile === "forensic" ? 70 : profile === "zipstream" ? 45 : 50;
  const refs = profile === "zipstream" ? 5 : 4;
  const aq = profile === "forensic" ? 2 : 3; // 3 = auto-variance (spatial Zipstream-like)
  const lookahead = profile === "zipstream" ? 40 : 25;

  const x265 = [
    `keyint=${gop}`,
    `min-keyint=${minKey}`,
    `bframes=${bframes}`,
    `b-adapt=2`,
    `ref=${refs}`,
    `rc-lookahead=${lookahead}`,
    `aq-mode=${aq}`,
    `aq-strength=${profile === "zipstream" ? "1.2" : "1.0"}`,
    `scenecut=${scenecut}`,
    `open-gop=0`,
    `repeat-headers=1`,
    `strong-intra-smoothing=1`,
    `weightp=2`,
    `me=umh`,
    `subme=${profile === "forensic" ? 7 : 5}`,
    `psy-rd=1.0`,
    `sao=1`,
  ].join(":");

  const x264 = [
    `keyint=${gop}`,
    `min-keyint=${minKey}`,
    `bframes=${bframes}`,
    `b-adapt=2`,
    `ref=${refs}`,
    `rc-lookahead=${lookahead}`,
    `aq-mode=${aq}`,
    `aq-strength=${profile === "zipstream" ? "1.2" : "1.0"}`,
    `scenecut=${scenecut}`,
    `open-gop=0`,
    `weightp=2`,
    `me=umh`,
    `subme=${profile === "forensic" ? 9 : 7}`,
  ].join(":");

  return { x265, x264 };
}

export function buildStrategy(input: StrategyInput): StrategyPlan {
  const meta = PROFILE_META[input.profile];
  const filters: string[] = [];

  const decimate = input.mpdecimate ? decimateFilter(input.profile) : "";
  if (decimate) {
    // Drop near-duplicates then normalize PTS so decoders see continuous VFR-friendly stream
    filters.push(decimate);
    filters.push("setpts=N/FRAME_RATE/TB");
  }

  // Mild denoise helps P/B prediction on noisy IP cams without smearing forensics too hard
  if (input.profile === "zipstream") {
    filters.push("hqdn3d=1.5:1.5:3:3");
  } else if (input.profile === "balanced") {
    filters.push("hqdn3d=0.8:0.8:2:2");
  }

  const gov = govParams(input.gopSize, input.bframes, input.profile);

  // SVT-AV1 uses different knobs but same GoV idea
  const svt = [
    `-g`,
    String(input.gopSize),
    `-keyint_min`,
    String(Math.max(1, Math.floor(input.gopSize / 10))),
    `-svtav1-params`,
    `lookahead=${input.profile === "zipstream" ? 40 : 20}:aq-mode=2`,
  ];

  return {
    name: input.profile,
    description: meta.description,
    videoFilters: filters,
    x265Params: gov.x265,
    x264Params: gov.x264,
    svtav1Params: svt,
    expectedStaticSavings: meta.expectedStaticSavings,
  };
}

/** FFmpeg output args after `-i <source>` for the encode stage */
export function buildEncodeArgs(input: StrategyInput): string[] {
  const plan = buildStrategy(input);
  const args: string[] = [];

  if (plan.videoFilters.length) {
    args.push("-vf", plan.videoFilters.join(","));
  }

  args.push("-c:v", input.codec, "-preset", input.preset, "-crf", String(input.crf), "-pix_fmt", "yuv420p");

  if (input.codec === "libx265") {
    args.push("-tag:v", "hvc1", "-x265-params", plan.x265Params);
  } else if (input.codec === "libx264") {
    args.push("-x264-params", plan.x264Params);
  } else if (input.codec === "libsvtav1") {
    args.push(...plan.svtav1Params);
  }

  args.push("-movflags", "+faststart");

  if (input.audio) {
    args.push("-c:a", "aac", "-b:a", "64k", "-ac", "1");
  } else {
    args.push("-an");
  }

  return args;
}

export function listStrategyDocs() {
  return COMPRESSION_PROFILES.map((id) => ({
    id,
    ...PROFILE_META[id],
    techniques: [
      "I/P/B frame structure (GoV)",
      "Scene-cut aware keyframes",
      "Static-frame decimation (mpdecimate)",
      "Adaptive quantization (AQ)",
      "Standards-compliant decode (H.265/H.264/AV1)",
    ],
  }));
}

/**
 * Savings math:
 *   ratio = 1 - (bytes_out / bytes_in)
 *   percent = ratio * 100
 * bytes_in  = remuxed camera bitstream for the same wall-clock window (-c copy)
 * bytes_out = Zipstream-encoded MP4
 */
export function compressionRatio(bytesIn: number, bytesOut: number): number {
  if (bytesIn <= 0) return 0;
  return Math.max(0, Math.min(0.999, 1 - bytesOut / bytesIn));
}
