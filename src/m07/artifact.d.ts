export const REQUIRED_CANARY_TARBALL_FILES: readonly [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/cordis.patch.yml',
  'package/dist/index.mjs',
  'package/dist/index.d.mts',
  'package/dist/index.cjs',
 'package/dist/index.d.cts',
  'package/dist/client.mjs',
  'package/dist/client.d.mts',
  'package/dist/client.cjs',
  'package/dist/client.d.cts',
  'package/dist/typert.remote-client.mjs',
  'package/dist/typert.remote-client.d.mts',
  'package/dist/typert.remote-client.cjs',
  'package/dist/typert.remote-client.d.cts',
  'package/dist/rolldown-runtime.cjs',
]

export interface VerifiedCanaryArtifact {
  packageName: '@cziyi/dsh-mnemosyne'
  packageVersion: '0.0.0-dev' | '0.1.0' | '0.2.0' | '0.2.1' | '0.2.2' | '0.2.3' | '0.2.4' | '0.2.5' | '0.2.6' | '0.2.7' | '0.2.8' | '0.2.9' | '0.2.10' | '0.2.11' | '0.2.12' | '0.2.13' | '0.2.14' | '0.2.15' | '0.2.16' | '0.2.17' | '0.2.18' | '0.2.19' | '0.2.20'
  packageSha256: string
  realTarballPath: string
}

export function verifyCanaryArtifact(tarballPath: string): Promise<VerifiedCanaryArtifact>
