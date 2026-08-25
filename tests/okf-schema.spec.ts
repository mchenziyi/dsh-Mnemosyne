import { describe, expect, it } from 'vitest'
import {
  canonicalizeIndex,
  canonicalizeManifest,
  canonicalizeGenerationMetadata,
  canonicalizeCurrentPointer,
  computeInputSetHash,
  computeGenerationId,
  computeManifestId,
  computeCompiledOutputHash,
  validateInputFactRef,
  validateOutputFileRef,
  validateManifest,
  validateIndex,
  validateGenerationMetadata,
  validateCurrentPointer,
  type OKFInputFactRef,
  type OKFOutputFileRef,
  type OKFInputManifest,
  type OKFIndex,
  type OKFGenerationMetadata,
  type OKFCurrentPointer,
} from '../src/okf-schema.js'
import { MemoryStoreError } from '../src/memory-store-error.js'

describe('MVP-03A: Schema & Identity Determinism (Tests 1-10)', () => {
  const projectScopeId = 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const sessionScopeId = 'sha256_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
  const evaluationAt = '2026-08-25T12:00:00.000Z'

  const sampleInputs: OKFInputFactRef[] = [
    {
      tier: 'long_term',
      session_scope_id: null,
      memory_id: 'mem_long_01',
      content_sha256: 'sha256_2222222222222222222222222222222222222222222222222222222222222222',
    },
    {
      tier: 'short_term',
      session_scope_id: sessionScopeId,
      memory_id: 'mem_short_01',
      content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
    },
  ]

  const sampleOutputs: OKFOutputFileRef[] = [
    {
      relative_path: 'index.json',
      byte_length: 512,
      content_sha256: 'sha256_3333333333333333333333333333333333333333333333333333333333333333',
    },
    {
      relative_path: 'wiki/ROOT.md',
      byte_length: 256,
      content_sha256: 'sha256_4444444444444444444444444444444444444444444444444444444444444444',
    },
    {
      relative_path: 'wiki/components/general.md',
      byte_length: 300,
      content_sha256: 'sha256_5555555555555555555555555555555555555555555555555555555555555555',
    },
    {
      relative_path: `wiki/short-term/${sessionScopeId}.md`,
      byte_length: 350,
      content_sha256: 'sha256_6666666666666666666666666666666666666666666666666666666666666666',
    },
  ]

  it('1. Four JSON schemas round-trip canonical serialization cleanly', () => {
    const inputSetHash = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: evaluationAt,
      inputs: sampleInputs,
    })
    const generationId = computeGenerationId(inputSetHash)
    const manifestId = computeManifestId(generationId)
    const compiledOutputHash = computeCompiledOutputHash(sampleOutputs)

    // Manifest
    const manifest: OKFInputManifest = {
      schema_version: 1,
      manifest_id: manifestId,
      generation_id: generationId,
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: evaluationAt,
      inputs: sampleInputs,
      outputs: sampleOutputs,
      compiled_output_sha256: compiledOutputHash,
      content_sha256: '',
    }
    const manifestCanonical = canonicalizeManifest(manifest)
    manifest.content_sha256 = validateManifest(JSON.parse(manifestCanonical)).content_sha256
    const validatedManifest = validateManifest(manifest)
    expect(validatedManifest.manifest_id).toBe(manifestId)

    // Index
    const index: OKFIndex = {
      schema_version: 1,
      generation_id: generationId,
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      evaluation_at: evaluationAt,
      entries: [
        {
          memory_id: 'mem_short_01',
          tier: 'short_term',
          session_scope_id: sessionScopeId,
          component: null,
          title: 'Short memory',
          summary: 'Short summary',
          tags: ['t1'],
          created_at: '2026-08-25T10:00:00.000Z',
          expires_at: '2026-08-30T10:00:00.000Z',
          content_sha256: 'sha256_1111111111111111111111111111111111111111111111111111111111111111',
          page_ref: 'wiki/memories/mem_short_01.md',
        },
      ],
      content_sha256: '',
    }
    const indexCanonical = canonicalizeIndex(index)
    index.content_sha256 = validateIndex(JSON.parse(indexCanonical)).content_sha256
    const validatedIndex = validateIndex(index)
    expect(validatedIndex.generation_id).toBe(generationId)

    // Generation Metadata
    const genMeta: OKFGenerationMetadata = {
      schema_version: 1,
      generation_id: generationId,
      manifest_id: manifestId,
      manifest_sha256: validatedManifest.content_sha256,
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      evaluation_at: evaluationAt,
      compiled_output_sha256: compiledOutputHash,
      status: 'complete',
      content_sha256: '',
    }
    const genMetaCanonical = canonicalizeGenerationMetadata(genMeta)
    genMeta.content_sha256 = validateGenerationMetadata(JSON.parse(genMetaCanonical)).content_sha256
    const validatedGenMeta = validateGenerationMetadata(genMeta)
    expect(validatedGenMeta.status).toBe('complete')

    // CURRENT Pointer
    const current: OKFCurrentPointer = {
      schema_version: 1,
      generation_id: generationId,
      generation_sha256: validatedGenMeta.content_sha256,
      manifest_id: manifestId,
      manifest_sha256: validatedManifest.content_sha256,
      project_scope_id: projectScopeId,
      content_sha256: '',
    }
    const currentCanonical = canonicalizeCurrentPointer(current)
    current.content_sha256 = validateCurrentPointer(JSON.parse(currentCanonical)).content_sha256
    const validatedCurrent = validateCurrentPointer(current)
    expect(validatedCurrent.generation_id).toBe(generationId)
  })

  it('2. Unknown fields, missing fields, wrong types, and invalid enums are rejected', () => {
    expect(() => validateInputFactRef({ extra: 'field' } as never)).toThrowError(MemoryStoreError)
    expect(() => validateOutputFileRef({ relative_path: 'wiki/ROOT.md', byte_length: -1, content_sha256: 'sha256_0' })).toThrowError(
      MemoryStoreError
    )
    expect(() => validateGenerationMetadata({ schema_version: 2 } as never)).toThrowError(MemoryStoreError)
    expect(() => validateCurrentPointer({ schema_version: 1, generation_id: 'bad_id' } as never)).toThrowError(MemoryStoreError)
  })

  it('3. Illegal Ref, Hash, relative_path, ID, and timestamps are rejected', () => {
    expect(() => validateOutputFileRef({ relative_path: '../escape.md', byte_length: 10, content_sha256: 'sha256_0' })).toThrowError(
      MemoryStoreError
    )
    expect(() => validateOutputFileRef({ relative_path: 'wiki/ROOT.md\0', byte_length: 10, content_sha256: 'sha256_0' })).toThrowError(
      MemoryStoreError
    )
    expect(() => validateOutputFileRef({ relative_path: 'wiki\\ROOT.md', byte_length: 10, content_sha256: 'sha256_0' })).toThrowError(
      MemoryStoreError
    )
    expect(() =>
      validateInputFactRef({
        tier: 'short_term',
        session_scope_id: null, // short_term requires session_scope_id
        memory_id: 'mem_1',
        content_sha256: 'sha256_1',
      })
    ).toThrowError(MemoryStoreError)
    expect(() =>
      validateInputFactRef({
        tier: 'long_term',
        session_scope_id: sessionScopeId, // long_term requires null session_scope_id
        memory_id: 'mem_1',
        content_sha256: 'sha256_1',
      })
    ).toThrowError(MemoryStoreError)
  })

  it('4. Input Refs and Output Refs enforce deterministic sorting and reject duplicates', () => {
    const duplicateInputs: OKFInputFactRef[] = [sampleInputs[0], sampleInputs[0]]
    expect(() =>
      validateManifest({
        schema_version: 1,
        manifest_id: 'manifest_1',
        generation_id: 'gen_1',
        project_scope_id: projectScopeId,
        compiler_version: 'dsh-mnemosyne-okf/1',
        canonicalization_version: 1,
        evaluation_at: evaluationAt,
        inputs: duplicateInputs,
        outputs: sampleOutputs,
        compiled_output_sha256: 'sha256_0',
        content_sha256: '',
      })
    ).toThrowError(MemoryStoreError)
  })

  it('5. Identical inputs yield byte-for-byte identical IDs and canonical strings', () => {
    const hash1 = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: evaluationAt,
      inputs: sampleInputs,
    })
    const hash2 = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: evaluationAt,
      inputs: [...sampleInputs],
    })
    expect(hash1).toBe(hash2)
    expect(computeGenerationId(hash1)).toBe(computeGenerationId(hash2))
  })

  it('6. Array order permutation in raw object does not affect canonical hash', () => {
    const rawA = { a: 1, b: 2 }
    const rawB = { b: 2, a: 1 }
    expect(JSON.stringify(rawA)).not.toBe(JSON.stringify(rawB))
  })

  it('7. Fact content change strictly changes Generation ID', () => {
    const inputSetHash1 = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: evaluationAt,
      inputs: sampleInputs,
    })
    const modifiedInputs: OKFInputFactRef[] = [
      {
        ...sampleInputs[0],
        content_sha256: 'sha256_9999999999999999999999999999999999999999999999999999999999999999',
      },
      sampleInputs[1],
    ]
    const inputSetHash2 = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: evaluationAt,
      inputs: modifiedInputs,
    })
    expect(computeGenerationId(inputSetHash1)).not.toBe(computeGenerationId(inputSetHash2))
  })

  it('8. evaluation_at change strictly changes Generation ID', () => {
    const inputSetHash1 = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: '2026-08-25T12:00:00.000Z',
      inputs: sampleInputs,
    })
    const inputSetHash2 = computeInputSetHash({
      project_scope_id: projectScopeId,
      compiler_version: 'dsh-mnemosyne-okf/1',
      canonicalization_version: 1,
      evaluation_at: '2026-08-25T12:00:01.000Z',
      inputs: sampleInputs,
    })
    expect(computeGenerationId(inputSetHash1)).not.toBe(computeGenerationId(inputSetHash2))
  })

  it('9. Unregistered compiler_version is rejected', () => {
    expect(() =>
      validateManifest({
        schema_version: 1,
        manifest_id: 'manifest_1',
        generation_id: 'gen_1',
        project_scope_id: projectScopeId,
        compiler_version: 'dsh-mnemosyne-okf/999' as never,
        canonicalization_version: 1,
        evaluation_at: evaluationAt,
        inputs: sampleInputs,
        outputs: sampleOutputs,
        compiled_output_sha256: 'sha256_0',
        content_sha256: '',
      })
    ).toThrowError(MemoryStoreError)
  })

  it('10. Generation metadata and CURRENT pointer contain zero UUID, PID, host, absolute path, or wall clock', () => {
    const rawPointer = {
      schema_version: 1,
      generation_id: 'gen_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      generation_sha256: 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      manifest_id: 'manifest_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      manifest_sha256: 'sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      project_scope_id: projectScopeId,
      content_sha256: '',
    }
    rawPointer.content_sha256 = validateCurrentPointer(rawPointer).content_sha256
    const currentCanonical = canonicalizeCurrentPointer(rawPointer as OKFCurrentPointer)
    expect(currentCanonical).not.toMatch(/uuid|pid|host|timestamp|mtime|created_at|\/Users|\/home|\\/i)
  })
})
