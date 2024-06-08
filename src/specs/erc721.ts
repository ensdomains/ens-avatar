import { Contract, Provider } from 'ethers';
import { Buffer } from 'buffer/';
import { fetch, resolveURI } from '../utils';
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
    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, owner] = await Promise.all([
      contract.tokenURI(tokenID),
      ownerAddress && contract.ownerOf(tokenID),
    ]);
    // if user has valid address and if owner of the nft matches with the owner address
    const isOwner = !!(
      ownerAddress && owner.toLowerCase() === ownerAddress.toLowerCase()
    );

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
      const metadata = JSON.parse(decodeURI(_resolvedUri));
      return { ...metadata, is_owner: isOwner };
    }
    const response = await fetch(
      encodeURI(resolvedURI.replace(/(?:0x)?{id}/, tokenID))
    );
    const metadata = await response?.data;
    return { ...metadata, is_owner: isOwner };
  }
}
