import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  "web-dir": { type: "string" },
  "check-only": { type: "boolean", default: false },
} });
if (!values["web-dir"]) throw new Error("--web-dir is required");
const webRoot = fs.realpathSync(values["web-dir"]);
if (!fs.existsSync(path.join(webRoot, "server.js"))) throw new Error("Standalone server entry is missing");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const rootResolver = createRequire(path.join(repoRoot, "package.json"));
const copied = new Map();

function copyRuntimePackage(name, resolver) {
  const packageFile = fs.realpathSync(resolver.resolve(`${name}/package.json`));
  const metadata = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (metadata.name !== name) throw new Error(`Unexpected package identity: ${name}`);
  if (copied.has(name)) {
    if (copied.get(name) !== metadata.version) throw new Error(`Conflicting runtime versions: ${name}`);
    return;
  }
  copied.set(name, metadata.version);
  const source = path.dirname(packageFile);
  const destination = path.join(webRoot, "node_modules", name);
  if (fs.existsSync(destination)) {
    const relative = path.relative(webRoot, fs.realpathSync(destination));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`External package link: ${name}`);
    const current = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"));
    if (current.version !== metadata.version) throw new Error(`Conflicting packaged version: ${name}`);
  }
  fs.cpSync(source, destination, {
    recursive: true, dereference: true,
    filter: (entry) => !path.relative(source, entry).split(path.sep).includes("node_modules"),
  });
  const packageResolver = createRequire(packageFile);
  for (const dependency of Object.keys(metadata.dependencies ?? {})) copyRuntimePackage(dependency, packageResolver);
}

// vinext's standalone manifest does not include React peers imported by its
// own unbundled production server. Include the installed, lockfile-pinned peers
// and their runtime dependencies (including react-dom's scheduler).
if (!values["check-only"]) {
  for (const name of ["react", "react-dom"]) copyRuntimePackage(name, rootResolver);
}
const runtimeResolver = createRequire(path.join(webRoot, "node_modules", "vinext", "dist", "server", "app-render-dependency.js"));
for (const specifier of ["react", "react/jsx-runtime", "react-dom/server", "scheduler"]) {
  const resolved = fs.realpathSync(runtimeResolver.resolve(specifier));
  const relative = path.relative(webRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Runtime dependency escapes the installation: ${specifier} -> ${resolved}`);
  }
}
await import(pathToFileURL(path.join(webRoot, "node_modules", "vinext", "dist", "server", "prod-server.js")));
console.log(`Standalone runtime dependencies verified inside ${webRoot}`);
