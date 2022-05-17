require('dotenv').config();
const { StaticJsonRpcProvider } = require('@ethersproject/providers');
const { AvatarResolver, utils: avtUtils } = require('../dist/index');
const { JSDOM } = require('jsdom');

const jsdom = new JSDOM().window;
const ensName = process.argv[2];
if (!ensName) {
  console.log(
    'Please provide an ENS name as an argument (> node demo.js nick.eth)'
  );
  process.exit(1);
}
const provider = new StaticJsonRpcProvider(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const avt = new AvatarResolver(provider);
avt
  .getMetadata(ensName)
  .then(metadata => {
    if (!metadata) {
      console.log('Avatar not found!');
      return;
    }
    const avatar = avtUtils.getImageURI({
      metadata,
      customGateway: 'https://dweb.link',
      jsdomWindow: jsdom,
    });
    console.log(avatar);
  })
  .catch(console.log);
