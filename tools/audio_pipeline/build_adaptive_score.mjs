#!/usr/bin/env node

/**
 * Build the phase-locked adaptive score used by Chasing.
 *
 * The source Apple Loops are intentionally not copied into the repository.
 * This script verifies their exact hashes, creates two original multi-loop
 * arrangements, performs two-pass EBU R128 mastering, and writes compact AAC
 * deliverables plus an auditable manifest.
 *
 * Requirements:
 *   - GarageBand's Apple Loops installed in /Library/Audio/Apple Loops
 *   - ffmpeg and ffprobe available on PATH (Homebrew paths are auto-detected)
 *
 * Run:
 *   node tools/audio_pipeline/build_adaptive_score.mjs
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_DIR = join(ROOT, "public/audio");
const APPLE_LOOPS_ROOT = "/Library/Audio/Apple Loops/Apple/01 Hip Hop";
const SAMPLE_RATE = 48_000;
const BPM = 101;
const BEATS = 64;
const LOOP_SECONDS = (BEATS * 60) / BPM;
const LOOP_SAMPLES = Math.round(LOOP_SECONDS * SAMPLE_RATE);
const MIDPOINT_SECONDS = LOOP_SECONDS / 2;
const SWELL_SECONDS = (2 * 60) / BPM;
const SWELL_START_SECONDS = MIDPOINT_SECONDS - SWELL_SECONDS;

const SOURCES = {
  ambient: {
    filename: "Slow Drift Ambient Synth.caf",
    sha256: "3f403c7ca600af00fc95ee9e14e9c082788fa91a5d6782b022ad29a1863c82ec",
    beats: 32,
    key: "Bb minor",
  },
  bass: {
    filename: "Slow Drift Bass Synth.caf",
    sha256: "1a09204465a976f0f06e6b5cde8826a102850c22745fe60dc450a0ac40006830",
    beats: 32,
    key: "Bb minor",
  },
  sub: {
    filename: "Slow Drift Sub Bass.caf",
    sha256: "05e71a9f6f61f582c12faad42afbb9134360be072b0c31f486adc0ade7cd8f81",
    beats: 64,
    key: "Bb minor",
  },
  beat: {
    filename: "Slow Drift Beat.caf",
    sha256: "2b30e32187ff88fb7c767f6276673abc9fbf5436d3170d22501ae9ce77b8ddd4",
    beats: 64,
    key: "keyless percussion",
  },
};

const OUTPUTS = {
  explore: {
    filename: "slow-drift-explore.m4a",
    title: "Slow Drift · Explore",
    targetLufs: -22,
    targetLra: 10,
  },
  threat: {
    filename: "slow-drift-threat.m4a",
    title: "Slow Drift · Threat",
    targetLufs: -20,
    targetLra: 8,
  },
};

function findBinary(name) {
  const candidates = [
    name,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error(`${name} is required but was not found`);
}

const FFMPEG = findBinary("ffmpeg");
const FFPROBE = findBinary("ffprobe");

function run(binary, args, { capture = false } = {}) {
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${binary} exited with ${result.status}${detail}`);
  }
  return result;
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function verifySources() {
  const resolved = {};
  for (const [id, source] of Object.entries(SOURCES)) {
    const filename = join(APPLE_LOOPS_ROOT, source.filename);
    if (!existsSync(filename)) {
      throw new Error(
        `Missing licensed Apple Loop: ${filename}\n` +
        "Install the GarageBand sound library before rebuilding the score.",
      );
    }
    const actualHash = sha256(filename);
    if (actualHash !== source.sha256) {
      throw new Error(
        `Apple Loop hash mismatch for ${source.filename}\n` +
        `Expected ${source.sha256}\nActual   ${actualHash}`,
      );
    }
    resolved[id] = filename;
  }
  return resolved;
}

function commonInputs(sourcePaths) {
  // The 32-beat melodic sources are looped once to fill the shared 64-beat
  // timeline. All four inputs are decoded independently before arrangement.
  return [
    "-stream_loop", "1", "-i", sourcePaths.ambient,
    "-stream_loop", "1", "-i", sourcePaths.bass,
    "-stream_loop", "0", "-i", sourcePaths.sub,
    "-stream_loop", "0", "-i", sourcePaths.beat,
  ];
}

function buildExploreFilter() {
  const length = LOOP_SECONDS.toFixed(9);
  const middle = MIDPOINT_SECONDS.toFixed(9);
  const swellStart = SWELL_START_SECONDS.toFixed(9);
  const swellDelayMs = Math.round(SWELL_START_SECONDS * 1000);
  return [
    `[0:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,asplit=2[ambient-main][ambient-swell-source]`,
    `[ambient-main]highpass=f=62,lowpass=f=11200,` +
      `equalizer=f=330:t=q:w=0.9:g=-1.8,stereotools=mlev=0.96:slev=1.10,` +
      `volume=if(isnan(t)\\,0.36\\,0.36+0.055*pow(sin(2*PI*t/${length})\\,2)):eval=frame[ambient]`,
    `[1:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,highpass=f=72,lowpass=f=6200,` +
      `equalizer=f=210:t=q:w=0.8:g=-2.5,` +
      `volume=if(isnan(t)\\,0.075\\,0.075+0.080*pow(sin(PI*t/${length})\\,2)):eval=frame[bass]`,
    `[2:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,lowpass=f=145,` +
      `volume=if(isnan(t)\\,0.016\\,0.016+0.032*pow(sin(PI*t/${length})\\,4)):eval=frame[sub]`,
    `[3:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,highpass=f=2700,lowpass=f=8200,` +
      `volume=if(isnan(t)\\,0.010\\,0.010+0.020*pow(sin(PI*t/${length})\\,4)):eval=frame[ghost-beat]`,
    `[ambient-swell-source]atrim=start=${swellStart}:end=${middle},asetpts=PTS-STARTPTS,` +
      `areverse,highpass=f=620,lowpass=f=6900,` +
      `afade=t=in:st=0:d=0.18,afade=t=out:st=${(SWELL_SECONDS - 0.28).toFixed(9)}:d=0.28,` +
      `volume=0.14,adelay=${swellDelayMs}:all=1[swell]`,
    `[ambient][bass][sub][ghost-beat][swell]amix=inputs=5:duration=longest:normalize=0,` +
      `alimiter=limit=0.891251:attack=7:release=130:level=false:latency=true,` +
      `apad=whole_len=${LOOP_SAMPLES},atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB[out]`,
  ].join(";");
}

function buildThreatFilter() {
  const length = LOOP_SECONDS.toFixed(9);
  return [
    `[3:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,highpass=f=35,lowpass=f=14200,` +
      `equalizer=f=3100:t=q:w=1.1:g=-1.2,stereotools=mlev=0.99:slev=1.04,` +
      `volume=if(isnan(t)\\,0.205\\,0.205+0.145*pow(sin(PI*t/${length})\\,2)+0.035*pow(sin(4*PI*t/${length})\\,2)):eval=frame[beat]`,
    `[2:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,lowpass=f=175,` +
      `volume=if(isnan(t)\\,0.115\\,0.115+0.105*pow(sin(PI*t/${length})\\,2)):eval=frame[sub]`,
    `[1:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,highpass=f=70,lowpass=f=7200,` +
      `equalizer=f=230:t=q:w=0.8:g=-2.0,` +
      `volume=if(isnan(t)\\,0.095\\,0.095+0.070*pow(sin(2*PI*t/${length})\\,2)):eval=frame[bass]`,
    `[0:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
      `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB,highpass=f=180,lowpass=f=5900,` +
      `equalizer=f=1200:t=q:w=1.0:g=-1.5,stereotools=mlev=0.98:slev=1.08,` +
      `volume=if(isnan(t)\\,0.060\\,0.060+0.030*pow(sin(2*PI*t/${length})\\,2)):eval=frame[atmosphere]`,
    `[beat][sub][bass][atmosphere]amix=inputs=4:duration=longest:normalize=0,` +
      `acompressor=threshold=0.24:ratio=1.55:attack=18:release=170:makeup=1.0:knee=2.5,` +
      `alimiter=limit=0.891251:attack=5:release=110:level=false:latency=true,` +
      `apad=whole_len=${LOOP_SAMPLES},atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB[out]`,
  ].join(";");
}

function buildRawMix(kind, sourcePaths, outputPath) {
  const filter = kind === "explore" ? buildExploreFilter() : buildThreatFilter();
  run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    ...commonInputs(sourcePaths),
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:a", "pcm_f32le",
    "-ar", String(SAMPLE_RATE),
    "-ac", "2",
    outputPath,
  ]);
}

function analyzeLoudness(filename, targetLufs, targetLra) {
  const result = run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", filename,
    "-af", `loudnorm=I=${targetLufs}:TP=-1.5:LRA=${targetLra}:print_format=json`,
    "-f", "null", "-",
  ], { capture: true });
  const matches = [...result.stderr.matchAll(/\{\s*"input_i"[\s\S]*?\}/gu)];
  if (!matches.length) throw new Error(`Could not parse loudness analysis for ${filename}`);
  return JSON.parse(matches.at(-1)[0]);
}

function masterMix(rawPath, outputPath, config) {
  const measured = analyzeLoudness(rawPath, config.targetLufs, config.targetLra);
  const loudnorm = [
    `loudnorm=I=${config.targetLufs}`,
    "TP=-1.5",
    `LRA=${config.targetLra}`,
    `measured_I=${measured.input_i}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_TP=${measured.input_tp}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    "linear=true",
    "print_format=summary",
  ].join(":");

  run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", rawPath,
    "-af",
    `${loudnorm},aresample=${SAMPLE_RATE}:async=0,` +
      `apad=whole_len=${LOOP_SAMPLES},atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB`,
    "-c:a", "aac",
    "-profile:a", "aac_low",
    "-b:a", "192k",
    "-ar", String(SAMPLE_RATE),
    "-ac", "2",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    "-metadata", `title=${config.title}`,
    "-metadata", "artist=Chasing Audio Prototype",
    "-metadata", "album=Chasing · Adaptive Score",
    "-metadata", "comment=Original multi-loop arrangement; see docs/licenses/APPLE_LOOPS_AUDIO.md",
    outputPath,
  ]);
}

function probe(filename) {
  const result = run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_name,sample_rate,channels",
    "-of", "json",
    filename,
  ], { capture: true });
  return JSON.parse(result.stdout);
}

function decodeSeamMetric(filename, pcmPath) {
  run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", filename,
    "-map", "0:a:0",
    "-af", `atrim=end_sample=${LOOP_SAMPLES},asetpts=N/SR/TB`,
    "-f", "f32le",
    "-acodec", "pcm_f32le",
    "-ar", String(SAMPLE_RATE),
    "-ac", "2",
    pcmPath,
  ]);
  const buffer = readFileSync(pcmPath);
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  const channelCount = 2;
  const windowFrames = Math.min(960, Math.floor(samples.length / channelCount / 4));
  let firstWindowEnergy = 0;
  let lastWindowEnergy = 0;
  for (let index = 0; index < windowFrames * channelCount; index += 1) {
    firstWindowEnergy += samples[index] * samples[index];
    const end = samples[samples.length - windowFrames * channelCount + index];
    lastWindowEnergy += end * end;
  }
  const firstWindowRms = Math.sqrt(firstWindowEnergy / (windowFrames * channelCount));
  const lastWindowRms = Math.sqrt(lastWindowEnergy / (windowFrames * channelCount));
  const boundaryJump = Math.max(
    ...Array.from({ length: channelCount }, (_, channel) => {
      const first = samples[channel];
      const last = samples[samples.length - channelCount + channel];
      return Math.abs(first - last);
    }),
  );
  const boundaryDerivativeJump = Math.max(
    ...Array.from({ length: channelCount }, (_, channel) => {
      const firstDerivative = samples[channelCount + channel] - samples[channel];
      const lastDerivative =
        samples[samples.length - channelCount + channel] -
        samples[samples.length - 2 * channelCount + channel];
      return Math.abs(firstDerivative - lastDerivative);
    }),
  );
  return {
    decodedFrames: Math.floor(samples.length / channelCount),
    seamWindowMs: (windowFrames / SAMPLE_RATE) * 1000,
    firstWindowRms,
    lastWindowRms,
    boundaryJump,
    boundaryDerivativeJump,
  };
}

function validateOutput(kind, filename, config, tempDirectory) {
  const media = probe(filename);
  const stream = media.streams?.[0];
  const duration = Number(media.format?.duration);
  if (stream?.codec_name !== "aac") throw new Error(`${kind}: expected AAC audio`);
  if (Number(stream?.sample_rate) !== SAMPLE_RATE) throw new Error(`${kind}: expected ${SAMPLE_RATE} Hz`);
  if (Number(stream?.channels) !== 2) throw new Error(`${kind}: expected stereo audio`);
  if (!Number.isFinite(duration) || Math.abs(duration - LOOP_SECONDS) > 0.035) {
    throw new Error(`${kind}: unexpected duration ${duration}s`);
  }

  const loudness = analyzeLoudness(filename, config.targetLufs, config.targetLra);
  const integratedLufs = Number(loudness.input_i);
  const truePeakDb = Number(loudness.input_tp);
  if (Math.abs(integratedLufs - config.targetLufs) > 0.6) {
    throw new Error(`${kind}: loudness ${integratedLufs} LUFS missed target ${config.targetLufs}`);
  }
  if (truePeakDb > -1.35) {
    throw new Error(`${kind}: true peak ${truePeakDb} dBTP exceeds -1.35 dBTP gate`);
  }

  const seam = decodeSeamMetric(filename, join(tempDirectory, `${kind}.f32le`));
  if (seam.decodedFrames !== LOOP_SAMPLES) {
    throw new Error(
      `${kind}: decoded playable timeline has ${seam.decodedFrames} frames; expected ${LOOP_SAMPLES}`,
    );
  }
  // AAC alters a few edge samples, so this is a regression guard rather than
  // a demand for bit-identical endpoints. Audible seam review remains required.
  if (seam.boundaryJump > 0.12) {
    throw new Error(`${kind}: encoded loop boundary jump ${seam.boundaryJump.toFixed(4)} is unsafe`);
  }
  if (seam.boundaryDerivativeJump > 0.08) {
    throw new Error(
      `${kind}: encoded loop boundary derivative jump ${seam.boundaryDerivativeJump.toFixed(4)} is unsafe`,
    );
  }

  return {
    file: `public/audio/${config.filename}`,
    sha256: sha256(filename),
    bytes: Number(media.format.size),
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    durationSeconds: duration,
    integratedLufs,
    truePeakDb,
    loudnessRangeLu: Number(loudness.input_lra),
    seam,
  };
}

function analyzeBlend(explorePath, threatPath, exploreGain, threatGain) {
  const result = run(FFMPEG, [
    "-hide_banner", "-nostats",
    "-i", explorePath,
    "-i", threatPath,
    "-filter_complex",
    `[0:a]volume=${exploreGain}[explore];` +
      `[1:a]volume=${threatGain}[threat];` +
      "[explore][threat]amix=inputs=2:duration=shortest:normalize=0," +
      "loudnorm=I=-18:TP=-1.5:LRA=9:print_format=json[mix]",
    "-map", "[mix]",
    "-f", "null", "-",
  ], { capture: true });
  const matches = [...result.stderr.matchAll(/\{\s*"input_i"[\s\S]*?\}/gu)];
  if (!matches.length) throw new Error("Could not parse adaptive blend loudness analysis");
  const measured = JSON.parse(matches.at(-1)[0]);
  return {
    exploreGain,
    threatGain,
    integratedLufs: Number(measured.input_i),
    truePeakDb: Number(measured.input_tp),
    loudnessRangeLu: Number(measured.input_lra),
  };
}

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const tempDirectory = mkdtempSync(join(tmpdir(), "chasing-adaptive-score-"));
  try {
    const sourcePaths = verifySources();
    const report = {};
    for (const [kind, config] of Object.entries(OUTPUTS)) {
      const rawPath = join(tempDirectory, `${kind}-raw.wav`);
      const outputPath = join(OUTPUT_DIR, config.filename);
      process.stdout.write(`Building ${kind} arrangement...\n`);
      buildRawMix(kind, sourcePaths, rawPath);
      masterMix(rawPath, outputPath, config);
      report[kind] = validateOutput(kind, outputPath, config, tempDirectory);
    }

    const durationDelta = Math.abs(report.explore.durationSeconds - report.threat.durationSeconds);
    if (durationDelta > 0.001) {
      throw new Error(`Adaptive stems are not phase-aligned; duration delta=${durationDelta}s`);
    }

    const recommendedFullThreatBlend = analyzeBlend(
      join(OUTPUT_DIR, OUTPUTS.explore.filename),
      join(OUTPUT_DIR, OUTPUTS.threat.filename),
      0.40,
      0.94,
    );
    if (recommendedFullThreatBlend.truePeakDb > -1.70) {
      throw new Error(
        `Recommended adaptive blend true peak ${recommendedFullThreatBlend.truePeakDb} dBTP is unsafe`,
      );
    }
    if (
      recommendedFullThreatBlend.integratedLufs < -21 ||
      recommendedFullThreatBlend.integratedLufs > -18.5
    ) {
      throw new Error(
        `Recommended adaptive blend loudness ${recommendedFullThreatBlend.integratedLufs} LUFS is out of range`,
      );
    }

    const manifest = {
      schemaVersion: 1,
      scoreId: "slow-drift-adaptive-v1",
      arrangement: "Original two-stem adaptive score for Chasing",
      licenseRecord: "docs/licenses/APPLE_LOOPS_AUDIO.md",
      licenseUrl: "https://support.apple.com/en-us/102034",
      timeline: {
        bpm: BPM,
        timeSignature: "4/4",
        key: "Bb minor",
        beats: BEATS,
        expectedDurationSeconds: LOOP_SECONDS,
        expectedSamplesAt48k: LOOP_SAMPLES,
      },
      sources: Object.fromEntries(
        Object.entries(SOURCES).map(([id, source]) => [id, {
          filename: source.filename,
          sha256: source.sha256,
          beats: source.beats,
          key: source.key,
          redistributed: false,
        }]),
      ),
      outputs: report,
      recommendedRuntimeMix: {
        model: "Base layer remains audible while the threat layer rises",
        exploreGainAtThreat0: 1.0,
        exploreGainAtThreat1: 0.40,
        threatGainAtThreat0: 0.0,
        threatGainAtThreat1: 0.94,
        smoothing: { attackSeconds: 0.22, releaseSeconds: 1.2 },
        verifiedFullThreatBlend: recommendedFullThreatBlend,
      },
      qualityGates: {
        multiLoopArrangement: true,
        singleLoopExport: false,
        oscillatorOrGeneratedBeeps: false,
        exactSourceHashVerification: true,
        maxStemDurationDeltaSeconds: 0.001,
        maxTruePeakDb: -1.35,
        loudnessToleranceLu: 0.6,
        manualHeadphoneLoopReviewRequired: true,
      },
    };
    writeFileSync(
      join(OUTPUT_DIR, "adaptive-score-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(manifest.outputs, null, 2)}\n`);
    process.stdout.write("Adaptive score build and automated audio gates passed.\n");
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main();
