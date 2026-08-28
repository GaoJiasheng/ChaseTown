#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const modulePath = args.get("--validator-module");
const file = args.get("--file");
const resourceRoot = args.get("--resource-root");
const allowedRoot = args.get("--allowed-root") ?? resourceRoot;
if (!modulePath || !file || !resourceRoot || !allowedRoot) {
  throw new Error("Required: --validator-module FILE --file GLB --resource-root DIR [--allowed-root DIR]");
}

const validator = await import(pathToFileURL(path.resolve(modulePath)).href);
const bytes = new Uint8Array(fs.readFileSync(file));
const report = await validator.validateBytes(bytes, {
  uri: path.basename(file),
  externalResourceFunction: async (uri) => {
    const normalized = path.normalize(uri);
    const resolved = path.resolve(resourceRoot, normalized);
    const root = `${path.resolve(allowedRoot)}${path.sep}`;
    if (!resolved.startsWith(root)) throw new Error(`External resource escapes its root: ${uri}`);
    return new Uint8Array(fs.readFileSync(resolved));
  },
});
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.issues.numErrors > 0 ? 1 : 0;
