export const REQUIRED_CANARY_TARBALL_FILES: readonly [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/cordis.patch.yml',
  'package/dist/index.mjs',
  'package/dist/index.d.mts',
  'package/dist/index.cjs',
  'package/dist/index.d.cts',
]

export interface VerifiedCanaryArtifact {
  packageName: '@cziyi/dsh-mnemosyne'
  packageVersion: '0.0.0-dev' | '0.1.0' | '0.2.0' | '0.2.1' | '0.2.2' | '0.2.3' | '0.2.4' | '0.2.5' | '0.2.6' | '0.2.7' | '0.2.8' | '0.2.9'
  packageSha256: string
  realTarballPath: string
}

export function verifyCanaryArtifact(tarballPath: string): Promise<VerifiedCanaryArtifact>
