import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEncodeArgs, buildHwAccelArgs, buildStrategy, compressionRatio,
  encoderFamily, isHardwareCodec, profileDefaults,
} from "./compression-strategy.js";

test("zipstream profile targets aggressive static-scene temporal reduction", () => {
  const defaults = profileDefaults("zipstream");
  assert.equal(defaults.staticFrameStride, 5);
  assert.ok(defaults.motionThreshold > 0 && defaults.motionThreshold < 0.05);
  assert.ok(defaults.defaultGop >= 240);
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
    codec: "hevc_nvenc", preset: "medium", crf: 30, profile: "zipstream",
    gopSize: 300, bframes: 8, mpdecimate: true, audio: false,
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
    codec: "h264_qsv", preset: "medium", crf: 28, profile: "balanced",
    gopSize: 150, bframes: 5, mpdecimate: true, audio: false,
  });
  assert.ok(args.includes("-global_quality"));
  assert.ok(args.includes("28"));
  assert.ok(!args.includes("-crf"));
});

test("VAAPI encode requires a device before -i and hwuploads after CPU filters", () => {
  const input = {
    codec: "hevc_vaapi" as const, preset: "medium", crf: 26, profile: "forensic" as const,
    gopSize: 60, bframes: 3, mpdecimate: false, audio: false,
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
  assert.deepEqual(buildHwAccelArgs({
    codec: "libx265", preset: "medium", crf: 30, profile: "zipstream",
    gopSize: 300, bframes: 8, mpdecimate: true, audio: false,
  }), []);
});
