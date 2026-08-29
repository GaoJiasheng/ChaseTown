export type RuntimePreloadAsset = Readonly<{
  href: string;
  type: string;
  fetchPriority: "high" | "auto";
  /** Budget authority; fetchPriority is only a browser scheduling hint. */
  blocksFirstPlayable: boolean;
}>;

/** One cache-busting authority for every runtime model and KTX2 request. */
export const ASSET_VERSION = "m2-20260829";

export const versionRuntimeAsset = (pathname: string): string => {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}v=${ASSET_VERSION}`;
};

/**
 * Single source of truth for every model that blocks the first campaign's
 * first playable frame. The scene loader imports these exact URLs, while the
 * release manifest derives its preload accounting from the same object.
 */
export const FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS = Object.freeze({
  player: versionRuntimeAsset("/models/characters/kid-bootstrap.glb"),
  threat: versionRuntimeAsset("/models/characters/villain-bootstrap.glb"),
  theme: versionRuntimeAsset("/models/environment/themes/campus-kit-bootstrap.glb"),
  locker: versionRuntimeAsset("/models/environment/locker.glb"),
  cornerMirror: versionRuntimeAsset("/models/environment/stealth-corner-mirrors.glb"),
  frontGate: versionRuntimeAsset("/models/environment/front-gate.glb"),
  exit: versionRuntimeAsset("/models/environment/exit.glb"),
  bench: versionRuntimeAsset("/models/environment/bench.glb"),
  tree: versionRuntimeAsset("/models/environment/tree.glb"),
  shrub: versionRuntimeAsset("/models/environment/shrub.glb"),
  policeCar: versionRuntimeAsset("/models/environment/police-car.glb"),
  basketball: versionRuntimeAsset("/models/environment/basketball.glb"),
  deskChair: versionRuntimeAsset("/models/environment/desk-chair.glb"),
  podium: versionRuntimeAsset("/models/environment/podium.glb"),
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
    href: versionRuntimeAsset("/models/environment/SharedTexturesBootstrapKTX2/26e2227d2c99500cbc061f32e49c34262951dc7bd612158d9194845cf9ddc04b.ktx2"),
    type: "image/ktx2",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  }),
  Object.freeze({
    href: versionRuntimeAsset("/models/environment/SharedTexturesBootstrapKTX2/632b8926fdcb9c69f1b486dc8faa4458677644760d8e19df5399b8fd0db5429b.ktx2"),
    type: "image/ktx2",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  }),
  Object.freeze({
    href: versionRuntimeAsset("/models/environment/SharedTexturesBootstrapKTX2/523513c55c44e4f5907b55a2448d0db2b1ee3739fe6691b9f4d4e6a4a350e95b.ktx2"),
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
