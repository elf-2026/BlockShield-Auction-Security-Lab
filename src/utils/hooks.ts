import { useEffect, useState } from 'react'

/** Live tick every `ms` (unix seconds) for countdowns. */
export function useNowTick(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

let toastSeq = 0

/** Monotonic id for transient toast notifications. */
export const nextToastId = () => ++toastSeq
