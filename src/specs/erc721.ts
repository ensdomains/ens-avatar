import { Buffer } from 'buffer/';
import { BaseError, createFetcher, handleSettled, resolveURI } from '../utils';
import { MetadataParsingError } from '../utils/error';
import { isURIEncoded } from '../utils/isImageURI';
import { AvatarResolverOpts, Fetcher } from '../types';
import { ChainClient } from '../chain/client';

const abi = [
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export default class ERC721 {
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

    const id = BigInt(tokenID);
    const [tokenURI, owner] = await handleSettled([
      client.readContract<string>({
        address: contractAddress,
        abi,
        functionName: 'tokenURI',
        args: [id],
      }),
      ownerAddress
        ? client.readContract<string>({
            address: contractAddress,
            abi,
            functionName: 'ownerOf',
            args: [id],
          })
        : Promise.resolve(null),
    ]);

    if (!tokenURI) {
      throw new BaseError('tokenURI is empty or could not be retrieved');
    }

    // if user has valid address and if owner of the nft matches with the owner address
    const isOwner = !!(
      ownerAddress &&
      owner &&
      owner.toLowerCase() === ownerAddress.toLowerCase()
    );

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
    const replaced = resolvedURI.replace(/(?:0x)?{id}/, tokenID);
    const finalURI = isURIEncoded(replaced) ? replaced : encodeURI(replaced);
    const response = await fetch.get(finalURI);
    if (!response?.data) {
      throw new BaseError('Failed to retrieve token metadata from URI');
    }
    const metadata = response?.data as Record<string, unknown>;
    return { ...metadata, is_owner: isOwner };
  }
}
