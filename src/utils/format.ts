import { formatEther } from 'viem'

export const fmtEth = (wei: bigint) => `${formatEther(wei)} ETH`
