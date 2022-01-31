import { Contract } from '@ethersproject/contracts';
import { fetch } from '../utils';

const abi = [
  'function tokenURI(uint256 tokenId) external view returns (string memory)',
  'function ownerOf(uint256 tokenId) public view returns (address)',
];

export default class ERC721 {
  async getMetadata(
    provider: any,
    registrarAddress: string,
    contractAddress: string,
    tokenID: string
  ) {
    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, owner] = await Promise.all([
      contract.tokenURI(tokenID),
      registrarAddress && contract.ownerOf(tokenID),
    ]);
    if (owner.toLowerCase() !== registrarAddress.toLowerCase()) return null;
    const response = await fetch(tokenURI.replace(/(?:0x)?{id}/, tokenID));
    return await response?.data;
  }
}
