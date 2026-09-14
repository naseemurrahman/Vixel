import assert from "node:assert/strict";
import test from "node:test";
import { buildEncodeArgs, buildStrategy, compressionRatio, profileDefaults } from "./compression-strategy.js";

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
