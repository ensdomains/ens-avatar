import { BaseProvider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import { Buffer } from 'buffer/';
import { fetch, resolveURI } from '../utils';
import { AvatarResolverOpts } from '../types';

const abi = [
  'function uri(uint256 _id) public view returns (string memory)',
  'function balanceOf(address account, uint256 id) public view returns (uint256)',
];

function getMarketplaceAPIKey(uri: string, options?: AvatarResolverOpts) {
  if (
    uri.startsWith('https://api.opensea.io') &&
    options?.apiKey?.['opensea']
  ) {
    return { 'X-API-KEY': options.apiKey.opensea };
  }
  return false;
}

export default class ERC1155 {
  async getMetadata(
    provider: BaseProvider,
    ownerAddress: string | undefined | null,
    contractAddress: string,
    tokenID: string,
    options?: AvatarResolverOpts
  ) {
    // exclude opensea api which does not follow erc1155 spec
    const tokenIDHex = !tokenID.startsWith('https://api.opensea.io')
      ? tokenID.replace('0x', '').padStart(64, '0')
      : tokenID;
    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, balance] = await Promise.all([
      contract.uri(tokenID),
      ownerAddress && contract.balanceOf(ownerAddress, tokenID),
    ]);
    // if user has valid address and if token balance of given address is greater than 0
    const isOwner = !!(ownerAddress && balance.gt(0));

    const { uri: resolvedURI, isOnChain, isEncoded } = resolveURI(
      tokenURI,
      options
    );
    let _resolvedUri = resolvedURI;
    if (isOnChain) {
      if (isEncoded) {
        _resolvedUri = Buffer.from(
          resolvedURI.replace('data:application/json;base64,', ''),
          'base64'
        ).toString();
      }
      return JSON.parse(_resolvedUri);
    }

    const marketplaceKey = getMarketplaceAPIKey(resolvedURI, options);

    const response = await fetch.get(
      encodeURI(resolvedURI.replace(/(?:0x)?{id}/, tokenIDHex)),
      marketplaceKey ? { headers: marketplaceKey } : {}
    );
    const metadata = await response?.data;
    return { ...metadata, is_owner: isOwner };
  }
}
