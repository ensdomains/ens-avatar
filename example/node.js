require('dotenv').config();
const { StaticJsonRpcProvider } = require('@ethersproject/providers');
const { AvatarResolver, utils: avtUtils } = require('../dist/index');

const ensName = process.argv[2];
if (!ensName) {
  console.log(
    'Please provide an ENS name as an argument (> node demo.js nick.eth)'
  );
  return;
}
const provider = new StaticJsonRpcProvider(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const avt = new AvatarResolver(provider);
avt.getMetadata({ ens: process.argv[2] }).then( metadata => {
  if (!metadata) {
    console.log('Avatar not found!');
    return;
  }
  console.log(metadata);
  const avatar = avtUtils.getImageURI(metadata);
  console.log(avatar);
}).catch(console.log);
