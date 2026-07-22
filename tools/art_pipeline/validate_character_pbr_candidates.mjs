#!/usr/bin/env node
/**
 * Read-only contract audit for post-processed character PBR candidates.
 *
 * The validator deliberately compares semantic accessor payloads rather than
 * GLB byte offsets: Blender may repack bufferViews while preserving every
 * animation sample.  It writes a JSON report before returning a failing exit
 * code, so regressions remain inspectable in CI and local art reviews.
 *
 * Usage:
 *   node tools/art_pipeline/validate_character_pbr_candidates.mjs \
 *     --official-dir public/models/characters \
 *     --candidate-dir /tmp/chasing-character-pbr \
 *     --output /tmp/chasing-character-pbr/candidate_contract_audit.json
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_INFO = {
  5120: { bytes: 1, read: (buffer, offset) => buffer.readInt8(offset) },
  5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset) },
  5122: { bytes: 2, read: (buffer, offset) => buffer.readInt16LE(offset) },
  5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset) },
  5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset) },
  5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) },
};
const WEB_BUDGET_BYTES = 12 * 1024 * 1024;

const CONTRACTS = {
  kid: {
    clips: ["Idle", "Walk", "Run", "TurnLeft", "TurnRight", "HideEnter", "HideIdle", "HidePeek", "HideExit", "Caught", "EscapeCelebrate", "Interact"],
    minimumDuration: { Caught: 0.8, TurnLeft: 0.55, TurnRight: 0.55, HideEnter: 1, HideIdle: 1.5, HidePeek: 0.8, HideExit: 0.8 },
    pbrMaterials: ["M_Kid_PrecisionRemodel_v21_URP"],
  },
  villain: {
    clips: ["Idle", "PatrolWalk", "Run", "Alert", "LostSight", "Search", "CheckHide", "Catch"],
    minimumDuration: { Alert: 0.35, LostSight: 1, Search: 1, CheckHide: 1.5, Catch: 0.7 },
    pbrMaterials: ["M_Villain_PrecisionRemodel_v21_URP"],
  },
  police: {
    clips: ["Idle", "Run", "Alert", "Interact", "Resolve"],
    minimumDuration: { Resolve: 0.7 },
    pbrMaterials: ["M_Police_v22_SkinUV", "M_Police_v22_UniformNavy", "M_Police_v22_TrouserNavy"],
  },
};

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ["official-dir", "candidate-dir", "output"]) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  return values;
}

function parseGlb(buffer, filename) {
  const issues = [];
  if (buffer.length < 20 || buffer.subarray(0, 4).toString("ascii") !== "glTF") {
    throw new Error(`${filename}: not a GLB`);
  }
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  if (version !== 2) issues.push(`GLB version is ${version}, expected 2`);
  if (declaredLength !== buffer.length) issues.push(`declared length ${declaredLength} != file bytes ${buffer.length}`);
  let json;
  let binary;
  const chunkTypes = [];
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > buffer.length) {
      issues.push(`chunk at ${offset} exceeds file length`);
      break;
    }
    const content = buffer.subarray(offset + 8, end);
    chunkTypes.push(`0x${type.toString(16).padStart(8, "0")}`);
    if (type === 0x4e4f534a) json = JSON.parse(content.toString("utf8").replace(/[\u0000 ]+$/u, ""));
    if (type === 0x004e4942) binary = content;
    offset = end;
  }
  if (!json) throw new Error(`${filename}: missing JSON chunk`);
  if (!binary) throw new Error(`${filename}: missing BIN chunk`);
  if ((json.buffers ?? []).length !== 1) issues.push(`expected one embedded buffer, found ${(json.buffers ?? []).length}`);
  const externalUris = [
    ...(json.buffers ?? []).flatMap((item, index) => item.uri ? [`buffer[${index}]=${item.uri}`] : []),
    ...(json.images ?? []).flatMap((item, index) => item.uri ? [`image[${index}]=${item.uri}`] : []),
  ];
  if (externalUris.length) issues.push(`external URIs: ${externalUris.join(", ")}`);
  return { filename, buffer, json, binary, version, declaredLength, chunkTypes, issues };
}

function accessorValues(asset, accessorIndex) {
  const accessor = asset.json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`${asset.filename}: missing accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error(`${asset.filename}: sparse accessor ${accessorIndex} is outside this production contract`);
  const view = asset.json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`${asset.filename}: accessor ${accessorIndex} has no bufferView`);
  const info = COMPONENT_INFO[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  if (!info || !components) throw new Error(`${asset.filename}: unsupported accessor format ${accessor.componentType}/${accessor.type}`);
  const stride = view.byteStride ?? info.bytes * components;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Array(accessor.count * components);
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < components; component += 1) {
      values[item * components + component] = info.read(asset.binary, start + item * stride + component * info.bytes);
    }
  }
  return { accessor, components, values };
}

function canonicalPayload(accessorData) {
  const { accessor, values } = accessorData;
  const info = COMPONENT_INFO[accessor.componentType];
  const output = Buffer.alloc(values.length * info.bytes);
  values.forEach((value, index) => {
    const offset = index * info.bytes;
    switch (accessor.componentType) {
      case 5120: output.writeInt8(value, offset); break;
      case 5121: output.writeUInt8(value, offset); break;
      case 5122: output.writeInt16LE(value, offset); break;
      case 5123: output.writeUInt16LE(value, offset); break;
      case 5125: output.writeUInt32LE(value, offset); break;
      case 5126: output.writeFloatLE(value, offset); break;
      default: throw new Error(`Unsupported component type ${accessor.componentType}`);
    }
  });
  return output;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function payloadSummary(asset, accessorIndex) {
  const data = accessorValues(asset, accessorIndex);
  const payload = canonicalPayload(data);
  return {
    type: data.accessor.type,
    componentType: data.accessor.componentType,
    count: data.accessor.count,
    values: data.values,
    sha256: sha256(payload),
  };
}

function channelIdentity(asset, channel, sampler) {
  const node = asset.json.nodes?.[channel.target.node];
  return `${node?.name ?? `#${channel.target.node}`}|${channel.target.path}|${sampler.interpolation ?? "LINEAR"}`;
}

function clipSemantic(asset, animation) {
  const channels = animation.channels.map((channel) => {
    const sampler = animation.samplers[channel.sampler];
    const input = payloadSummary(asset, sampler.input);
    const output = payloadSummary(asset, sampler.output);
    return {
      identity: channelIdentity(asset, channel, sampler),
      targetNode: asset.json.nodes?.[channel.target.node]?.name ?? null,
      path: channel.target.path,
      interpolation: sampler.interpolation ?? "LINEAR",
      input,
      output,
    };
  }).sort((a, b) => a.identity.localeCompare(b.identity));
  const duplicateIdentities = channels
    .map((channel) => channel.identity)
    .filter((identity, index, all) => all.indexOf(identity) !== index);
  const duration = Math.max(0, ...channels.flatMap((channel) => channel.input.values));
  let rotationTargets = 0;
  let totalRotationRange = 0;
  for (const channel of channels) {
    if (channel.path !== "rotation") continue;
    rotationTargets += 1;
    const components = COMPONENTS[channel.output.type];
    for (let component = 0; component < components; component += 1) {
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (let index = component; index < channel.output.values.length; index += components) {
        minimum = Math.min(minimum, channel.output.values[index]);
        maximum = Math.max(maximum, channel.output.values[index]);
      }
      totalRotationRange += maximum - minimum;
    }
  }
  return { name: animation.name, duration, rotationTargets, totalRotationRange, duplicateIdentities, channels };
}

function compareNumberArrays(left, right) {
  if (left.length !== right.length) return { sameLength: false, exact: false, maxAbsDelta: null, differingValues: null };
  let exact = true;
  let maxAbsDelta = 0;
  let differingValues = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) {
      exact = false;
      differingValues += 1;
    }
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(left[index] - right[index]));
  }
  return { sameLength: true, exact, maxAbsDelta, differingValues };
}

function compareAnimations(officialAsset, candidateAsset, contract) {
  const contractFailures = [];
  const strictDifferences = [];
  const official = new Map((officialAsset.json.animations ?? []).map((animation) => [animation.name, clipSemantic(officialAsset, animation)]));
  const candidate = new Map((candidateAsset.json.animations ?? []).map((animation) => [animation.name, clipSemantic(candidateAsset, animation)]));
  const officialNames = [...official.keys()].sort();
  const candidateNames = [...candidate.keys()].sort();
  const expectedNames = [...contract.clips].sort();
  if (JSON.stringify(candidateNames) !== JSON.stringify(expectedNames)) contractFailures.push(`candidate clip set ${candidateNames} != contract ${expectedNames}`);
  if (JSON.stringify(candidateNames) !== JSON.stringify(officialNames)) strictDifferences.push(`candidate clip set ${candidateNames} != official ${officialNames}`);
  const clips = {};
  for (const name of [...new Set([...officialNames, ...candidateNames])].sort()) {
    const left = official.get(name);
    const right = candidate.get(name);
    if (right) {
      if (right.duplicateIdentities.length) contractFailures.push(`${name}: duplicate candidate channel identities ${right.duplicateIdentities}`);
      const minimum = contract.minimumDuration[name] ?? 0.3;
      if (right.duration < minimum) contractFailures.push(`${name}: duration ${right.duration}s < ${minimum}s`);
      if (right.rotationTargets < 20) contractFailures.push(`${name}: only ${right.rotationTargets} rotation targets`);
      if (!(right.totalRotationRange > 0.035)) contractFailures.push(`${name}: total rotation range ${right.totalRotationRange} is static`);
    }
    if (!left || !right) {
      clips[name] = {
        presentInOfficial: Boolean(left),
        presentInCandidate: Boolean(right),
        candidateDuration: right?.duration ?? null,
        rotationTargets: right?.rotationTargets ?? null,
        totalRotationRange: right?.totalRotationRange ?? null,
        exactSemanticMatch: false,
      };
      continue;
    }
    const structureMatch = left.channels.length === right.channels.length
      && left.channels.every((channel, index) => channel.identity === right.channels[index]?.identity
        && channel.input.type === right.channels[index].input.type
        && channel.input.componentType === right.channels[index].input.componentType
        && channel.input.count === right.channels[index].input.count
        && channel.output.type === right.channels[index].output.type
        && channel.output.componentType === right.channels[index].output.componentType
        && channel.output.count === right.channels[index].output.count);
    const channelComparisons = [];
    for (let index = 0; index < Math.max(left.channels.length, right.channels.length); index += 1) {
      const leftChannel = left.channels[index];
      const rightChannel = right.channels[index];
      if (!leftChannel || !rightChannel || leftChannel.identity !== rightChannel.identity) {
        channelComparisons.push({
          officialIdentity: leftChannel?.identity ?? null,
          candidateIdentity: rightChannel?.identity ?? null,
          structureMatch: false,
        });
        continue;
      }
      const inputComparison = compareNumberArrays(leftChannel.input.values, rightChannel.input.values);
      const outputComparison = compareNumberArrays(leftChannel.output.values, rightChannel.output.values);
      channelComparisons.push({
        identity: leftChannel.identity,
        structureMatch: true,
        input: { ...inputComparison, officialSha256: leftChannel.input.sha256, candidateSha256: rightChannel.input.sha256 },
        output: { ...outputComparison, officialSha256: leftChannel.output.sha256, candidateSha256: rightChannel.output.sha256 },
      });
    }
    const exactSemanticMatch = structureMatch && channelComparisons.every((item) => item.input?.exact && item.output?.exact);
    const maximumOutputDelta = Math.max(0, ...channelComparisons.map((item) => item.output?.maxAbsDelta ?? 0));
    const maximumInputDelta = Math.max(0, ...channelComparisons.map((item) => item.input?.maxAbsDelta ?? 0));
    if (!exactSemanticMatch) strictDifferences.push(`${name}: animation Float32 semantic signature differs (input max delta ${maximumInputDelta}, output max delta ${maximumOutputDelta})`);
    const differingInputValues = channelComparisons.reduce((total, item) => total + (item.input?.differingValues ?? 0), 0);
    const differingOutputValues = channelComparisons.reduce((total, item) => total + (item.output?.differingValues ?? 0), 0);
    clips[name] = {
      officialDuration: left.duration,
      candidateDuration: right.duration,
      durationExact: Object.is(left.duration, right.duration),
      officialChannels: left.channels.length,
      candidateChannels: right.channels.length,
      rotationTargets: right.rotationTargets,
      totalRotationRange: right.totalRotationRange,
      structureMatch,
      exactSemanticMatch,
      maximumInputDelta,
      maximumOutputDelta,
      differingInputValues,
      differingOutputValues,
      differingChannels: channelComparisons.filter((item) => !(item.input?.exact && item.output?.exact)),
    };
  }
  return {
    officialNames,
    candidateNames,
    expectedNames,
    exactAnimationSetMatch: JSON.stringify(candidateNames) === JSON.stringify(officialNames),
    exactAllFloatPayloadsMatch: Object.values(clips).every((clip) => clip.exactSemanticMatch),
    clips,
    passedProductionAnimationContract: contractFailures.length === 0,
    contractFailures,
    strictDifferences,
  };
}

function skinSignature(asset) {
  return (asset.json.skins ?? []).map((skin) => ({
    name: skin.name ?? null,
    skeleton: skin.skeleton == null ? null : asset.json.nodes?.[skin.skeleton]?.name ?? `#${skin.skeleton}`,
    joints: (skin.joints ?? []).map((nodeIndex) => asset.json.nodes?.[nodeIndex]?.name ?? `#${nodeIndex}`),
  }));
}

function geometrySignature(asset) {
  return (asset.json.meshes ?? []).map((mesh, meshIndex) => ({
    name: mesh.name ?? `#${meshIndex}`,
    primitives: mesh.primitives.map((primitive) => ({
      mode: primitive.mode ?? 4,
      material: primitive.material == null ? null : asset.json.materials?.[primitive.material]?.name ?? `#${primitive.material}`,
      positions: primitive.attributes.POSITION == null ? null : asset.json.accessors[primitive.attributes.POSITION].count,
      indices: primitive.indices == null ? null : asset.json.accessors[primitive.indices].count,
      joints: primitive.attributes.JOINTS_0 == null ? null : asset.json.accessors[primitive.attributes.JOINTS_0].count,
      weights: primitive.attributes.WEIGHTS_0 == null ? null : asset.json.accessors[primitive.attributes.WEIGHTS_0].count,
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function surfaceTopologySignature(geometry) {
  return geometry.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((primitive) => ({
      mode: primitive.mode,
      material: primitive.material,
      indices: primitive.indices,
    })),
  }));
}

function pngDimensions(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length >= 24 && buffer.subarray(0, 8).toString("hex") === signature) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }
  return { width: null, height: null, format: "unknown" };
}

function imageEvidence(asset, textureInfo) {
  if (!textureInfo || textureInfo.index == null) return null;
  const texture = asset.json.textures?.[textureInfo.index];
  const imageIndex = texture?.source;
  const image = imageIndex == null ? null : asset.json.images?.[imageIndex];
  const view = image?.bufferView == null ? null : asset.json.bufferViews?.[image.bufferView];
  if (!texture || !image || !view) return { textureIndex: textureInfo.index, embedded: false };
  const start = view.byteOffset ?? 0;
  const payload = asset.binary.subarray(start, start + view.byteLength);
  return {
    textureIndex: textureInfo.index,
    imageIndex,
    name: image.name ?? null,
    mimeType: image.mimeType ?? null,
    embedded: true,
    bytes: payload.length,
    sha256: sha256(payload),
    ...pngDimensions(payload),
  };
}

function pbrEvidence(asset, materialNames) {
  const failures = [];
  const materials = {};
  for (const materialName of materialNames) {
    const material = (asset.json.materials ?? []).find((item) => item.name === materialName);
    if (!material) {
      failures.push(`missing PBR material ${materialName}`);
      materials[materialName] = { found: false };
      continue;
    }
    const slots = {
      baseColor: imageEvidence(asset, material.pbrMetallicRoughness?.baseColorTexture),
      normal: imageEvidence(asset, material.normalTexture),
      occlusion: imageEvidence(asset, material.occlusionTexture),
      metallicRoughness: imageEvidence(asset, material.pbrMetallicRoughness?.metallicRoughnessTexture),
    };
    for (const [slot, evidence] of Object.entries(slots)) {
      if (!evidence?.embedded) failures.push(`${materialName}: ${slot} is not an embedded texture`);
      else if (evidence.bytes < 10_000 || evidence.width < 512 || evidence.height < 512) {
        failures.push(`${materialName}: ${slot} looks like a placeholder (${evidence.bytes} bytes, ${evidence.width}x${evidence.height})`);
      }
    }
    materials[materialName] = { found: true, slots };
  }
  return { materials, failures };
}

function khronosValidation(filename) {
  const args = [
    "--yes",
    "@gltf-transform/cli@4.4.1",
    "validate",
    filename,
    "--format",
    "csv",
    "--limit",
    "100000",
  ];
  const result = spawnSync("npx", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const issues = [];
  for (const line of stdout.split(/\r?\n/u).slice(1)) {
    const match = line.match(/^([^,]+),(.*),([0-3]),(\/.*)$/u);
    if (!match) continue;
    issues.push({ code: match[1], message: match[2], severity: Number(match[3]), pointer: match[4] });
  }
  const severityCounts = Object.fromEntries([0, 1, 2, 3].map((severity) => [severity, issues.filter((issue) => issue.severity === severity).length]));
  return {
    command: ["npx", ...args].join(" "),
    exitCode: result.status,
    signal: result.signal,
    invocationError: result.error?.message ?? null,
    errors: severityCounts[0],
    warnings: severityCounts[1],
    information: severityCounts[2],
    hints: severityCounts[3],
    issues,
    stderr: stderr.trim(),
  };
}

async function auditRole(role, contract, officialDir, candidateDir) {
  const officialPath = path.join(officialDir, `${role}.glb`);
  const candidatePath = path.join(candidateDir, `${role}.glb`);
  const [officialBuffer, candidateBuffer] = await Promise.all([readFile(officialPath), readFile(candidatePath)]);
  const official = parseGlb(officialBuffer, officialPath);
  const candidate = parseGlb(candidateBuffer, candidatePath);
  const animation = compareAnimations(official, candidate, contract);
  const officialSkins = skinSignature(official);
  const candidateSkins = skinSignature(candidate);
  const exactSkinSignatureMatch = JSON.stringify(officialSkins) === JSON.stringify(candidateSkins);
  const officialGeometry = geometrySignature(official);
  const candidateGeometry = geometrySignature(candidate);
  const exactGeometryStructureMatch = JSON.stringify(officialGeometry) === JSON.stringify(candidateGeometry);
  const exactSurfaceTopologyMatch = JSON.stringify(surfaceTopologySignature(officialGeometry))
    === JSON.stringify(surfaceTopologySignature(candidateGeometry));
  const pbr = pbrEvidence(candidate, contract.pbrMaterials);
  const [officialKhronos, candidateKhronos] = [khronosValidation(officialPath), khronosValidation(candidatePath)];
  const contractFailures = [...candidate.issues, ...animation.contractFailures, ...pbr.failures];
  const strictDifferences = [...animation.strictDifferences];
  if (candidateBuffer.length >= WEB_BUDGET_BYTES) contractFailures.push(`candidate is ${candidateBuffer.length} bytes, budget is < ${WEB_BUDGET_BYTES}`);
  if (!exactSkinSignatureMatch) strictDifferences.push("skin joint-name signature differs from official input");
  if (!candidateSkins.length || candidateSkins[0].joints.length !== 21) contractFailures.push(`approved rig requires 21 joints, found ${candidateSkins[0]?.joints.length ?? 0}`);
  if (!exactSurfaceTopologyMatch) contractFailures.push("mesh/index/material surface topology differs from official input");
  if (!exactGeometryStructureMatch) strictDifferences.push("mesh primitive/accessor-count/material structure differs from official input");
  if (candidateKhronos.invocationError) contractFailures.push(`Khronos validator invocation failed: ${candidateKhronos.invocationError}`);
  if (candidateKhronos.errors) contractFailures.push(`Khronos validator found ${candidateKhronos.errors} specification error(s)`);
  return {
    role,
    official: { path: officialPath, bytes: officialBuffer.length, sha256: sha256(officialBuffer), glbIssues: official.issues },
    candidate: {
      path: candidatePath,
      bytes: candidateBuffer.length,
      mebibytes: Number((candidateBuffer.length / 1024 / 1024).toFixed(4)),
      sha256: sha256(candidateBuffer),
      below12MiB: candidateBuffer.length < WEB_BUDGET_BYTES,
      glbVersion: candidate.version,
      chunks: candidate.chunkTypes,
      embeddedOnly: !candidate.issues.some((issue) => issue.startsWith("external URIs")),
      glbStructuralIssues: candidate.issues,
    },
    skin: { exactSignatureMatch: exactSkinSignatureMatch, official: officialSkins, candidate: candidateSkins },
    geometry: {
      exactStructureMatch: exactGeometryStructureMatch,
      exactSurfaceTopologyMatch,
      official: officialGeometry,
      candidate: candidateGeometry,
    },
    animation,
    pbr,
    khronosValidator: { official: officialKhronos, candidate: candidateKhronos },
    passedProductionContract: contractFailures.length === 0,
    passedStrictRoundTripIdentity: contractFailures.length === 0 && strictDifferences.length === 0,
    contractFailures,
    strictDifferences,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const officialDir = path.resolve(args["official-dir"]);
  const candidateDir = path.resolve(args["candidate-dir"]);
  const output = path.resolve(args.output);
  const roles = {};
  for (const [role, contract] of Object.entries(CONTRACTS)) {
    try {
      roles[role] = await auditRole(role, contract, officialDir, candidateDir);
    } catch (error) {
      roles[role] = {
        role,
        passedProductionContract: false,
        passedStrictRoundTripIdentity: false,
        contractFailures: [error.stack ?? String(error)],
        strictDifferences: [],
      };
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    policy: {
      comparison: "semantic accessor payloads after canonical de-interleaving",
      animationRequirement: "exact Float32 equality to official input",
      webBudgetBytesExclusive: WEB_BUDGET_BYTES,
      pbrRequirement: "embedded BaseColor + Normal + Occlusion + MetallicRoughness, >=512px and >=10KB each",
    },
    roles,
    passedProductionContract: Object.values(roles).every((role) => role.passedProductionContract),
    passedStrictRoundTripIdentity: Object.values(roles).every((role) => role.passedStrictRoundTripIdentity),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output,
    passedProductionContract: report.passedProductionContract,
    passedStrictRoundTripIdentity: report.passedStrictRoundTripIdentity,
    roles: Object.fromEntries(Object.entries(roles).map(([role, value]) => [role, {
      passedProductionContract: value.passedProductionContract,
      passedStrictRoundTripIdentity: value.passedStrictRoundTripIdentity,
      contractFailures: value.contractFailures,
      strictDifferences: value.strictDifferences,
    }])),
  }, null, 2));
  if (!report.passedProductionContract) process.exitCode = 1;
}

await main();
