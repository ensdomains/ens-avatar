import { Contract, Provider } from 'ethers';
import {
  METADATA_CALL_GAS_LIMIT,
  METADATA_REQUEST_LIMITS,
  assertMetadataSize,
  assertPlainMetadata,
  createAgentAdapter,
  createCacheAdapter,
  fetch,
  parseOnChainMetadata,
  resolveURI,
} from '../utils';
import { AvatarResolverOpts } from '../types';

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
    options?: AvatarResolverOpts
  ) {
    if (options?.cache && options?.cache > 0) {
      createCacheAdapter(fetch, options?.cache);
    }
    if (options?.agents) {
      createAgentAdapter(fetch, options?.agents);
    }

    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, owner] = await Promise.all([
      contract.tokenURI(tokenID, {
        gasLimit: options?.metadataGasLimit ?? METADATA_CALL_GAS_LIMIT,
      }),
      ownerAddress && contract.ownerOf(tokenID),
    ]);
    // if user has valid address and if owner of the nft matches with the owner address
    const isOwner = !!(
      ownerAddress && owner.toLowerCase() === ownerAddress.toLowerCase()
    );

    // bound the contract-supplied URI before resolveURI validates/decodes it
    assertMetadataSize(tokenURI);
    const { uri: resolvedURI, isOnChain, isEncoded } = resolveURI(
      tokenURI,
      options
    );
    if (isOnChain) {
      const metadata = parseOnChainMetadata(resolvedURI, isEncoded);
      return { ...metadata, is_owner: isOwner };
    }
    const response = await fetch(
      encodeURI(resolvedURI.replace(/(?:0x)?{id}/, tokenID)),
      METADATA_REQUEST_LIMITS
    );
    const metadata = await response?.data;
    assertPlainMetadata(metadata);
    return { ...metadata, is_owner: isOwner };
  }
}
