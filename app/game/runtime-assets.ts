export type RuntimePreloadAsset = Readonly<{
  href: string;
  type: string;
  fetchPriority: "high" | "auto";
  /** Budget authority; fetchPriority is only a browser scheduling hint. */
  blocksFirstPlayable: boolean;
}>;

/**
 * Single source of truth for every model that blocks the first campaign's
 * first playable frame. The scene loader imports these exact URLs, while the
 * release manifest derives its preload accounting from the same object.
 */
export const FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS = Object.freeze({
  player: "/models/characters/kid-bootstrap.glb?v=1",
  threat: "/models/characters/villain-bootstrap.glb?v=5",
  theme: "/models/environment/themes/campus-kit-bootstrap.glb?v=1",
  locker: "/models/environment/locker.glb?v=32",
  cornerMirror: "/models/environment/stealth-corner-mirrors.glb?v=2",
  frontGate: "/models/environment/front-gate.glb?v=5",
  exit: "/models/environment/exit.glb?v=5",
  bench: "/models/environment/bench.glb?v=5",
  tree: "/models/environment/tree.glb?v=5",
  shrub: "/models/environment/shrub.glb?v=5",
  policeCar: "/models/environment/police-car.glb?v=5",
  basketball: "/models/environment/basketball.glb?v=5",
  deskChair: "/models/environment/desk-chair.glb?v=5",
  podium: "/models/environment/podium.glb?v=5",
} as const);

const blockingModelPreload = (
  key: keyof typeof FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS,
  fetchPriority: RuntimePreloadAsset["fetchPriority"],
): RuntimePreloadAsset => Object.freeze({
  href: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS[key],
  type: "model/gltf-binary",
  fetchPriority,
  blocksFirstPlayable: true,
});

/**
 * The first campaign is deterministic, so these requests can start from the
 * server-rendered head instead of waiting for React hydration and WebGL setup.
 * Query strings intentionally match the runtime URLs so the browser cache can
 * satisfy the controlled scene loader without a second transfer.
 */
export const FIRST_CAMPAIGN_PRELOAD_ASSETS: readonly RuntimePreloadAsset[] = Object.freeze([
  blockingModelPreload("player", "high"),
  blockingModelPreload("threat", "high"),
  blockingModelPreload("theme", "high"),
  Object.freeze({
    href: "/basis/basis_transcoder.wasm",
    type: "application/wasm",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  }),
  Object.freeze({
    href: "/basis/basis_transcoder.js",
    type: "text/javascript",
    fetchPriority: "auto",
    blocksFirstPlayable: true,
  }),
  Object.freeze({
    href: "/models/environment/SharedTexturesBootstrapKTX2/52296b1fc01087fabbba71997e3cc29996529b103d6ba6ba6c0814393477ae91.ktx2",
    type: "image/ktx2",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  }),
  Object.freeze({
    href: "/models/environment/SharedTexturesBootstrapKTX2/9bf9934adeb5f6152f6ab96e9450405775db96d7f279044840c01cd5da8328d9.ktx2",
    type: "image/ktx2",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  }),
  Object.freeze({
    href: "/models/environment/SharedTexturesBootstrapKTX2/9c68b4a0471dc9847d6de259c5d33970cb07a949acdb6c807d3b8784801a6b8a.ktx2",
    type: "image/ktx2",
    fetchPriority: "auto",
    blocksFirstPlayable: true,
  }),
  blockingModelPreload("locker", "high"),
  blockingModelPreload("cornerMirror", "high"),
  ...[
    "frontGate",
    "exit",
    "bench",
    "tree",
    "shrub",
    "policeCar",
    "basketball",
    "deskChair",
    "podium",
  ].map((key) => blockingModelPreload(
    key as keyof typeof FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS,
    "auto",
  )),
]);

/**
 * Authoring/reference assets remain versioned in `public/` for the art
 * pipeline, but the Sites deployment must contain only the bootstrap/runtime
 * variants. Directories are removed recursively from `dist/client`.
 */
export const DEPLOYMENT_SOURCE_ASSET_EXCLUDES: readonly string[] = Object.freeze([
  "models/SharedTextures",
  "models/environment/SharedTexturesKTX2",
  "models/characters/kid.glb",
  "models/characters/kid-lod1.glb",
  "models/characters/villain.glb",
  "models/characters/villain-lod1.glb",
  "models/characters/police.glb",
  "models/environment/themes/campus-kit.glb",
  "models/environment/themes/hospital-kit.glb",
  "models/environment/themes/fire-station-kit.glb",
  "models/environment/themes/factory-kit.glb",
]);

export const MAX_DEPLOYED_CLIENT_BYTES = 22 * 1024 * 1024;
export const RUNTIME_ASSET_MANIFEST_VERSION = 1;
