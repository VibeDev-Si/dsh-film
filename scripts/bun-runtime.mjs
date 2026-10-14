import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The official Bun package and executable names for a supported Node target.
 * @param {string} platform - Node's platform name.
 * @param {string} architecture - Node's architecture name.
 * @returns {{ packageName: string, executable: string }} The runtime package installed with Film.
 */
export function bunRuntimeFor(platform, architecture) {
  if (!((platform === 'win32' && architecture === 'x64') || (platform === 'darwin' && (architecture === 'arm64' || architecture === 'x64')))) {
    throw new Error(`Film 不支持 ${platform}-${architecture}；支持 Windows x64、macOS arm64 和 macOS x64`)
  }
  const name = platform === 'win32' ? 'windows' : platform
  const arch = architecture === 'arm64' ? 'aarch64' : architecture
  return { packageName: `@oven/bun-${name}-${arch}`, executable: platform === 'win32' ? 'bun.exe' : 'bun' }
}

/**
 * Resolve Film's optional Bun dependency from the plugin's own installation.
 * @param {string} packageDirectory - The directory containing Film's package.json.
 * @param {string} [platform] - Node's platform name.
 * @param {string} [architecture] - Node's architecture name.
 * @returns {string | undefined} The executable, or undefined when the dependency is absent in a linked checkout.
 */
export function installedBunRuntime(packageDirectory, platform = process.platform, architecture = process.arch) {
  const { packageName, executable } = bunRuntimeFor(platform, architecture)
  try {
    const manifest = createRequire(join(packageDirectory, 'package.json')).resolve(`${packageName}/package.json`)
    return join(dirname(manifest), 'bin', executable)
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
}
