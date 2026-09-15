import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEncodeArgs,
  buildHwAccelArgs,
  buildStrategy,
  compressionRatio,
  encoderFamily,
  isHardwareCodec,
  predictCompressionRatio,
  profileDefaults,
  STREAM_TYPES,
  STREAM_DESCRIPTIONS,
} from "./compression-strategy.js";
import { resolveCameraStreamUrl, type Camera } from "./cameras.js";
import { StorageInputSchema } from "./storage.js";

test("zipstream profile targets aggressive static-scene temporal reduction", () => {
  const defaults = profileDefaults("zipstream");
  assert.equal(defaults.staticFrameStride, 5);
  assert.ok(defaults.motionThreshold > 0 && defaults.motionThreshold < 0.05);
  assert.ok(defaults.defaultGop >= 240);
});

test("extreme_80plus profile guarantees >=80% reduction parameters", () => {
  const defaults = profileDefaults("extreme_80plus");
  assert.equal(defaults.staticFrameStride, 6);
  assert.equal(defaults.defaultGop, 360);
  assert.equal(defaults.defaultB, 10);
  assert.ok(defaults.motionThreshold <= 0.008);

  const plan = buildStrategy({
    codec: "libx265",
    preset: "medium",
    crf: 31,
    profile: "extreme_80plus",
    gopSize: 360,
    bframes: 10,
    mpdecimate: true,
    audio: false,
    streamType: "stream1",
  });

  assert.ok(plan.x265Params.includes("aq-mode=3"));
  assert.ok(plan.x265Params.includes("aq-strength=1.35"));
  assert.ok(plan.x265Params.includes("ref=6"));
  assert.ok(plan.x265Params.includes("rc-lookahead=50"));
});

test("adaptive strategy keeps VFR timestamps instead of rebuilding PTS", () => {
  const plan = buildStrategy({
    codec: "libx265",
    preset: "medium",
    crf: 30,
    profile: "zipstream",
    gopSize: 300,
    bframes: 8,
    mpdecimate: true,
    audio: false,
  });
  assert.ok(plan.videoFilters.some((f) => f.includes("select=")));
  assert.ok(plan.videoFilters.some((f) => f.includes("mpdecimate=")));

  const args = buildEncodeArgs({
    codec: "libx265",
    preset: "medium",
    crf: 30,
    profile: "zipstream",
    gopSize: 300,
    bframes: 8,
    mpdecimate: true,
    audio: false,
  });
  assert.ok(args.includes("-fps_mode"));
  assert.ok(args.includes("vfr"));
  assert.ok(!args.includes("setpts"));
});

test("multi-stream configurations (Stream 1, 2, 3) are supported and described", () => {
  assert.deepEqual([...STREAM_TYPES], ["stream1", "stream2", "stream3", "custom"]);
  assert.ok(STREAM_DESCRIPTIONS.stream1.typicalBitrate.includes("Mbps"));
  assert.ok(STREAM_DESCRIPTIONS.stream2.typicalBitrate.includes("Mbps"));
  assert.ok(STREAM_DESCRIPTIONS.stream3.typicalBitrate.includes("kbps"));

  // Stream 1 denoise has higher spatial filtering
  const s1Plan = buildStrategy({
    codec: "libx265",
    preset: "medium",
    crf: 30,
    profile: "zipstream",
    gopSize: 300,
    bframes: 8,
    mpdecimate: true,
    audio: false,
    streamType: "stream1",
  });
  assert.ok(s1Plan.videoFilters.some((f) => f.includes("hqdn3d=1.5")));

  // Stream 2 / 3 use lighter denoise
  const s2Plan = buildStrategy({
    codec: "libx265",
    preset: "medium",
    crf: 30,
    profile: "zipstream",
    gopSize: 300,
    bframes: 8,
    mpdecimate: true,
    audio: false,
    streamType: "stream2",
  });
  assert.ok(s2Plan.videoFilters.some((f) => f.includes("hqdn3d=1.2")));
});

test("mathematical rate-distortion model calculates >=80% compression with high SSIM", () => {
  const res1 = predictCompressionRatio("stream1", "extreme_80plus", 0.85, 4000);
  assert.ok(res1.savingsPercent >= 80, `Expected >= 80%, got ${res1.savingsPercent}%`);
  assert.ok(res1.ssim >= 0.94, `Expected SSIM >= 0.94, got ${res1.ssim}`);
  assert.ok(res1.outputBitrateKbps < 800);

  const res2 = predictCompressionRatio("stream2", "extreme_80plus", 0.85, 1500);
  assert.ok(res2.savingsPercent >= 80, `Expected >= 80%, got ${res2.savingsPercent}%`);

  const res3 = predictCompressionRatio("stream3", "extreme_80plus", 0.85, 384);
  assert.ok(res3.savingsPercent >= 80, `Expected >= 80%, got ${res3.savingsPercent}%`);
});

test("resolveCameraStreamUrl correctly handles explicit or derived stream channels", () => {
  const dummyCam: Camera = {
    id: "cam-1",
    name: "Front Gate",
    rtsp_url: "rtsp://192.168.1.50:554/Streaming/Channels/101",
    stream_type: "stream1",
    stream1_url: "rtsp://192.168.1.50:554/Streaming/Channels/101",
    stream2_url: null,
    stream3_url: null,
    active_stream: "stream1",
    ai_enabled: 1,
    ai_roi_mode: "adaptive",
    target_compression_pct: 80,
    enabled: 1,
    segment_seconds: 300,
    crf: 30,
    codec: "libx265",
    preset: "medium",
    audio: 0,
    compression_profile: "zipstream",
    gop_size: 300,
    bframes: 8,
    mpdecimate: 1,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
  };

  const s1 = resolveCameraStreamUrl(dummyCam, "stream1");
  assert.equal(s1.url, "rtsp://192.168.1.50:554/Streaming/Channels/101");

  const s2 = resolveCameraStreamUrl(dummyCam, "stream2");
  assert.equal(s2.url, "rtsp://192.168.1.50:554/Streaming/Channels/102");

  const s3 = resolveCameraStreamUrl(dummyCam, "stream3");
  assert.equal(s3.url, "rtsp://192.168.1.50:554/Streaming/Channels/103");
});

test("storage target schema validates NVR appliances and protocol options", () => {
  const nvrValid = StorageInputSchema.safeParse({
    name: "Main Dahua/Hikvision NVR",
    type: "nvr",
    enabled: true,
    config: {
      protocol: "http_post",
      endpoint: "http://192.168.1.200/api/recordings/upload",
      username: "admin",
      password: "secretpassword",
      channelId: 1,
    },
  });
  assert.equal(nvrValid.success, true);

  const nvrFtp = StorageInputSchema.safeParse({
    name: "NVR FTP Offloader",
    type: "nvr",
    enabled: true,
    config: {
      protocol: "ftp",
      host: "192.168.1.200",
      username: "nvr_user",
      remoteDir: "/nvr/ch1",
    },
  });
  assert.equal(nvrFtp.success, true);
});

test("compression math is bounded and deterministic", () => {
  assert.equal(compressionRatio(1000, 200), 0.8);
  assert.equal(compressionRatio(1000, 1000), 0);
  assert.equal(compressionRatio(0, 1), 0);
  assert.equal(compressionRatio(1000, 2000), 0);
});

test("hardware codecs are classified correctly and never confused with software ones", () => {
  assert.equal(isHardwareCodec("hevc_nvenc"), true);
  assert.equal(isHardwareCodec("h264_qsv"), true);
  assert.equal(isHardwareCodec("hevc_vaapi"), true);
  assert.equal(isHardwareCodec("libx265"), false);
  assert.equal(encoderFamily("hevc_nvenc"), "nvenc");
  assert.equal(encoderFamily("h264_qsv"), "qsv");
  assert.equal(encoderFamily("hevc_vaapi"), "vaapi");
  assert.equal(encoderFamily("libx265"), "x265");
});

test("NVENC encode args use rate-control flags, never a software -x265-params string", () => {
  const args = buildEncodeArgs({
    codec: "hevc_nvenc",
    preset: "medium",
    crf: 30,
    profile: "zipstream",
    gopSize: 300,
    bframes: 8,
    mpdecimate: true,
    audio: false,
  });
  assert.ok(args.includes("-cq"));
  assert.ok(args.includes("-rc"));
  assert.ok(!args.some((a) => a === "-x265-params"));
  assert.ok(!args.includes("-crf"));
  // Static-scene temporal filtering still applies on hardware encoders.
  assert.ok(args.some((a) => typeof a === "string" && a.includes("select=")));
});

test("QSV encode args use global_quality instead of crf", () => {
  const args = buildEncodeArgs({
    codec: "h264_qsv",
    preset: "medium",
    crf: 28,
    profile: "balanced",
    gopSize: 150,
    bframes: 5,
    mpdecimate: true,
    audio: false,
  });
  assert.ok(args.includes("-global_quality"));
  assert.ok(args.includes("28"));
  assert.ok(!args.includes("-crf"));
});

test("VAAPI encode requires a device before -i and hwuploads after CPU filters", () => {
  const input = {
    codec: "hevc_vaapi" as const,
    preset: "medium",
    crf: 26,
    profile: "forensic" as const,
    gopSize: 60,
    bframes: 3,
    mpdecimate: false,
    audio: false,
  };
  const hwArgs = buildHwAccelArgs(input);
  assert.deepEqual(hwArgs, ["-vaapi_device", "/dev/dri/renderD128"]);
  const args = buildEncodeArgs(input);
  const vfIndex = args.indexOf("-vf");
  assert.ok(vfIndex >= 0);
  assert.ok(args[vfIndex + 1].endsWith("hwupload"));
  assert.ok(args.includes("-qp"));
});

test("software codecs never receive hwaccel device args", () => {
  assert.deepEqual(
    buildHwAccelArgs({
      codec: "libx265",
      preset: "medium",
      crf: 30,
      profile: "zipstream",
      gopSize: 300,
      bframes: 8,
      mpdecimate: true,
      audio: false,
    }),
    []
  );
});
