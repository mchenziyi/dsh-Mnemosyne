export const REQUIRED_CANARY_TARBALL_FILES: readonly [
  'package/package.json',
  'package/README.md',
  'package/cordis.patch.yml',
  'package/dist/index.mjs',
  'package/dist/index.d.mts',
]

export interface VerifiedCanaryArtifact {
  packageName: 'dsh-mnemosyne'
  packageVersion: '0.0.0-dev' | '0.1.0'
  packageSha256: string
  realTarballPath: string
}

export function verifyCanaryArtifact(tarballPath: string): Promise<VerifiedCanaryArtifact>
