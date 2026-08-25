import {
  createOKFCompiler,
  type OKFCompiler,
  type OKFCompilerHooks,
} from '../okf-compiler.js'
import type {
  CompileOKFRequest,
  CompileOKFResult,
  OKFCurrentPointer,
  OKFGenerationMetadata,
} from '../okf-schema.js'
import {
  openMemoryFactStore,
  type MemoryFactStore,
  type MemoryFactStoreOptions,
  type MemoryStoreHooks,
} from '../memory-store.js'
import type { GenerationStoreHooks } from '../generation-store.js'

export interface OKFCompilerTestHooks extends OKFCompilerHooks, GenerationStoreHooks {
  simulateStagingWriteFailure?: boolean
  simulateStagingSyncFailure?: boolean
  simulateStagingCloseFailure?: boolean
  simulateManifestPublicationFailure?: boolean
  simulateBeforeCurrentRenameFailure?: boolean
  simulatePostCurrentRenameFsyncFailure?: boolean
  simulateLockGrowthBeforeRead?: boolean
  simulateLockWriteFailure?: boolean
  simulateLockSyncFailure?: boolean
  simulateLockCloseFailure?: boolean
  simulateManifestTempWriteFailure?: boolean
  simulateManifestTempSyncFailure?: boolean
  simulateManifestTempCloseFailure?: boolean
  simulateCurrentTempWriteFailure?: boolean
  simulateCurrentTempSyncFailure?: boolean
  simulateCurrentTempCloseFailure?: boolean
}

export interface MemoryStoreTestHooks {
  simulateLinkFailure?: boolean
  simulateTempFileFsyncFailure?: boolean
  simulateTargetParentFsyncFailure?: boolean
  simulateReadbackFailure?: boolean
}

export type InternalStoreHooks = OKFCompilerTestHooks

let activeCompilerHooks: OKFCompilerTestHooks | null = null
let activeMemoryStoreHooks: MemoryStoreTestHooks | null = null

export function __setOKFCompilerTestHooks(hooks: OKFCompilerTestHooks | null): void {
  activeCompilerHooks = hooks
}

export function __setInternalStoreHooks(hooks: InternalStoreHooks | null): void {
  activeCompilerHooks = hooks
}

export function __setMemoryStoreTestHooks(hooks: MemoryStoreTestHooks | null): void {
  activeMemoryStoreHooks = hooks
}

export function getActiveCompilerHooks(): OKFCompilerHooks | undefined {
  if (!activeCompilerHooks) return undefined
  const h = activeCompilerHooks
  return {
    onStagingWrite: h.simulateStagingWriteFailure ? () => { throw new Error('simulated staging write failure') } : h.onStagingWrite,
    onStagingSync: h.simulateStagingSyncFailure ? () => { throw new Error('simulated staging sync failure') } : h.onStagingSync,
    onStagingClose: h.simulateStagingCloseFailure ? () => { throw new Error('simulated staging close failure') } : h.onStagingClose,
    onManifestPublication: h.simulateManifestPublicationFailure ? () => { throw new Error('simulated manifest publication failure') } : h.onManifestPublication,
    onBeforeCurrentRename: h.simulateBeforeCurrentRenameFailure ? () => { throw new Error('simulated before current rename failure') } : h.onBeforeCurrentRename,
    onPostCurrentRenameFsync: h.simulatePostCurrentRenameFsyncFailure ? () => { throw new Error('simulated post current rename fsync failure') } : h.onPostCurrentRenameFsync,
    onLockGrowthBeforeRead: h.simulateLockGrowthBeforeRead ? () => { throw new Error('simulated lock growth before read') } : h.onLockGrowthBeforeRead,
    onLockWrite: h.simulateLockWriteFailure ? () => { throw new Error('simulated lock write failure') } : h.onLockWrite,
    onLockSync: h.simulateLockSyncFailure ? () => { throw new Error('simulated lock sync failure') } : h.onLockSync,
    onLockClose: h.simulateLockCloseFailure ? () => { throw new Error('simulated lock close failure') } : h.onLockClose,
    onManifestTempWrite: h.simulateManifestTempWriteFailure ? () => { throw new Error('simulated manifest temp write failure') } : h.onManifestTempWrite,
    onManifestTempSync: h.simulateManifestTempSyncFailure ? () => { throw new Error('simulated manifest temp sync failure') } : h.onManifestTempSync,
    onManifestTempClose: h.simulateManifestTempCloseFailure ? () => { throw new Error('simulated manifest temp close failure') } : h.onManifestTempClose,
    onCurrentTempWrite: h.simulateCurrentTempWriteFailure ? () => { throw new Error('simulated current temp write failure') } : h.onCurrentTempWrite,
    onCurrentTempSync: h.simulateCurrentTempSyncFailure ? () => { throw new Error('simulated current temp sync failure') } : h.onCurrentTempSync,
    onCurrentTempClose: h.simulateCurrentTempCloseFailure ? () => { throw new Error('simulated current temp close failure') } : h.onCurrentTempClose,
  }
}

export function getActiveMemoryStoreHooks(): MemoryStoreHooks | undefined {
  if (!activeMemoryStoreHooks) return undefined
  const h = activeMemoryStoreHooks
  return {
    onTempFileFsync: h.simulateTempFileFsyncFailure ? () => { throw new Error('simulated temp file fsync failure') } : undefined,
    onLink: h.simulateLinkFailure ? () => { throw new Error('simulated link failure') } : undefined,
    onTargetParentFsync: h.simulateTargetParentFsyncFailure ? () => { throw new Error('simulated target parent fsync failure') } : undefined,
    onReadback: h.simulateReadbackFailure ? () => { throw new Error('simulated readback failure') } : undefined,
  }
}

export function createTestOKFCompiler(customHooks?: OKFCompilerTestHooks): OKFCompiler {
  return {
    async compile(req: CompileOKFRequest): Promise<CompileOKFResult> {
      const hooks = customHooks ? {
        onStagingWrite: customHooks.simulateStagingWriteFailure ? () => { throw new Error('simulated staging write failure') } : customHooks.onStagingWrite,
        onStagingSync: customHooks.simulateStagingSyncFailure ? () => { throw new Error('simulated staging sync failure') } : customHooks.onStagingSync,
        onStagingClose: customHooks.simulateStagingCloseFailure ? () => { throw new Error('simulated staging close failure') } : customHooks.onStagingClose,
        onManifestPublication: customHooks.simulateManifestPublicationFailure ? () => { throw new Error('simulated manifest publication failure') } : customHooks.onManifestPublication,
        onBeforeCurrentRename: customHooks.simulateBeforeCurrentRenameFailure ? () => { throw new Error('simulated before current rename failure') } : customHooks.onBeforeCurrentRename,
        onPostCurrentRenameFsync: customHooks.simulatePostCurrentRenameFsyncFailure ? () => { throw new Error('simulated post current rename fsync failure') } : customHooks.onPostCurrentRenameFsync,
        onLockGrowthBeforeRead: customHooks.simulateLockGrowthBeforeRead ? () => { throw new Error('simulated lock growth before read') } : customHooks.onLockGrowthBeforeRead,
        onLockWrite: customHooks.simulateLockWriteFailure ? () => { throw new Error('simulated lock write failure') } : customHooks.onLockWrite,
        onLockSync: customHooks.simulateLockSyncFailure ? () => { throw new Error('simulated lock sync failure') } : customHooks.onLockSync,
        onLockClose: customHooks.simulateLockCloseFailure ? () => { throw new Error('simulated lock close failure') } : customHooks.onLockClose,
        onManifestTempWrite: customHooks.simulateManifestTempWriteFailure ? () => { throw new Error('simulated manifest temp write failure') } : customHooks.onManifestTempWrite,
        onManifestTempSync: customHooks.simulateManifestTempSyncFailure ? () => { throw new Error('simulated manifest temp sync failure') } : customHooks.onManifestTempSync,
        onManifestTempClose: customHooks.simulateManifestTempCloseFailure ? () => { throw new Error('simulated manifest temp close failure') } : customHooks.onManifestTempClose,
        onCurrentTempWrite: customHooks.simulateCurrentTempWriteFailure ? () => { throw new Error('simulated current temp write failure') } : customHooks.onCurrentTempWrite,
        onCurrentTempSync: customHooks.simulateCurrentTempSyncFailure ? () => { throw new Error('simulated current temp sync failure') } : customHooks.onCurrentTempSync,
        onCurrentTempClose: customHooks.simulateCurrentTempCloseFailure ? () => { throw new Error('simulated current temp close failure') } : customHooks.onCurrentTempClose,
      } : getActiveCompilerHooks()
      const compiler = createOKFCompiler({ hooks })
      return compiler.compile(req)
    },
    async readCurrent(projectRoot: string, projectScopeId: string): Promise<OKFCurrentPointer | null> {
      const compiler = createOKFCompiler()
      return compiler.readCurrent(projectRoot, projectScopeId)
    },
    async verifyGeneration(projectRoot: string, generationId: string): Promise<OKFGenerationMetadata> {
      const compiler = createOKFCompiler()
      return compiler.verifyGeneration(projectRoot, generationId)
    },
  }
}

export function openTestMemoryFactStore(options: MemoryFactStoreOptions & { testHooks?: MemoryStoreTestHooks }): MemoryFactStore {
  const dynamicHooks: MemoryStoreHooks = {
    async onTempFileFsync() {
      const active = options.testHooks ?? activeMemoryStoreHooks
      if (active?.simulateTempFileFsyncFailure) {
        throw new Error('simulated temp file fsync failure')
      }
      await options.hooks?.onTempFileFsync?.()
    },
    async onLink() {
      const active = options.testHooks ?? activeMemoryStoreHooks
      if (active?.simulateLinkFailure) {
        throw new Error('simulated link failure')
      }
      await options.hooks?.onLink?.()
    },
    async onTargetParentFsync() {
      const active = options.testHooks ?? activeMemoryStoreHooks
      if (active?.simulateTargetParentFsyncFailure) {
        throw new Error('simulated target parent fsync failure')
      }
      await options.hooks?.onTargetParentFsync?.()
    },
    async onReadback() {
      const active = options.testHooks ?? activeMemoryStoreHooks
      if (active?.simulateReadbackFailure) {
        throw new Error('simulated readback failure')
      }
      await options.hooks?.onReadback?.()
    },
  }

  return openMemoryFactStore({
    ...options,
    hooks: dynamicHooks,
  })
}
