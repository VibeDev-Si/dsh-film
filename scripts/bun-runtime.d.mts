/** The official Bun runtime selected for a supported Node platform and architecture. */
export function bunRuntimeFor(platform: string, architecture: string): { packageName: string; executable: string }
/** The executable resolved from Film's own installation, or undefined in a checkout without its optional dependency. */
export function installedBunRuntime(packageDirectory: string, platform?: string, architecture?: string): string | undefined
