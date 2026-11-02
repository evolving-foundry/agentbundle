import { join } from 'node:path'
import { isFile } from './bundle-paths.ts'
import { isDeepagentsManifest, isDifyManifest, isJiuwenswarmManifest, isPiManifest, type VerifyAgentConfig, verifyBundle } from './verify.ts'
import type { AnyBundleManifest } from './manifest.ts'
import type { BundleInfo } from './protocol.ts'

/**
 * Describe a bundle for consumers (Runner / management UIs): identity, declared
 * resource pointers, model selection, and lockfile presence. Static only — it
 * never installs and never touches the registry. Fails on the standard verify
 * level, so the description always reflects a bundle that would install.
 */
export async function inspectBundle(bundleDir: string): Promise<BundleInfo> {
  const verified = await verifyBundle(bundleDir)
  const manifest: AnyBundleManifest = verified.manifest
  const model: VerifyAgentConfig['model'] = verified.agent.model
  const info = {
    ref: { kind: manifest.kind, uri: bundleDir, digest: verified.digest },
    name: manifest.name,
    schemaVersion: manifest.schemaVersion,
    harnessVersion: manifest.harnessVersion,
    declaredPlugins: declaredPluginsOf(manifest),
    lockfile: await isFile(join(bundleDir, 'dependencies.lock')),
    ...(entryOf(manifest) === undefined ? {} : { entry: entryOf(manifest) }),
    ...(model === undefined ? {} : { model }),
    ...(isPiManifest(manifest)
      ? {
          instructions: manifest.instructions,
          skills: manifest.skills,
          extensions: manifest.extensions.map(extension => extension.declared),
        }
      : {}),
    ...(isJiuwenswarmManifest(manifest)
      ? {
          ...(manifest.skills === undefined ? {} : { skills: manifest.skills }),
          ...(manifest.packages === undefined ? {} : { packages: manifest.packages.map(entry => `${entry.declared}:${entry.kind}`) }),
          ...(manifest.connectors === undefined ? {} : { connectors: manifest.connectors }),
          ...(manifest.templates === undefined ? {} : { templates: manifest.templates }),
          ...(manifest.config === undefined ? {} : { config: manifest.config }),
        }
      : {}),
  }
  return info
}

/** The native entry pointer is declared by dify (workflow DSL) and deepagents (langgraph.json); dsh/hermes/pi carry none. */
function entryOf(manifest: AnyBundleManifest): string | undefined {
  if (isDifyManifest(manifest)) return manifest.entry
  if (isDeepagentsManifest(manifest)) return manifest.entry
  return undefined
}

/** Plugin paths are declared on dsh / hermes / deepagents manifests only; pi declares its own resource pointers. */
function declaredPluginsOf(manifest: AnyBundleManifest): readonly string[] {
  if (isPiManifest(manifest) || isJiuwenswarmManifest(manifest)) return []
  return manifest.declaredPlugins
}
