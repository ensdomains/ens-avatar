import fs from 'fs';
import path from 'path';
import tsPlugin from '@rollup/plugin-typescript';

const sharedOutput = {
  dir: 'dist',
  preserveModules: true,
  preserveModulesRoot: 'src',
};

export default {
  // Multiple entry points so the ethers/viem adapters are emitted as separate
  // subpath modules (@ensdomains/ens-avatar/ethers, /viem). The core entry
  // (index) imports neither adapter, so importing it pulls in no SDK.
  input: ['src/index.ts', 'src/chain/ethers.ts', 'src/chain/viem.ts'],
  // External deps (sanitize-html, postcss, multiformats, …) are pure libraries.
  // Telling rollup they have no side effects stops it emitting redundant bare
  // `import 'sanitize-html'` lines into modules that only use them transitively —
  // which esbuild (honoring `sideEffects:false`) warns about while dropping.
  // Bound imports that are actually used (utils/sanitize.ts) are unaffected.
  treeshake: { moduleSideEffects: 'no-external' },
  output: [
    // Distinct extensions so Node detects each format unambiguously without a
    // top-level "type" field: .cjs is always CommonJS, .mjs is always ESM.
    {
      ...sharedOutput,
      format: 'cjs',
      entryFileNames: '[name].cjs',
      chunkFileNames: '[name].cjs',
    },
    {
      ...sharedOutput,
      format: 'es',
      entryFileNames: '[name].mjs',
      chunkFileNames: '[name].mjs',
    },
  ],
  plugins: [
    // Declarations are emitted by a separate `tsc -p tsconfig.build.json` pass
    // (see the `build` script). Emitting them here too raced across the .cjs/.mjs
    // outputs and produced intermittently-empty .d.ts files.
    tsPlugin({
      declaration: false,
      sourceMap: false,
    }),
    removeDist(),
  ],
};

function removeDist(options = {}) {
  const { hook = 'buildStart', buildDir = 'dist' } = options;

  return {
    name: 'remove-dist',
    [hook]: async () => {
      const folderPath = path.join(process.cwd(), buildDir);
      try {
        fs.accessSync(folderPath, fs.F_OK);
        fs.rmSync(folderPath, { recursive: true, force: true });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        try {
          fs.rmSync(folderPath, { recursive: true, force: true });
        } catch (innerErr) {
          console.log('An error occurred while removing the folder:', innerErr);
        }
      }
    },
  };
}
