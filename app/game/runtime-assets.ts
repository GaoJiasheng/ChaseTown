export type RuntimePreloadAsset = Readonly<{
  href: string;
  type: string;
  fetchPriority: "high" | "auto";
}>;

/**
 * The first campaign is deterministic, so these requests can start from the
 * server-rendered head instead of waiting for React hydration and WebGL setup.
 * Query strings intentionally match the runtime URLs so the browser cache can
 * satisfy the controlled scene loader without a second transfer.
 */
export const FIRST_CAMPAIGN_PRELOAD_ASSETS: readonly RuntimePreloadAsset[] = Object.freeze([
  Object.freeze({
    href: "/models/characters/kid-bootstrap.glb?v=1",
    type: "model/gltf-binary",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/models/characters/villain-bootstrap.glb?v=1",
    type: "model/gltf-binary",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/models/environment/themes/campus-kit-bootstrap.glb?v=1",
    type: "model/gltf-binary",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/basis/basis_transcoder.wasm",
    type: "application/wasm",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/basis/basis_transcoder.js",
    type: "text/javascript",
    fetchPriority: "auto",
  }),
  Object.freeze({
    href: "/models/environment/SharedTexturesBootstrapKTX2/52296b1fc01087fabbba71997e3cc29996529b103d6ba6ba6c0814393477ae91.ktx2",
    type: "image/ktx2",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/models/environment/SharedTexturesBootstrapKTX2/9bf9934adeb5f6152f6ab96e9450405775db96d7f279044840c01cd5da8328d9.ktx2",
    type: "image/ktx2",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/models/environment/SharedTexturesBootstrapKTX2/9c68b4a0471dc9847d6de259c5d33970cb07a949acdb6c807d3b8784801a6b8a.ktx2",
    type: "image/ktx2",
    fetchPriority: "auto",
  }),
  Object.freeze({
    href: "/models/environment/locker.glb?v=31",
    type: "model/gltf-binary",
    fetchPriority: "high",
  }),
  Object.freeze({
    href: "/models/environment/front-gate.glb?v=4",
    type: "model/gltf-binary",
    fetchPriority: "auto",
  }),
  Object.freeze({
    href: "/models/environment/exit.glb?v=4",
    type: "model/gltf-binary",
    fetchPriority: "auto",
  }),
  // Level one renders seven authored collision props before controls unlock.
  // Starting them here prevents a second fetch wave after the client chunk
  // discovers the level's movement-blocker contract.
  ...[
    "bench",
    "tree",
    "shrub",
    "police-car",
    "basketball",
    "desk-chair",
    "podium",
  ].map((name) => Object.freeze({
    href: `/models/environment/${name}.glb?v=4`,
    type: "model/gltf-binary",
    fetchPriority: "auto" as const,
  })),
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
