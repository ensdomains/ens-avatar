require('esbuild')
  .build({
    bundle: true,
    entryPoints: ['example/browser.js'],
    external: ['dotenv', 'http', 'https', 'undici'],
    loader: {
      '.html': 'text',
    },
    outfile: 'example/dist/index.js',
  })
  .catch(() => process.exit(1));
