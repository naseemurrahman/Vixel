import assert from "node:assert/strict";
import test from "node:test";
import { buildEncodeArgs, buildStrategy, compressionRatio, profileDefaults } from "./compression-strategy.js";

test("zipstream profile keeps an aggressive long-GOP default", () => {
  const defaults = profileDefaults("zipstream");
  assert.ok(defaults.defaultGop >= 240);
  assert.ok(defaults.defaultB >= 6);
});

test("adaptive strategy applies duplicate-frame reduction with normalized timestamps", () => {
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
  assert.ok(plan.videoFilters.some((f) => f.includes("mpdecimate=")));
  assert.ok(plan.videoFilters.some((f) => f.includes("setpts=")));
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
  assert.ok(args.includes("-vf"));
  assert.ok(args.some((arg) => arg.includes("mpdecimate=")));
});

test("compression math is bounded and deterministic", () => {
  assert.equal(compressionRatio(1000, 200), 0.8);
  assert.equal(compressionRatio(1000, 1000), 0);
  assert.equal(compressionRatio(0, 1), 0);
  assert.equal(compressionRatio(1000, 2000), 0);
});
