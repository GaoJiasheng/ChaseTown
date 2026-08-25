export type Point = { x: number; y: number };
export type Phase = "ready" | "playing" | "caught" | "won" | "lost";
export type ActorName = "kid" | "villain" | "police";
export type AiState = "delay" | "chase" | "search" | "patrol";
export type AiMemory = {
  state: AiState;
  lastKnown: Point | null;
  searchArrivedAt: number | null;
};
export type ActorMotionRuntime = {
  gaitWeight: number;
  gaitPhase: number;
  actualSpeed: number;
  heading: number;
  targetHeading: number;
  visualY: number;
  baseVisualY: number;
};
export type GridPathCache = {
  signature: string;
  route: Point[];
  cursor: number;
  activeWaypoint: Point | null;
  recomputes: number;
  cacheHits: number;
  lastInvalidationReason: string;
};
export type GpuMemorySnapshot = {
  geometries: number;
  textures: number;
  programs: number;
};
export type ResourceDisposalReport = {
  reason: string;
  geometries: number;
  materials: number;
  textures: number;
  skeletons: number;
  externalTargets: number;
  before: GpuMemorySnapshot;
  after: GpuMemorySnapshot;
  completedAt: number;
  alreadyDisposed: boolean;
  contextLost: boolean;
};
