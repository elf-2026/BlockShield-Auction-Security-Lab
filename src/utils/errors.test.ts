import { describe, expect, it } from 'vitest'
import { classifyError, errorMessage } from './contract'

describe('classifyError', () => {
  it('detects user rejection by error name', () => {
    const result = classifyError({ name: 'UserRejectedRequestError', message: 'rejected' })
    expect(result.kind).toBe('rejected')
    expect(result.message).toMatch(/rejected/i)
  })

  it('detects user rejection by message text', () => {
    expect(classifyError(new Error('User rejected the request.')).kind).toBe('rejected')
  })

  it('detects wrong chain mismatch messages', () => {
    const result = classifyError(new Error('chain id mismatch: expected 31337'))
    expect(result.kind).toBe('wrong-chain')
    expect(result.message).toContain('31337')
  })

  it('detects missing contract code', () => {
    const result = classifyError({
      name: 'ContractFunctionExecutionError',
      message: 'An unknown error occurred in the contract',
      cause: { shortMessage: 'Contract code not found at address' },
    })
    expect(result.kind).toBe('no-code')
    expect(result.message).toMatch(/no contract code/i)
  })

  it('surfaces revert reasons from viem error causes', () => {
    const result = classifyError({
      name: 'ContractFunctionExecutionError',
      message: 'Execution failed',
      cause: {
        name: 'ContractFunctionRevertedError',
        shortMessage: 'The contract function "commit" reverted.',
        reason: 'Wrong phase',
      },
    })
    expect(result.kind).toBe('revert')
    expect(result.message).toContain('Wrong phase')
  })

  it('detects RPC unreachable / connection failures', () => {
    expect(classifyError(new Error('fetch failed: ECONNREFUSED 127.0.0.1:8545')).kind).toBe('rpc')
    expect(classifyError(new Error('socket hang up (network error)')).kind).toBe('rpc')
  })

  it('falls back to unknown with the raw message', () => {
    const result = classifyError(new Error('something exotic happened'))
    expect(result.kind).toBe('unknown')
    expect(result.message).toContain('something exotic happened')
  })

  it('handles non-Error values without throwing', () => {
    expect(classifyError('plain string failure').message).toContain('plain string failure')
    expect(classifyError(undefined).kind).toBe('unknown')
  })

  it('errorMessage delegates to classifyError', () => {
    expect(errorMessage({ name: 'UserRejectedRequestError' })).toMatch(/rejected/i)
  })
})
