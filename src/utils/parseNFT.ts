import { assert } from "./assert";
import { BaseError } from "./error";


export interface NFTURIParsingError {}
export class NFTURIParsingError extends BaseError {}

export function parseNFT(uri: string, seperator: string = '/') {
    // parse valid nft spec (CAIP-22/CAIP-29)
    // @see: https://github.com/ChainAgnostic/CAIPs/tree/master/CAIPs
    try {
      assert(uri, 'parameter URI cannot be empty');
  
      if (uri.startsWith('did:nft:')) {
        // convert DID to CAIP
        uri = uri.replace('did:nft:', '').replace(/_/g, '/');
      }
  
      const [reference, asset_namespace, tokenID] = uri.split(seperator);
      const [eip_namespace, chainID] = reference.split(':');
      const [erc_namespace, contractAddress] = asset_namespace.split(':');
  
      assert(
        eip_namespace && eip_namespace.toLowerCase() === 'eip155',
        'Only EIP-155 is supported'
      );
      assert(chainID, 'chainID not found');
      assert(contractAddress, 'contractAddress not found');
      assert(erc_namespace, 'erc namespace not found');
      assert(tokenID, 'tokenID not found');
  
      return {
        chainID: Number(chainID),
        namespace: erc_namespace.toLowerCase(),
        contractAddress,
        tokenID,
      };
    } catch (error) {
      throw new NFTURIParsingError(`${error as string} - ${uri}`);
    }
  }
