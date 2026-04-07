import { Contract, Provider } from 'ethers';
import { Buffer } from 'buffer/';
import {
  BaseError,
  createFetcher,
  handleSettled,
  resolveURI,
} from '../utils';
import { MetadataParsingError } from '../utils/error';
import { isURIEncoded } from '../utils/isImageURI';
import { AvatarResolverOpts, Fetcher } from '../types';

const abi = [
  'function tokenURI(uint256 tokenId) external view returns (string memory)',
  'function ownerOf(uint256 tokenId) public view returns (address)',
];

export default class ERC721 {
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

    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, owner] = await handleSettled([
      contract.tokenURI(tokenID),
      ownerAddress
        ? contract.ownerOf(tokenID)
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

    const { uri: resolvedURI, isOnChain, isEncoded } = resolveURI(
      tokenURI,
      { ipfs: options?.ipfs, arweave: options?.arweave }
    );
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
