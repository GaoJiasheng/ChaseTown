import type { CampaignLevelDefinition, CampaignTheme } from "./campaign.ts";

export type AtmosphereParticleKind = "dust" | "rain" | "embers" | "steam" | "none";

export interface RuntimeAtmosphereProfile {
  readonly exposure: number;
  readonly fogDensity: number;
  readonly environmentIntensity: number;
  readonly hemisphereIntensity: number;
  readonly keyIntensity: number;
  readonly bounceIntensity: number;
  readonly pulseHertz: number;
  readonly pulseDepth: number;
  readonly particleKind: AtmosphereParticleKind;
  readonly particleColor: string;
  readonly particleCount: number;
  readonly particleSpeed: number;
}

const profile = (value: RuntimeAtmosphereProfile) => Object.freeze(value);

const LEVEL_ATMOSPHERES: Readonly<Record<string, RuntimeAtmosphereProfile>> = Object.freeze({
  "school-maze-v1": profile({
    exposure: 1.02, fogDensity: 0.0148, environmentIntensity: 0.62,
    hemisphereIntensity: 0.52, keyIntensity: 1.82, bounceIntensity: 0.22,
    pulseHertz: 0, pulseDepth: 0, particleKind: "dust", particleColor: "#f5d99b",
    particleCount: 150, particleSpeed: 0.06,
  }),
  "campus-library-lockdown": profile({
    exposure: 0.94, fogDensity: 0.0185, environmentIntensity: 0.54,
    hemisphereIntensity: 0.42, keyIntensity: 1.58, bounceIntensity: 0.28,
    pulseHertz: 0.12, pulseDepth: 0.035, particleKind: "dust", particleColor: "#dbc58e",
    particleCount: 210, particleSpeed: 0.035,
  }),
  "campus-science-wing": profile({
    exposure: 0.98, fogDensity: 0.0195, environmentIntensity: 0.58,
    hemisphereIntensity: 0.46, keyIntensity: 1.72, bounceIntensity: 0.44,
    pulseHertz: 0.72, pulseDepth: 0.16, particleKind: "rain", particleColor: "#8ddde2",
    particleCount: 260, particleSpeed: 0.8,
  }),
  "hospital-outpatient-afterhours": profile({
    exposure: 1.04, fogDensity: 0.0172, environmentIntensity: 0.68,
    hemisphereIntensity: 0.62, keyIntensity: 2.02, bounceIntensity: 0.18,
    pulseHertz: 0.18, pulseDepth: 0.045, particleKind: "rain", particleColor: "#b8ece0",
    particleCount: 300, particleSpeed: 0.92,
  }),
  "hospital-isolation-basement": profile({
    exposure: 0.91, fogDensity: 0.023, environmentIntensity: 0.5,
    hemisphereIntensity: 0.38, keyIntensity: 1.55, bounceIntensity: 0.38,
    pulseHertz: 0.43, pulseDepth: 0.12, particleKind: "steam", particleColor: "#d6e5d9",
    particleCount: 220, particleSpeed: 0.22,
  }),
  "fire-station-engine-bay": profile({
    exposure: 0.98, fogDensity: 0.0215, environmentIntensity: 0.55,
    hemisphereIntensity: 0.44, keyIntensity: 1.78, bounceIntensity: 0.46,
    pulseHertz: 0.58, pulseDepth: 0.15, particleKind: "rain", particleColor: "#e6a76b",
    particleCount: 220, particleSpeed: 0.78,
  }),
  "fire-station-training-tower": profile({
    exposure: 0.9, fogDensity: 0.028, environmentIntensity: 0.46,
    hemisphereIntensity: 0.34, keyIntensity: 1.44, bounceIntensity: 0.58,
    pulseHertz: 0.9, pulseDepth: 0.21, particleKind: "embers", particleColor: "#ff7b32",
    particleCount: 300, particleSpeed: 0.42,
  }),
  "factory-assembly-nightshift": profile({
    exposure: 0.95, fogDensity: 0.021, environmentIntensity: 0.52,
    hemisphereIntensity: 0.4, keyIntensity: 1.68, bounceIntensity: 0.34,
    pulseHertz: 0.26, pulseDepth: 0.07, particleKind: "steam", particleColor: "#8bd5d0",
    particleCount: 220, particleSpeed: 0.24,
  }),
  "factory-turbine-hall": profile({
    exposure: 0.91, fogDensity: 0.0245, environmentIntensity: 0.48,
    hemisphereIntensity: 0.36, keyIntensity: 1.52, bounceIntensity: 0.43,
    pulseHertz: 0.34, pulseDepth: 0.1, particleKind: "steam", particleColor: "#6bcde8",
    particleCount: 320, particleSpeed: 0.34,
  }),
  "factory-foundry-final-run": profile({
    exposure: 0.9, fogDensity: 0.026, environmentIntensity: 0.45,
    hemisphereIntensity: 0.32, keyIntensity: 1.42, bounceIntensity: 0.66,
    pulseHertz: 0.68, pulseDepth: 0.18, particleKind: "embers", particleColor: "#ff8538",
    particleCount: 380, particleSpeed: 0.5,
  }),
});

const THEME_FALLBACK: Readonly<Record<CampaignTheme, RuntimeAtmosphereProfile>> = Object.freeze({
  campus: LEVEL_ATMOSPHERES["school-maze-v1"],
  hospital: LEVEL_ATMOSPHERES["hospital-outpatient-afterhours"],
  "fire-station": LEVEL_ATMOSPHERES["fire-station-engine-bay"],
  factory: LEVEL_ATMOSPHERES["factory-assembly-nightshift"],
});

export function runtimeAtmosphereForLevel(
  level: Pick<CampaignLevelDefinition, "campaign" | "id">,
): RuntimeAtmosphereProfile {
  return LEVEL_ATMOSPHERES[level.id] ?? THEME_FALLBACK[level.campaign.theme];
}

