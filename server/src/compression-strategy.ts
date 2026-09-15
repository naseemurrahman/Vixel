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

/** Software encoders: always available in the Vixel container, no GPU required. */
export const SOFTWARE_CODECS = ["libx265", "libx264", "libsvtav1"] as const;

/**
 * Hardware-accelerated encoders. These trade a small amount of compression
 * efficiency (vs. slow software presets) for large throughput/CPU gains, which
 * matters once a server holds more than a handful of concurrent camera jobs.
 * Vixel probes for real availability at runtime (see detectHardwareEncoders in
 * compress.ts) rather than assuming the host has a given GPU/driver.
 */
export const HARDWARE_CODECS = [
  "h264_qsv", "hevc_qsv",       // Intel Quick Sync
  "h264_nvenc", "hevc_nvenc",   // NVIDIA NVENC
  "h264_vaapi", "hevc_vaapi",   // VAAPI (Intel iGPU / AMD)
] as const;

export const ALL_CODECS = [...SOFTWARE_CODECS, ...HARDWARE_CODECS] as const;
export type CodecId = (typeof ALL_CODECS)[number];

export function isHardwareCodec(codec: string): codec is (typeof HARDWARE_CODECS)[number] {
  return (HARDWARE_CODECS as readonly string[]).includes(codec);
}

export type EncoderFamily = "x265" | "x264" | "svtav1" | "qsv" | "nvenc" | "vaapi";

export function encoderFamily(codec: string): EncoderFamily {
  if (codec === "libx265") return "x265";
  if (codec === "libx264") return "x264";
  if (codec === "libsvtav1") return "svtav1";
  if (codec.endsWith("_qsv")) return "qsv";
  if (codec.endsWith("_nvenc")) return "nvenc";
  if (codec.endsWith("_vaapi")) return "vaapi";
  throw new Error(`Unknown codec: ${codec}`);
}

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

/** Software preset names (x264/x265) mapped onto each hardware encoder's own preset scale. */
const NVENC_PRESET: Record<string, string> = {
  ultrafast: "p1", superfast: "p1", veryfast: "p2", faster: "p3", fast: "p4",
  medium: "p5", slow: "p6", slower: "p7", veryslow: "p7",
};
function normalizePreset(family: EncoderFamily, preset: string): string {
  if (family === "nvenc") return NVENC_PRESET[preset] ?? (/^p[1-7]$/.test(preset) ? preset : "p5");
  if (family === "qsv") return preset; // QSV accepts the same veryfast..veryslow names as libx264/x265
  return preset;
}

/**
 * Global/input-side ffmpeg arguments that must appear BEFORE `-i <source>`,
 * e.g. VAAPI device initialization. Software and QSV/NVENC codecs need none.
 */
export function buildHwAccelArgs(input: StrategyInput, vaapiDevice = "/dev/dri/renderD128"): string[] {
  if (encoderFamily(input.codec) === "vaapi") return ["-vaapi_device", vaapiDevice];
  return [];
}

/** FFmpeg output arguments after -i <source>. */
export function buildEncodeArgs(input: StrategyInput): string[] {
  const plan = buildStrategy(input);
  const family = encoderFamily(input.codec);
  const filters = [...plan.videoFilters];

  const args: string[] = [];
  args.push("-map", "0:v:0");

  if (family === "x265" || family === "x264" || family === "svtav1") {
    if (filters.length) args.push("-vf", filters.join(","));
    args.push("-c:v", input.codec, "-preset", input.preset, "-crf", String(input.crf), "-pix_fmt", "yuv420p");
    if (family === "x265") args.push("-tag:v", "hvc1", "-x265-params", plan.x265Params);
    else if (family === "x264") args.push("-x264-params", plan.x264Params);
    else args.push(...plan.svtav1Params);
  } else if (family === "qsv") {
    // QSV exposes an x264/x265-like CRF-equivalent as -global_quality; ICQ mode
    // keeps behavior close to the software CRF curve without a fixed bitrate.
    if (filters.length) args.push("-vf", filters.join(","));
    args.push("-c:v", input.codec, "-preset", normalizePreset(family, input.preset),
      "-look_ahead", "1", "-global_quality", String(input.crf), "-g", String(input.gopSize),
      "-bf", String(input.bframes), "-pix_fmt", "nv12");
  } else if (family === "nvenc") {
    if (filters.length) args.push("-vf", filters.join(","));
    args.push("-c:v", input.codec, "-preset", normalizePreset(family, input.preset),
      "-rc", "vbr", "-cq", String(input.crf), "-b:v", "0", "-g", String(input.gopSize),
      "-bf", String(input.bframes), "-spatial-aq", "1", "-temporal-aq", "1",
      "-rc-lookahead", String(input.profile === "zipstream" ? 32 : 20), "-pix_fmt", "yuv420p");
  } else {
    // VAAPI: frames must be uploaded to the device surface; software filters
    // (scene/select/mpdecimate/denoise) run first on the CPU, then hwupload.
    filters.push("format=nv12", "hwupload");
    args.push("-vf", filters.join(","));
    args.push("-c:v", input.codec, "-qp", String(input.crf), "-g", String(input.gopSize), "-bf", String(input.bframes));
  }

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
