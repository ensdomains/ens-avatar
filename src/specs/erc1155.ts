import { Buffer } from 'buffer/';
import { BaseError, createFetcher, handleSettled, resolveURI } from '../utils';
import { MetadataParsingError } from '../utils/error';
import { isURIEncoded } from '../utils/isImageURI';
import { AvatarResolverOpts, Fetcher } from '../types';
import { ChainClient } from '../chain/client';

const abi = [
  {
    type: 'function',
    name: 'uri',
    stateMutability: 'view',
    inputs: [{ name: '_id', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

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
    client: ChainClient,
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
    const id = BigInt(tokenID);
    const [tokenURI, balance] = await handleSettled([
      client.readContract<string>({
        address: contractAddress,
        abi,
        functionName: 'uri',
        args: [id],
      }),
      ownerAddress
        ? client.readContract<bigint>({
            address: contractAddress,
            abi,
            functionName: 'balanceOf',
            args: [ownerAddress, id],
          })
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
