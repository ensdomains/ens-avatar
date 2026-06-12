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
  output: [
    {
      ...sharedOutput,
      format: 'cjs',
      entryFileNames: '[name].js',
      chunkFileNames: '[name].js',
    },
    {
      ...sharedOutput,
      format: 'es',
      entryFileNames: '[name].esm.js',
      chunkFileNames: '[name].esm.js',
    },
  ],
  plugins: [
    tsPlugin({
      declarationDir: './dist',
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
