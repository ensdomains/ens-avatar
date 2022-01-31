import { Contract } from '@ethersproject/contracts';
import { fetch } from '../utils';

const abi = [
  'function uri(uint256 _id) public view returns (string memory)',
  'function balanceOf(address account, uint256 id) public view returns (uint256)',
];

export default class ERC1155 {
  async getMetadata(
    provider: any,
    registrarAddress: string,
    contractAddress: string,
    tokenID: string
  ) {
    // exclude opensea api which does not follow erc1155 spec
    const tokenIDHex = !tokenID.startsWith('https://api.opensea.io')
      ? tokenID.replace('0x', '').padStart(64, '0')
      : tokenID;
    const contract = new Contract(contractAddress, abi, provider);
    const [tokenURI, balance] = await Promise.all([
      contract.uri(tokenID),
      registrarAddress && contract.balanceOf(registrarAddress, tokenID),
    ]);
    if (!registrarAddress || !balance.gt(0)) return null;
    const response = await fetch(tokenURI.replace(/(?:0x)?{id}/, tokenIDHex));
    return await response?.data;
  }
}
