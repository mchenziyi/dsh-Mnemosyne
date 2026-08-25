import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, compareCodePoints } from './protocol/canonical.js'
import { MemoryStoreError } from './memory-store-error.js'
import { openMemoryFactStore } from './memory-store.js'
import {
  checkPathHierarchy,
  ensureDirectoryChain,
  validateProjectRoot,
  validateScopeId,
} from './memory-store-path.js'
import { computeProjectScopeId } from './runtime-scope.js'
import {
  deriveComponentSlug,
  renderComponentPage,
  renderMemoryPage,
  renderRootPage,
  renderSessionPage,
} from './okf-render.js'
import {
  COMPILER_VERSION,
  buildExpectedIndex,
  canonicalizeGenerationMetadata,
  canonicalizeIndex,
  canonicalizeManifest,
  canonicalizeCurrentPointer,
  compareInputFactRefs,
  compareOutputFileRefs,
  computeCompiledOutputHash,
  computeGenerationId,
  computeInputSetHash,
  computeManifestId,
  validateCompileOKFRequest,
  validateGenerationMetadata,
  validateIndex,
  validateManifest,
  validateCurrentPointer,
  type CompileOKFRequest,
  type CompileOKFResult,
  type OKFCurrentPointer,
  type OKFGenerationMetadata,
  type OKFIndex,
  type OKFIndexEntry,
  type OKFInputFactRef,
  type OKFInputManifest,
  type OKFOutputFileRef,
} from './okf-schema.js'
import {
  acquireCompilerLock,
  getGenerationLayout,
  publishCurrent,
  publishManifest,
  readCurrentPointer,
  readRawCurrentPointerUnverified,
  readStrictFile,
  syncDirectory,
  verifyPublishedGenerationWorld,
  type GenerationStoreHooks,
} from './generation-store.js'
import type { LongTermMemoryFact, ShortTermMemoryFact } from './memory-fact.js'

export interface OKFCompilerHooks extends GenerationStoreHooks {
  onStagingWrite?: () => void | Promise<void>
  onStagingSync?: () => void | Promise<void>
  onStagingClose?: () => void | Promise<void>
  onManifestPublication?: () => void | Promise<void>
  onBeforeCurrentRename?: () => void | Promise<void>
  onPostCurrentRenameFsync?: () => void | Promise<void>
}

export interface OKFCompilerOptions {
  hooks?: OKFCompilerHooks
}

export interface OKFCompiler {
  compile(request: CompileOKFRequest): Promise<CompileOKFResult>
  readCurrent(projectRoot: string, projectScopeId: string): Promise<OKFCurrentPointer | null>
  verifyGeneration(projectRoot: string, generationId: string): Promise<OKFGenerationMetadata>
}

function mapToCompileError(err: unknown): never {
  if (err instanceof MemoryStoreError) {
    if (err.code.startsWith('memory_store_')) {
      const suffix = err.code.slice('memory_store_'.length)
      const compileCode = `memory_compile_${suffix}` as import('./memory-store-error.js').MemoryStoreErrorCode
      throw new MemoryStoreError(compileCode, err.cause ?? err)
    }
    throw err
  }
  throw new MemoryStoreError('memory_compile_io_failed', err)
}

async function durableWriteFile(filePath: string, content: string, hooks?: OKFCompilerHooks): Promise<void> {
  let handle
  let firstError: unknown = null
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    if (hooks?.onStagingWrite) {
      await hooks.onStagingWrite()
    }
    await handle.writeFile(content, 'utf8')
    if (hooks?.onStagingSync) {
      await hooks.onStagingSync()
    }
    await handle.sync()
  } catch (err: unknown) {
    firstError = err
  } finally {
    if (handle) {
      try {
        await handle.close()
        if (hooks?.onStagingClose) {
          await hooks.onStagingClose()
        }
      } catch (closeErr: unknown) {
        if (!firstError) firstError = closeErr
      }
    }
  }

  if (firstError) {
    throw new MemoryStoreError('memory_compile_io_failed', firstError)
  }
}

export function createOKFCompiler(options?: OKFCompilerOptions): OKFCompiler {
  const hooks = options?.hooks
  return {
    async readCurrent(projectRoot: string, projectScopeId: string): Promise<OKFCurrentPointer | null> {
      try {
        const root = await validateProjectRoot(projectRoot)
        const validScopeId = validateScopeId(projectScopeId)
        const expectedScopeId = computeProjectScopeId(root)
        if (validScopeId !== expectedScopeId) {
          throw new MemoryStoreError('memory_compile_invalid_input')
        }
        return await readCurrentPointer(root, validScopeId)
      } catch (err: unknown) {
        mapToCompileError(err)
      }
    },

    async verifyGeneration(projectRoot: string, generationId: string): Promise<OKFGenerationMetadata> {
      try {
        const root = await validateProjectRoot(projectRoot)
        return await verifyPublishedGenerationWorld(root, generationId)
      } catch (err: unknown) {
        mapToCompileError(err)
      }
    },

    async compile(request: CompileOKFRequest): Promise<CompileOKFResult> {
      try {
        const validatedReq = validateCompileOKFRequest(request)
        const root = await validateProjectRoot(validatedReq.project_root)
        const expectedScopeId = computeProjectScopeId(root)
        if (validatedReq.project_scope_id !== expectedScopeId) {
          throw new MemoryStoreError('memory_compile_invalid_input')
        }

        const releaseLock = await acquireCompilerLock(root, hooks)
        let stagingDir: string | null = null

        try {
          const layout = getGenerationLayout(root)
          const oldCurrent = await readRawCurrentPointerUnverified(root, validatedReq.project_scope_id)

          // Snapshot Facts via MemoryFactStore
          const store = openMemoryFactStore({ project_root: root, project_scope_id: validatedReq.project_scope_id })
          const sessionScopes = await store.listShortTermSessionScopes()

          const allShortFacts: ShortTermMemoryFact[] = []
          for (const sessionScope of sessionScopes) {
            const sessionFacts = await store.listShortTerm(sessionScope, validatedReq.evaluation_at)
            allShortFacts.push(...sessionFacts)
          }

          const allLongFacts = await store.listLongTerm()

          // Verify global memory_id uniqueness across all active facts
          const seenMemoryIds = new Set<string>()
          for (const f of allShortFacts) {
            if (seenMemoryIds.has(f.memory_id)) {
              throw new MemoryStoreError('memory_compile_invalid_input')
            }
            seenMemoryIds.add(f.memory_id)
          }
          for (const f of allLongFacts) {
            if (seenMemoryIds.has(f.memory_id)) {
              throw new MemoryStoreError('memory_compile_invalid_input')
            }
            seenMemoryIds.add(f.memory_id)
          }

          // Verify long-term component slugs
          const longFactComponentMap = new Map<string, string>()
          const componentGroups = new Map<string, LongTermMemoryFact[]>()
          for (const f of allLongFacts) {
            const slug = deriveComponentSlug(f.tags)
            longFactComponentMap.set(f.memory_id, slug)
            if (!componentGroups.has(slug)) {
              componentGroups.set(slug, [])
            }
            componentGroups.get(slug)!.push(f)
          }

          // Build sorted input refs
          const inputRefs: OKFInputFactRef[] = []
          for (const f of allShortFacts) {
            inputRefs.push({
              tier: 'short_term',
              session_scope_id: f.session_scope_id,
              memory_id: f.memory_id,
              content_sha256: f.content_sha256,
            })
          }
          for (const f of allLongFacts) {
            inputRefs.push({
              tier: 'long_term',
              session_scope_id: null,
              memory_id: f.memory_id,
              content_sha256: f.content_sha256,
            })
          }
          inputRefs.sort(compareInputFactRefs)

          // Compute identity
          const inputSetHash = computeInputSetHash({
            project_scope_id: validatedReq.project_scope_id,
            compiler_version: COMPILER_VERSION,
            canonicalization_version: 1,
            evaluation_at: validatedReq.evaluation_at,
            inputs: inputRefs,
          })
          const generationId = computeGenerationId(inputSetHash)
          const manifestId = computeManifestId(generationId)

          // Pre-check if current already points to this exact generation and whole world is verified
          if (oldCurrent && oldCurrent.generation_id === generationId) {
            try {
              const genMeta = await verifyPublishedGenerationWorld(root, generationId, validatedReq.project_scope_id)
              if (oldCurrent.generation_sha256 === genMeta.content_sha256 && oldCurrent.manifest_id === manifestId) {
                return {
                  status: 'noop',
                  generation_id: generationId,
                  manifest_id: manifestId,
                  current: oldCurrent,
                }
              }
            } catch {
              // Generation directory missing or corrupted, proceed to reconstruct
            }
          }

          // Create staging directory (0700)
          stagingDir = join(layout.tmpRoot, `compile_${randomUUID()}`)
          await ensureDirectoryChain(root, join(stagingDir, 'wiki', 'short-term'))
          await ensureDirectoryChain(root, join(stagingDir, 'wiki', 'components'))
          await ensureDirectoryChain(root, join(stagingDir, 'wiki', 'memories'))

          // Group active short facts by session
          const shortFactsBySession = new Map<string, ShortTermMemoryFact[]>()
          for (const f of allShortFacts) {
            if (!shortFactsBySession.has(f.session_scope_id)) {
              shortFactsBySession.set(f.session_scope_id, [])
            }
            shortFactsBySession.get(f.session_scope_id)!.push(f)
          }
          const activeSessions = Array.from(shortFactsBySession.keys()).sort(compareCodePoints)

          // Render ROOT.md
          const componentNames = Array.from(componentGroups.keys()).sort(compareCodePoints)
          const rootMd = renderRootPage({
            generation_id: generationId,
            evaluation_at: validatedReq.evaluation_at,
            short_term_count: allShortFacts.length,
            long_term_count: allLongFacts.length,
            sessions: activeSessions,
            components: componentNames,
            memories_count: allShortFacts.length + allLongFacts.length,
          })
          await durableWriteFile(join(stagingDir, 'wiki', 'ROOT.md'), rootMd, hooks)

          // Render Short-term Session Pages
          for (const [sId, sFacts] of shortFactsBySession.entries()) {
            const sessionMd = renderSessionPage({
              session_scope_id: sId,
              evaluation_at: validatedReq.evaluation_at,
              facts: sFacts,
            })
            await durableWriteFile(join(stagingDir, 'wiki', 'short-term', `${sId}.md`), sessionMd, hooks)
          }

          // Render Component Pages
          for (const [slug, cFacts] of componentGroups.entries()) {
            const compMd = renderComponentPage({
              component: slug,
              evaluation_at: validatedReq.evaluation_at,
              facts: cFacts,
            })
            await durableWriteFile(join(stagingDir, 'wiki', 'components', `${slug}.md`), compMd, hooks)
          }

          // Render Memory Pages
          for (const f of allShortFacts) {
            const memMd = renderMemoryPage({
              fact: f,
              component: null,
              evaluation_at: validatedReq.evaluation_at,
            })
            await durableWriteFile(join(stagingDir, 'wiki', 'memories', `${f.memory_id}.md`), memMd, hooks)
          }
          for (const f of allLongFacts) {
            const slug = longFactComponentMap.get(f.memory_id) || 'general'
            const memMd = renderMemoryPage({
              fact: f,
              component: slug,
              evaluation_at: validatedReq.evaluation_at,
            })
            await durableWriteFile(join(stagingDir, 'wiki', 'memories', `${f.memory_id}.md`), memMd, hooks)
          }

          // Build index.json via shared buildExpectedIndex
          const expectedIndex = buildExpectedIndex({
            generation_id: generationId,
            project_scope_id: validatedReq.project_scope_id,
            compiler_version: COMPILER_VERSION,
            evaluation_at: validatedReq.evaluation_at,
            shortFacts: allShortFacts,
            longFacts: allLongFacts,
          })
          const indexCanonical = canonicalizeIndex(expectedIndex)
          await durableWriteFile(join(stagingDir, 'index.json'), indexCanonical, hooks)

          // Read back all files from staging to compute Output Refs
          const outputRefs: OKFOutputFileRef[] = []

          // index.json
          const indexFileRes = await readStrictFile(root, join(stagingDir, 'index.json'))
          outputRefs.push({
            relative_path: 'index.json',
            byte_length: indexFileRes.byteLength,
            content_sha256: indexFileRes.sha256,
          })

          // wiki/ROOT.md
          const rootFileRes = await readStrictFile(root, join(stagingDir, 'wiki', 'ROOT.md'))
          outputRefs.push({
            relative_path: 'wiki/ROOT.md',
            byte_length: rootFileRes.byteLength,
            content_sha256: rootFileRes.sha256,
          })

          // wiki/short-term/*.md
          for (const sId of activeSessions) {
            const p = `wiki/short-term/${sId}.md`
            const sFileRes = await readStrictFile(root, join(stagingDir, 'wiki', 'short-term', `${sId}.md`))
            outputRefs.push({
              relative_path: p,
              byte_length: sFileRes.byteLength,
              content_sha256: sFileRes.sha256,
            })
          }

          // wiki/components/*.md
          for (const slug of componentNames) {
            const p = `wiki/components/${slug}.md`
            const cFileRes = await readStrictFile(root, join(stagingDir, 'wiki', 'components', `${slug}.md`))
            outputRefs.push({
              relative_path: p,
              byte_length: cFileRes.byteLength,
              content_sha256: cFileRes.sha256,
            })
          }

          // wiki/memories/*.md
          const allMemIds = Array.from(seenMemoryIds.values()).sort(compareCodePoints)
          for (const memId of allMemIds) {
            const p = `wiki/memories/${memId}.md`
            const mFileRes = await readStrictFile(root, join(stagingDir, 'wiki', 'memories', `${memId}.md`))
            outputRefs.push({
              relative_path: p,
              byte_length: mFileRes.byteLength,
              content_sha256: mFileRes.sha256,
            })
          }

          outputRefs.sort(compareOutputFileRefs)

          const compiledOutputHash = computeCompiledOutputHash(outputRefs)

          // Build Manifest
          const manifestObject: OKFInputManifest = {
            schema_version: 1,
            manifest_id: manifestId,
            generation_id: generationId,
            project_scope_id: validatedReq.project_scope_id,
            compiler_version: COMPILER_VERSION,
            canonicalization_version: 1,
            evaluation_at: validatedReq.evaluation_at,
            inputs: inputRefs,
            outputs: outputRefs,
            compiled_output_sha256: compiledOutputHash,
            content_sha256: '',
          }
          const manifestCanonical = canonicalizeManifest(manifestObject)
          const validatedManifest = validateManifest(JSON.parse(manifestCanonical))
          await durableWriteFile(join(stagingDir, 'manifest.json'), manifestCanonical, hooks)

          // Build Generation Metadata
          const genMetaObject: OKFGenerationMetadata = {
            schema_version: 1,
            generation_id: generationId,
            manifest_id: manifestId,
            manifest_sha256: validatedManifest.content_sha256,
            project_scope_id: validatedReq.project_scope_id,
            compiler_version: COMPILER_VERSION,
            evaluation_at: validatedReq.evaluation_at,
            compiled_output_sha256: compiledOutputHash,
            status: 'complete',
            content_sha256: '',
          }
          const genMetaCanonical = canonicalizeGenerationMetadata(genMetaObject)
          const validatedGenMeta = validateGenerationMetadata(JSON.parse(genMetaCanonical))
          await durableWriteFile(join(stagingDir, 'generation.json'), genMetaCanonical, hooks)

          // Build CURRENT pointer
          const currentObject: OKFCurrentPointer = {
            schema_version: 1,
            generation_id: generationId,
            generation_sha256: validatedGenMeta.content_sha256,
            manifest_id: manifestId,
            manifest_sha256: validatedManifest.content_sha256,
            project_scope_id: validatedReq.project_scope_id,
            content_sha256: '',
          }
          const currentCanonical = canonicalizeCurrentPointer(currentObject)
          const validatedCurrent = validateCurrentPointer(JSON.parse(currentCanonical))

          if (hooks?.onManifestPublication) {
            await hooks.onManifestPublication()
          }

          // Fsync all staging directories before publishing
          await syncDirectory(join(stagingDir, 'wiki', 'short-term'))
          await syncDirectory(join(stagingDir, 'wiki', 'components'))
          await syncDirectory(join(stagingDir, 'wiki', 'memories'))
          await syncDirectory(join(stagingDir, 'wiki'))
          await syncDirectory(stagingDir)

          // 1. Publish permanent Manifest
          await publishManifest(root, validatedManifest, hooks)

          // 2. Publish Generation directory
          await ensureDirectoryChain(root, layout.generationsRoot)
          const finalGenDir = join(layout.generationsRoot, generationId)

          let isGenExisting = false
          try {
            const s = await readStrictFile(root, join(finalGenDir, 'generation.json'))
            const parsed = JSON.parse(s.text)
            const validated = validateGenerationMetadata(parsed)
            if (validated.content_sha256 === validatedGenMeta.content_sha256) {
              isGenExisting = true
            } else {
              throw new MemoryStoreError('memory_compile_identity_conflict')
            }
          } catch (err: unknown) {
            if (err instanceof MemoryStoreError) {
              if (err.code === 'memory_compile_not_found') {
                isGenExisting = false
              } else {
                throw err
              }
            } else {
              throw new MemoryStoreError('memory_compile_io_failed', err)
            }
          }

          if (!isGenExisting) {
            try {
              await rename(stagingDir, finalGenDir)
              stagingDir = null
            } catch (err: unknown) {
              throw new MemoryStoreError('memory_compile_io_failed', err)
            }
            await syncDirectory(layout.generationsRoot)
          }

          // Strict verification of published generation world
          await verifyPublishedGenerationWorld(root, generationId, validatedReq.project_scope_id)

          if (hooks?.onBeforeCurrentRename) {
            await hooks.onBeforeCurrentRename()
          }

          // 3. Atomically replace CURRENT pointer
          await publishCurrent(root, validatedCurrent, hooks)

          if (hooks?.onPostCurrentRenameFsync) {
            await hooks.onPostCurrentRenameFsync()
          }

          return {
            status: 'created',
            generation_id: generationId,
            manifest_id: manifestId,
            current: validatedCurrent,
          }
        } finally {
          if (stagingDir) {
            try {
              await rm(stagingDir, { recursive: true, force: true })
            } catch {}
          }
          await releaseLock()
        }
      } catch (err: unknown) {
        mapToCompileError(err)
      }
    },
  }
}
