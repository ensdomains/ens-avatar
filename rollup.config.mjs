import fs from 'fs';
import path from 'path';
import tsPlugin from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: [
    {
      format: 'cjs',
      file: './dist/index.js',
    },
    {
      format: 'es',
      dir: 'dist',
      preserveModules: true,
      preserveModulesRoot: 'src',
      entryFileNames: chunk => {
        return `${chunk.name === 'index' ? 'index.esm' : chunk.name}.js`;
      },
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
