import { execFileSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import commonjs from "@rollup/plugin-commonjs";
import { rollup } from "@rollup/wasm-node";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const cliDirectory = resolve(repositoryRoot, "packages/cli");
const cliBuildDirectory = resolve(cliDirectory, ".build");
const cliOutputDirectory = resolve(cliDirectory, "dist");
const cliRequire = createRequire(resolve(cliDirectory, "package.json"));
const coreRequire = createRequire(resolve(repositoryRoot, "packages/core/package.json"));

await rm(cliBuildDirectory, { recursive: true, force: true });
await rm(cliOutputDirectory, { recursive: true, force: true });
await mkdir(cliOutputDirectory, { recursive: true });

execFileSync(process.execPath, [
  cliRequire.resolve("typescript/bin/tsc"),
  "-p",
  resolve(cliDirectory, "tsconfig.build.json"),
], { cwd: cliDirectory, stdio: "inherit" });

const runtimeModules = new Map([
  ["agent-bundle-core", resolve(repositoryRoot, "packages/core/dist/index.js")],
  ["commander", cliRequire.resolve("commander")],
  ["yaml", coreRequire.resolve("yaml")],
]);

const bundle = await rollup({
  input: resolve(cliBuildDirectory, "bin.js"),
  plugins: [
    commonjs(),
    {
      name: "agent-bundle-workspace-resolver",
      resolveId(source) {
        if (isBuiltin(source)) {
          return { id: source, external: true };
        }
        return runtimeModules.get(source) ?? null;
      },
    },
  ],
});

const cliOutputFile = resolve(cliOutputDirectory, "bin.mjs");

try {
  await bundle.write({
    file: cliOutputFile,
    format: "es",
  });
  // The shebang entry must stay executable; rollup's write does not preserve the mode.
  await chmod(cliOutputFile, 0o755);
} finally {
  await bundle.close();
  await rm(cliBuildDirectory, { recursive: true, force: true });
}
