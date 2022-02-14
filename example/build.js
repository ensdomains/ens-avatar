require('dotenv').config();
require('esbuild')
  .build({
    bundle: true,
    entryPoints: ['example/browser.js'],
    external: ['dotenv', 'jsdom'],
    loader: {
      '.html': 'text',
    },
    outfile: 'example/dist/index.js',
    define: {
      "process": `{
        "env": {
          "NODE_ENV": 'production',
          "NODE_DEBUG": false,
          "INFURA_KEY": '${process.env.INFURA_KEY}'
        },
      }`,
    },
  })
  .catch(() => process.exit(1));
