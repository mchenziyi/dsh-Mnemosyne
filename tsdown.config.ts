import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/client.tsx', 'src/typert.remote-client.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  deps: { neverBundle: ['react'] },
  outputOptions: (options, format) => ({
    ...options,
    chunkFileNames: format === 'cjs' ? '[name].cjs' : '[name].mjs',
  }),
  dts: true,
  clean: true,
  outDir: 'dist',
})
