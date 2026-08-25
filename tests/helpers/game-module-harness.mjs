import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

async function gameFiles(root) {
  const directory = path.join(root, "app", "game");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await gameFilesAt(absolute));
    else if (entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files.sort();
}

async function gameFilesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await gameFilesAt(absolute));
    else if (entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

export async function readGameSource(root) {
  const files = [path.join(root, "app", "chasing-game.tsx"), ...await gameFiles(root)];
  return (await Promise.all(files.map((filename) => readFile(filename, "utf8")))).join("\n");
}

export async function loadGameModule(root, label) {
  const sourceRoot = path.join(root, "app", "game");
  const temporaryRoot = await mkdtemp(path.join(root, "tests", `.compiled-${label}-${process.pid}-`));
  try {
    for (const filename of await gameFiles(root)) {
      const relative = path.relative(sourceRoot, filename).replace(/\.ts$/u, ".js");
      const output = path.join(temporaryRoot, relative);
      const source = await readFile(filename, "utf8");
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: filename,
      }).outputText;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, compiled);
    }
    const entry = path.join(temporaryRoot, "index.js");
    return await import(`${pathToFileURL(entry).href}?test=${Date.now()}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
