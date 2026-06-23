require('dotenv').config();
const { ethers } = require('ethers');
const { AvatarResolver, utils: avtUtils } = require('../dist/index.cjs');
const { fromEthers } = require('../dist/chain/ethers.cjs');

const ensName = process.argv[2];
if (!ensName) {
  console.log(
    'Please provide an ENS name as an argument (> node demo.js nick.eth)'
  );
  process.exit(1);
}
const IPFS = 'https://cf-ipfs.com';
const provider = new ethers.JsonRpcProvider(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const avt = new AvatarResolver(fromEthers(provider), {
  ipfs: IPFS,
  apiKey: { opensea: process.env.OPENSEA_KEY },
});
avt
  .getMetadata(ensName)
  .then(metadata => {
    if (!metadata) {
      console.log('Avatar not found!');
      return;
    }
    const avatar = avtUtils.getImageURI({
      metadata,
      gateways: {
        ipfs: IPFS,
      },
    });
    console.log('avatar: ', avatar);
  })
  .catch(console.log);

try {
  avt
  .getHeader(ensName)
  .then(header => {
    console.log('header: ', header);
  })
  .catch(console.log);
} catch {}
