import type { CampaignTheme } from "../campaign.ts";
import type { ChaserMode } from "../contracts.ts";

export interface ThemeAudioPartial {
  readonly ratio: number;
  readonly gain: number;
  readonly decayScale: number;
}

/**
 * A network-free musical fingerprint mixed quietly beneath the mastered score.
 * Values describe material and rhythm rather than a genre label, which keeps
 * the generator deterministic and makes the four campaign spaces auditable.
 */
export interface ThemeAudioIdentityProfile {
  readonly instrumentIdentity: string;
  readonly mechanicIdentity: string;
  readonly tempoBpm: number;
  readonly stepsPerBeat: number;
  readonly swing: number;
  readonly rhythmPattern: readonly number[];
  /** -1 is a rest; other values index `pitchHertz`. */
  readonly noteSequence: readonly number[];
  readonly pitchHertz: readonly number[];
  readonly partials: readonly ThemeAudioPartial[];
  readonly attackSeconds: number;
  readonly decaySeconds: number;
  readonly transientNoiseMix: number;
  readonly filterType: BiquadFilterType;
  readonly filterHertz: number;
  readonly filterQ: number;
  readonly outputGain: number;
  readonly threatBodyHertz: number;
  readonly threatPulseSeconds: number;
}

const partial = (
  ratio: number,
  gain: number,
  decayScale: number,
): ThemeAudioPartial => Object.freeze({ ratio, gain, decayScale });

const THEME_AUDIO_IDENTITY_PROFILES: Readonly<
  Record<CampaignTheme, ThemeAudioIdentityProfile>
> = Object.freeze({
  campus: Object.freeze({
    instrumentIdentity: "felt classroom mallets and muted desk wood",
    mechanicIdentity: "short school-bell clapper with a wooden return",
    tempoBpm: 94,
    stepsPerBeat: 2,
    swing: 0.08,
    rhythmPattern: Object.freeze([
      0.72, 0, 0.18, 0, 0.42, 0, 0, 0.24,
      0.62, 0, 0.26, 0, 0.36, 0, 0.14, 0,
    ]),
    noteSequence: Object.freeze([
      0, -1, 2, -1, 1, -1, -1, 3,
      0, -1, 4, -1, 2, -1, 1, -1,
    ]),
    pitchHertz: Object.freeze([261.63, 293.66, 329.63, 392, 440]),
    partials: Object.freeze([
      partial(1, 1, 1),
      partial(2.01, 0.34, 0.58),
      partial(3.96, 0.13, 0.34),
    ]),
    attackSeconds: 0.012,
    decaySeconds: 0.46,
    transientNoiseMix: 0.12,
    filterType: "lowpass",
    filterHertz: 2_650,
    filterQ: 0.54,
    outputGain: 0.008,
    threatBodyHertz: 116,
    threatPulseSeconds: 0.88,
  }),
  hospital: Object.freeze({
    instrumentIdentity: "bowed glass harmonics over an irregular trolley pulse",
    mechanicIdentity: "curtain-rail glide and rubber trolley resonance",
    tempoBpm: 67,
    stepsPerBeat: 2,
    swing: 0,
    rhythmPattern: Object.freeze([
      0.46, 0, 0, 0, 0.16, 0,
      0, 0.24, 0, 0, 0, 0.12,
    ]),
    noteSequence: Object.freeze([
      0, -1, -1, -1, 2, -1,
      -1, 1, -1, -1, -1, 3,
    ]),
    pitchHertz: Object.freeze([220, 246.94, 277.18, 369.99]),
    partials: Object.freeze([
      partial(1, 1, 1),
      partial(2.73, 0.22, 1.18),
      partial(4.07, 0.1, 0.78),
    ]),
    attackSeconds: 0.085,
    decaySeconds: 1.42,
    transientNoiseMix: 0.035,
    filterType: "bandpass",
    filterHertz: 1_920,
    filterQ: 0.72,
    outputGain: 0.0062,
    threatBodyHertz: 92,
    threatPulseSeconds: 1.16,
  }),
  "fire-station": Object.freeze({
    instrumentIdentity: "muted brass breath and brushed radio cadence",
    mechanicIdentity: "radio squelch followed by a hose-cabinet thump",
    tempoBpm: 112,
    stepsPerBeat: 2,
    swing: 0.12,
    rhythmPattern: Object.freeze([
      0.6, 0, 0.22, 0.12, 0, 0.32, 0, 0.18,
      0.52, 0.16, 0, 0.28, 0, 0.36, 0.14, 0,
    ]),
    noteSequence: Object.freeze([
      0, -1, 1, 0, -1, 2, -1, 1,
      0, 1, -1, 3, -1, 2, 1, -1,
    ]),
    pitchHertz: Object.freeze([110, 146.83, 164.81, 196]),
    partials: Object.freeze([
      partial(1, 1, 1),
      partial(2, 0.42, 0.86),
      partial(3.02, 0.2, 0.62),
      partial(4.01, 0.08, 0.44),
    ]),
    attackSeconds: 0.038,
    decaySeconds: 0.72,
    transientNoiseMix: 0.19,
    filterType: "lowpass",
    filterHertz: 1_480,
    filterQ: 0.68,
    outputGain: 0.0086,
    threatBodyHertz: 82,
    threatPulseSeconds: 0.64,
  }),
  factory: Object.freeze({
    instrumentIdentity: "damped steel, chain scrape and a five-step press cycle",
    mechanicIdentity: "gear ratchet resolving into a broad steel press impact",
    tempoBpm: 86,
    stepsPerBeat: 2,
    swing: 0.03,
    rhythmPattern: Object.freeze([
      0.78, 0, 0.34, 0.18, 0,
      0.54, 0.14, 0, 0.3, 0.22,
    ]),
    noteSequence: Object.freeze([
      0, -1, 2, 1, -1,
      0, 3, -1, 1, 2,
    ]),
    pitchHertz: Object.freeze([73.42, 98, 110, 130.81]),
    partials: Object.freeze([
      partial(1, 1, 1),
      partial(2.67, 0.38, 1.22),
      partial(4.31, 0.24, 0.88),
      partial(6.18, 0.1, 0.56),
    ]),
    attackSeconds: 0.006,
    decaySeconds: 1.04,
    transientNoiseMix: 0.24,
    filterType: "bandpass",
    filterHertz: 1_180,
    filterQ: 1.08,
    outputGain: 0.0094,
    threatBodyHertz: 68,
    threatPulseSeconds: 0.52,
  }),
});

export interface ThreatLayerMix {
  readonly gain: number;
  readonly filterHertz: number;
  readonly filterQ: number;
  readonly transitionSeconds: number;
}

const CHASER_MODE_THREAT: Readonly<
  Record<ChaserMode, Omit<ThreatLayerMix, "filterHertz">>
> = Object.freeze({
  "spawn-delay": Object.freeze({ gain: 0, filterQ: 0.62, transitionSeconds: 0.42 }),
  patrol: Object.freeze({ gain: 0, filterQ: 0.62, transitionSeconds: 0.6 }),
  suspicious: Object.freeze({ gain: 0.0058, filterQ: 0.78, transitionSeconds: 0.2 }),
  chase: Object.freeze({ gain: 0.0135, filterQ: 0.92, transitionSeconds: 0.12 }),
  "lost-sight": Object.freeze({ gain: 0.0072, filterQ: 0.74, transitionSeconds: 0.48 }),
  "go-to-last-known": Object.freeze({ gain: 0.0042, filterQ: 0.68, transitionSeconds: 0.7 }),
  "scan-last-known": Object.freeze({ gain: 0.0036, filterQ: 0.66, transitionSeconds: 0.82 }),
  search: Object.freeze({ gain: 0.0048, filterQ: 0.72, transitionSeconds: 0.54 }),
  "check-hide": Object.freeze({ gain: 0.0105, filterQ: 0.96, transitionSeconds: 0.16 }),
});

export function themeAudioIdentityProfile(
  theme: CampaignTheme,
): ThemeAudioIdentityProfile {
  return THEME_AUDIO_IDENTITY_PROFILES[theme];
}

export function themeRhythmicOnsets(
  theme: CampaignTheme,
  cycles = 1,
): readonly number[] {
  const profile = themeAudioIdentityProfile(theme);
  const stepSeconds = 60 / profile.tempoBpm / profile.stepsPerBeat;
  const safeCycles = Math.max(1, Math.floor(Number.isFinite(cycles) ? cycles : 1));
  const onsets: number[] = [];
  for (let cycle = 0; cycle < safeCycles; cycle += 1) {
    for (let step = 0; step < profile.rhythmPattern.length; step += 1) {
      if (profile.rhythmPattern[step] <= 0 || profile.noteSequence[step] < 0) continue;
      const swung = step % 2 === 1 ? stepSeconds * profile.swing : 0;
      onsets.push(
        (cycle * profile.rhythmPattern.length + step) * stepSeconds + swung,
      );
    }
  }
  return Object.freeze(onsets);
}

/** Weighted nominal centroid; useful for mix audits without a Web Audio graph. */
export function themeSpectralCentroidHertz(theme: CampaignTheme): number {
  const profile = themeAudioIdentityProfile(theme);
  let weightedHertz = 0;
  let weight = 0;
  for (const pitch of profile.pitchHertz) {
    for (const voice of profile.partials) {
      weightedHertz += pitch * voice.ratio * voice.gain;
      weight += voice.gain;
    }
  }
  return weight > 0 ? weightedHertz / weight : 0;
}

export function threatLayerMixForMode(
  theme: CampaignTheme,
  mode: ChaserMode,
  audibility = 0,
): ThreatLayerMix {
  const profile = themeAudioIdentityProfile(theme);
  const base = CHASER_MODE_THREAT[mode];
  const audible = Number.isFinite(audibility)
    ? Math.max(0, Math.min(1, audibility))
    : 0;
  const urgency = mode === "chase" || mode === "check-hide"
    ? 1
    : mode === "suspicious" || mode === "lost-sight"
      ? 0.62
      : 0.28;
  return Object.freeze({
    gain: base.gain * (0.76 + audible * 0.24),
    filterHertz: profile.threatBodyHertz * (4.1 + urgency * 4.8),
    filterQ: base.filterQ,
    transitionSeconds: base.transitionSeconds,
  });
}

function hashNoise(index: number, seed: number): number {
  let state = (index + 1) ^ seed;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return ((state >>> 0) / 0xffff_ffff) * 2 - 1;
}

export interface RenderedThemeIdentity {
  readonly samples: Float32Array;
  readonly durationSeconds: number;
  readonly onsetsSeconds: readonly number[];
}

/**
 * Render a compact additive/percussive loop. The source is generated only
 * after audio unlock, so it adds neither a request nor decode work to first
 * paint. Every note has several inharmonic partials plus material noise.
 */
export function renderThemeIdentityPcm(
  theme: CampaignTheme,
  sampleRate: number,
  minimumSeconds = 7.5,
): RenderedThemeIdentity {
  const profile = themeAudioIdentityProfile(theme);
  const safeRate = Math.max(
    1_000,
    Math.min(
      96_000,
      Math.floor(Number.isFinite(sampleRate) ? sampleRate : 16_000),
    ),
  );
  const safeMinimumSeconds = Number.isFinite(minimumSeconds)
    ? Math.max(0.5, minimumSeconds)
    : 7.5;
  const stepSeconds = 60 / profile.tempoBpm / profile.stepsPerBeat;
  const cycleSeconds = profile.rhythmPattern.length * stepSeconds;
  const cycles = Math.max(1, Math.ceil(safeMinimumSeconds / cycleSeconds));
  const durationSeconds = cycles * cycleSeconds;
  const length = Math.max(1, Math.floor(durationSeconds * safeRate));
  const samples = new Float32Array(length);
  const onsets = themeRhythmicOnsets(theme, cycles);
  const maxLookbackSteps = Math.max(
    1,
    Math.ceil(profile.decaySeconds * 4 / stepSeconds),
  );
  let peak = 0;
  for (let index = 0; index < length; index += 1) {
    const time = index / safeRate;
    const absoluteStep = Math.floor(time / stepSeconds);
    let sample = 0;
    for (let lookback = 0; lookback <= maxLookbackSteps; lookback += 1) {
      const eventStep = absoluteStep - lookback;
      if (eventStep < 0) continue;
      const patternStep = eventStep % profile.rhythmPattern.length;
      const accent = profile.rhythmPattern[patternStep];
      const pitchIndex = profile.noteSequence[patternStep];
      if (accent <= 0 || pitchIndex < 0) continue;
      const swingOffset = patternStep % 2 === 1
        ? stepSeconds * profile.swing
        : 0;
      const localTime = time - (eventStep * stepSeconds + swingOffset);
      if (localTime < 0 || localTime > profile.decaySeconds * 4) continue;
      const attack = profile.attackSeconds <= 0
        ? 1
        : Math.min(1, localTime / profile.attackSeconds);
      const pitch = profile.pitchHertz[pitchIndex % profile.pitchHertz.length];
      let tone = 0;
      for (let voice = 0; voice < profile.partials.length; voice += 1) {
        const harmonic = profile.partials[voice];
        const envelope = Math.exp(
          -localTime / Math.max(0.01, profile.decaySeconds * harmonic.decayScale),
        );
        tone += Math.sin(
          Math.PI * 2 * pitch * harmonic.ratio * localTime + voice * 0.37,
        ) * harmonic.gain * envelope;
      }
      const material = hashNoise(index, 0x61c8 + eventStep * 97)
        * Math.exp(-localTime / 0.038);
      sample += accent
        * attack
        * (tone * (1 - profile.transientNoiseMix)
          + material * profile.transientNoiseMix);
    }
    samples[index] = sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const normalizer = peak > 0 ? 0.72 / peak : 1;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] *= normalizer;
  }
  const seamSamples = Math.min(
    Math.floor(safeRate * 0.028),
    Math.floor(samples.length / 2),
  );
  for (let index = 0; index < seamSamples; index += 1) {
    const fade = Math.sin((index / Math.max(1, seamSamples - 1)) * Math.PI / 2);
    samples[index] *= fade;
    samples[samples.length - 1 - index] *= fade;
  }
  return Object.freeze({
    samples,
    durationSeconds,
    onsetsSeconds: onsets,
  });
}

export function renderThreatTexturePcm(
  theme: CampaignTheme,
  sampleRate: number,
): Float32Array {
  const profile = themeAudioIdentityProfile(theme);
  const safeRate = Math.max(
    1_000,
    Math.min(
      96_000,
      Math.floor(Number.isFinite(sampleRate) ? sampleRate : 12_000),
    ),
  );
  const pulseCycles = Math.max(8, Math.ceil(4.8 / profile.threatPulseSeconds));
  const durationSeconds = profile.threatPulseSeconds * pulseCycles;
  const length = Math.max(1, Math.floor(durationSeconds * safeRate));
  const samples = new Float32Array(length);
  let slowNoise = 0;
  let peak = 0;
  for (let index = 0; index < length; index += 1) {
    const time = index / safeRate;
    const pulsePhase = (time % profile.threatPulseSeconds)
      / profile.threatPulseSeconds;
    const pulse = 0.18
      + Math.sin(Math.PI * Math.min(1, pulsePhase / 0.62)) ** 2 * 0.82;
    slowNoise += (hashNoise(index, 0x9e3779b9) - slowNoise) * 0.045;
    const body = Math.sin(Math.PI * 2 * profile.threatBodyHertz * time)
      + Math.sin(Math.PI * 2 * profile.threatBodyHertz * 1.51 * time + 0.6) * 0.36;
    const sample = (body * 0.34 + slowNoise * 0.66) * pulse;
    samples[index] = sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const normalizer = peak > 0 ? 0.64 / peak : 1;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] *= normalizer;
  }
  const seamSamples = Math.min(
    Math.floor(safeRate * 0.032),
    Math.floor(samples.length / 2),
  );
  for (let index = 0; index < seamSamples; index += 1) {
    const fade = Math.sin((index / Math.max(1, seamSamples - 1)) * Math.PI / 2);
    samples[index] *= fade;
    samples[samples.length - 1 - index] *= fade;
  }
  return samples;
}
