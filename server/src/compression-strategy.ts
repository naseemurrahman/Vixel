/**
 * Vixel adaptive, vendor-neutral surveillance compression strategy.
 *
 * The engine combines temporal redundancy reduction (scene-aware sampling
 * and near-duplicate removal) with spatial redundancy reduction (H.265/H.264/AV1,
 * long GoV/GOP, I/P/B prediction, reference frames and adaptive quantization).
 *
 * 80%+ is a measurable target for sufficiently high-bitrate static/low-motion
 * sources, not a quality-independent guarantee. Actual savings are measured.
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
  staticFrameStride: number;
  motionThreshold: number;
};

const PROFILE_META: Record<CompressionProfile, {
  description: string;
  expectedStaticSavings: string;
  defaultGop: number;
  defaultB: number;
  defaultCrf: number;
  staticFrameStride: number;
  motionThreshold: number;
}> = {
  zipstream: {
    description: "Aggressive adaptive profile: scene-aware static sampling + long GoV + P/B + AQ.",
    expectedStaticSavings: "Target >=80% on sufficiently high-bitrate static/low-motion sources",
    defaultGop: 300, defaultB: 8, defaultCrf: 30, staticFrameStride: 5, motionThreshold: 0.008,
  },
  balanced: {
    description: "Adaptive mixed-scene profile with moderate temporal reduction and strong inter-frame prediction.",
    expectedStaticSavings: "Typically 60-85% depending on source bitrate and motion",
    defaultGop: 150, defaultB: 5, defaultCrf: 28, staticFrameStride: 3, motionThreshold: 0.012,
  },
  forensic: {
    description: "Evidence-oriented profile: preserves full frame cadence and favors detail.",
    expectedStaticSavings: "Typically 35-70% depending on source bitrate and codec",
    defaultGop: 60, defaultB: 3, defaultCrf: 24, staticFrameStride: 1, motionThreshold: 0.010,
  },
};

export function profileDefaults(profile: CompressionProfile) { return PROFILE_META[profile]; }

function adaptiveTemporalFilter(profile: CompressionProfile): string {
  const meta = PROFILE_META[profile];
  if (meta.staticFrameStride <= 1) return "";
  const stride = meta.staticFrameStride;
  const threshold = meta.motionThreshold.toFixed(4);
  // select() keeps every frame during detected motion and samples every Nth
  // frame when the scene is quiet. Input PTS is preserved; there is no setpts.
  return [
    "hqdn3d=1.2:1.2:2.4:2.4",
    "select=if(gt(scene\\," + threshold + ")\\,1\\,eq(mod(n\\," + stride + ")\\,0))",
  ].join(",");
}

function duplicateFilter(profile: CompressionProfile): string {
  if (profile === "zipstream") return "mpdecimate=hi=768:lo=448:frac=0.12:max=20";
  if (profile === "balanced") return "mpdecimate=hi=896:lo=576:frac=0.18:max=10";
  return "";
}

function govParams(gop: number, bframes: number, profile: CompressionProfile) {
  const minKey = Math.max(1, Math.floor(gop / 10));
  const scenecut = profile === "forensic" ? 55 : 45;
  const refs = profile === "zipstream" ? 5 : 4;
  const aqMode = profile === "forensic" ? 2 : 3;
  const lookahead = profile === "zipstream" ? 40 : 25;
  const common = [
    "b-adapt=2", `bframes=${bframes}`, `keyint=${gop}`, `min-keyint=${minKey}`,
    `ref=${refs}`, `rc-lookahead=${lookahead}`, `aq-mode=${aqMode}`,
    `aq-strength=${profile === "zipstream" ? "1.25" : "1.0"}`, `scenecut=${scenecut}`,
  ];
  return {
    x265: [...common, "open-gop=0", "repeat-headers=1", "strong-intra-smoothing=1", "weightp=2", "me=umh", "subme=5", "psy-rd=1.0", "sao=1"].join(":"),
    x264: [...common, "open-gop=0", "weightp=2", "me=umh", "subme=7"].join(":"),
  };
}

export function buildStrategy(input: StrategyInput): StrategyPlan {
  const meta = PROFILE_META[input.profile];
  const filters: string[] = [];
  if (input.mpdecimate) {
    const temporal = adaptiveTemporalFilter(input.profile);
    if (temporal) filters.push(temporal);
    const duplicate = duplicateFilter(input.profile);
    if (duplicate) filters.push(duplicate);
  }
  const gov = govParams(input.gopSize, input.bframes, input.profile);
  return {
    name: input.profile, description: meta.description, videoFilters: filters,
    x265Params: gov.x265, x264Params: gov.x264,
    svtav1Params: ["-g", String(input.gopSize), "-keyint_min", String(Math.max(1, Math.floor(input.gopSize / 10))),
      "-svtav1-params", `lookahead=${input.profile === "zipstream" ? 40 : 20}:aq-mode=2`],
    expectedStaticSavings: meta.expectedStaticSavings, staticFrameStride: meta.staticFrameStride,
    motionThreshold: meta.motionThreshold,
  };
}

/** FFmpeg output arguments after -i <source>. */
export function buildEncodeArgs(input: StrategyInput): string[] {
  const plan = buildStrategy(input);
  const args: string[] = [];
  if (plan.videoFilters.length) args.push("-vf", plan.videoFilters.join(","));
  args.push("-map", "0:v:0", "-c:v", input.codec, "-preset", input.preset, "-crf", String(input.crf), "-pix_fmt", "yuv420p");
  if (input.codec === "libx265") args.push("-tag:v", "hvc1", "-x265-params", plan.x265Params);
  else if (input.codec === "libx264") args.push("-x264-params", plan.x264Params);
  else if (input.codec === "libsvtav1") args.push(...plan.svtav1Params);
  // VFR is intentional: dropped static frames retain their source PTS.
  args.push("-fps_mode", "vfr", "-movflags", "+faststart");
  if (input.audio) args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "64k", "-ac", "1");
  else args.push("-an");
  return args;
}

export function listStrategyDocs() {
  return COMPRESSION_PROFILES.map((id) => {
    const meta = PROFILE_META[id];
    return { id, ...meta, techniques: [
      "Scene-change score driven temporal sampling", "Near-duplicate frame removal",
      "I/P/B GoV with adaptive B-frame placement", "Long keyframe interval with motion-aware scenecut",
      "Reference-frame reuse", "Adaptive quantization", "VFR timestamp preservation",
      "H.265/H.264/AV1 output",
    ]};
  });
}

export function compressionRatio(bytesIn: number, bytesOut: number): number {
  if (bytesIn <= 0) return 0;
  return Math.max(0, Math.min(0.999, 1 - bytesOut / bytesIn));
}

export function savedBytes(bytesIn: number, bytesOut: number): number { return Math.max(0, bytesIn - bytesOut); }
