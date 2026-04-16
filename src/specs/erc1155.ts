import { Contract, Provider } from 'ethers';
import { Buffer } from 'buffer/';
import { BaseError, createFetcher, handleSettled, resolveURI } from '../utils';
import { MetadataParsingError } from '../utils/error';
import { isURIEncoded } from '../utils/isImageURI';
import { AvatarResolverOpts, Fetcher } from '../types';

const abi = [
  'function uri(uint256 _id) public view returns (string memory)',
  'function balanceOf(address account, uint256 id) public view returns (uint256)',
];

function getMarketplaceAPIKey(uri: string, options?: AvatarResolverOpts) {
  if (
    uri.startsWith('https://api.opensea.io/') &&
    options?.apiKey?.['opensea']
  ) {
    return { 'X-API-KEY': options.apiKey.opensea };
  }
  return false;
}

export default class ERC1155 {
  async getMetadata(
    provider: Provider,
    ownerAddress: string | undefined | null,
    contractAddress: string,
    tokenID: string,
    options?: AvatarResolverOpts,
    fetcher?: Fetcher
  ) {
    // Use provided fetcher or create a new one
    const fetch =
      fetcher ||
      createFetcher({
        ttl: options?.cache,
        dispatcher: options?.dispatcher,
        allowPrivateIPs: options?.allowPrivateIPs,
        timeout: options?.timeout,
        urlDenyList: options?.urlDenyList,
      });

    // exclude opensea api which does not follow erc1155 spec
    const tokenIDHex = !tokenID.startsWith('https://api.opensea.io/')
      ? tokenID.replace('0x', '').padStart(64, '0')
      : tokenID;
    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, balance] = await handleSettled([
      contract.uri(tokenID),
      ownerAddress
        ? contract.balanceOf(ownerAddress, tokenID)
        : Promise.resolve(BigInt(0)),
    ]);

    if (!tokenURI) {
      throw new BaseError('Token URI is empty or could not be retrieved');
    }

    // if user has valid address and if token balance of given address is greater than 0
    const isOwner = !!(ownerAddress && balance && balance > BigInt(0));

    const { uri: resolvedURI, isOnChain, isEncoded } = resolveURI(tokenURI, {
      ipfs: options?.ipfs,
      arweave: options?.arweave,
    });
    let _resolvedUri = resolvedURI;
    if (isOnChain) {
      if (isEncoded) {
        _resolvedUri = Buffer.from(
          resolvedURI.replace('data:application/json;base64,', ''),
          'base64'
        ).toString();
      }
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(_resolvedUri);
      } catch (e) {
        throw new MetadataParsingError(
          `Failed to parse token metadata: ${(e as Error).message}`
        );
      }
      return { ...metadata, is_owner: isOwner };
    }

    const marketplaceKey = getMarketplaceAPIKey(resolvedURI, options);

    const replaced = resolvedURI.replace(/(?:0x)?{id}/, tokenIDHex);
    const finalURI = isURIEncoded(replaced) ? replaced : encodeURI(replaced);
    const response = await fetch.get(
      finalURI,
      marketplaceKey ? { headers: marketplaceKey } : {}
    );
    if (!response?.data) {
      throw new BaseError('Failed to retrieve token metadata from URI');
    }
    const metadata = response?.data as Record<string, unknown>;
    return { ...metadata, is_owner: isOwner };
  }
}
