require('dotenv').config();
require('esbuild')
  .build({
    bundle: true,
    entryPoints: ['example/browser.js'],
    external: ['dotenv'],
    loader: {
      '.html': 'text',
    },
    outfile: 'example/dist/index.js'
  })
  .catch(() => process.exit(1));
