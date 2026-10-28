import { encodePacked, keccak256, stringToHex, type Address, type Hash } from 'viem'

/**
 * Domain tag for commitment hashing: keccak256("BlockShield.CommitReveal.V2").
 * Must byte-for-byte match CommitRevealAuction.computeCommitmentHash, which
 * packs (tag, block.chainid, address(this), bidder, bidAmount, nonce) via
 * abi.encodePacked and hashes the result.
 */
export const COMMITMENT_DOMAIN_TAG =
  '0x185d1493f458411625d2ea6eacf72346ed9f7200d3f104d52be28ab6289489de' as const

// Guard against transcription errors between Solidity and TypeScript: the
// hardcoded tag must equal keccak256 of the literal domain string.
const computedTag = keccak256(stringToHex('BlockShield.CommitReveal.V2'))
if (computedTag !== COMMITMENT_DOMAIN_TAG) {
  throw new Error(
    `Commitment domain tag mismatch: computed ${computedTag}, expected ${COMMITMENT_DOMAIN_TAG}`,
  )
}

export interface CommitmentParams {
  bidder: Address
  bidAmount: bigint
  nonce: bigint
  chainId: number | bigint
  contractAddress: Address
}

/**
 * Reproduce the Solidity commitment hash byte-for-byte.
 *
 * Solidity:
 *   keccak256(abi.encodePacked(
 *     keccak256("BlockShield.CommitReveal.V2"),
 *     block.chainid, address(this), bidder, bidAmount, nonce
 *   ))
 *
 * abi.encodePacked packs addresses as raw 20 bytes (not 32-byte padded),
 * which viem's encodePacked mirrors.
 */
export function computeCommitmentHash({
  bidder,
  bidAmount,
  nonce,
  chainId,
  contractAddress,
}: CommitmentParams): Hash {
  return keccak256(
    encodePacked(
      ['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256'],
      [COMMITMENT_DOMAIN_TAG, BigInt(chainId), contractAddress, bidder, bidAmount, nonce],
    ),
  )
}

/**
 * 128-bit secret nonce from the browser/node CSPRNG.
 * Never use Math.random for bid secrecy.
 */
export function generateNonce(): bigint {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return BigInt(`0x${hex}`)
}
