import React, { useEffect, useRef, useState } from 'react'
import { type Address, type Hash } from 'viem'

/** Shared premium UI primitives. All interactive targets are >=44px. */

export const cardCls =
  'rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900'

export const focusRing =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950'

type BtnTone = 'primary' | 'success' | 'danger' | 'warn' | 'neutral' | 'ghost'

const tones: Record<BtnTone, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:hover:bg-indigo-600',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500 disabled:hover:bg-emerald-600',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:hover:bg-red-600',
  warn: 'bg-amber-600 text-white hover:bg-amber-500 disabled:hover:bg-amber-600',
  neutral:
    'bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 disabled:hover:bg-gray-200 dark:disabled:hover:bg-gray-800',
  ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
}

export function Button({
  tone = 'primary',
  block,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; block?: boolean }) {
  return (
    <button
      {...rest}
      className={`${focusRing} ${tones[tone]} inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${block ? 'w-full' : ''} ${className}`}
    />
  )
}

export function Card({
  title,
  subtitle,
  actions,
  id,
  children,
  className = '',
}: {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  id?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section id={id} className={`${cardCls} ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-800 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-base font-bold sm:text-lg">{title}</h2>}
            {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  )
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'default' | 'warn' | 'good'
}) {
  const valueTone =
    tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'good'
        ? 'text-emerald-600 dark:text-emerald-400'
        : ''
  return (
    <div className={`${cardCls} p-4`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p
        className={`mt-1 break-words font-mono text-lg font-bold leading-snug sm:text-xl ${valueTone}`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{sub}</p>}
    </div>
  )
}

const badgeTones = {
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
} as const

export function Badge({
  tone = 'gray',
  children,
  className = '',
}: {
  tone?: keyof typeof badgeTones
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

const CopyIcon = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path
      d="M7 2a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2V7a3 3 0 0 0-3-3H7V2z"
      transform="translate(-1 1) scale(0.85)"
    />
    <path
      d="M5 6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5z"
      transform="scale(0.85)"
    />
  </svg>
)
const CheckIcon = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0z"
      clipRule="evenodd"
    />
  </svg>
)

/** Touch-friendly copy button with visual feedback. */
export function CopyButton({
  text,
  label = 'Copy',
  className = '',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      data-testid="copy-btn"
      title={`${label}: ${text}`}
      aria-label={`${label} ${text.slice(0, 10)}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          /* clipboard may be unavailable (http context); text is still on screen */
        }
        setCopied(true)
        timer.current = setTimeout(() => setCopied(false), 1500)
      }}
      className={`${focusRing} inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
      } ${className}`}
    >
      {copied ? CheckIcon : CopyIcon}
      {label ? (
        <span>{copied ? 'Copied' : label}</span>
      ) : (
        <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
      )}
    </button>
  )
}

/**
 * Long address/hash display: truncated with copy, or wrapped full form.
 * Never lets hex overflow its container. Both affordances are 44px touch
 * targets; the label itself is text (expandable), the copy is a square button.
 */
export function HexChip({
  value,
  className = '',
}: {
  value: Address | Hash | string
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const short = `${value.slice(0, 6)}…${value.slice(-4)}`
  return (
    <span className={`inline-flex min-w-0 items-center gap-0 align-middle ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`hex-break ${focusRing} min-h-[44px] min-w-[56px] rounded px-1.5 font-mono text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-800`}
        title={expanded ? 'Collapse' : value}
      >
        {expanded ? value : short}
      </button>
      <CopyButton text={value} label="" />
    </span>
  )
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
      {error && (
        <p className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export const inputCls =
  'w-full min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 disabled:bg-gray-100 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100'

// ---- toasts ---------------------------------------------------------------

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-auto sm:items-end"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-testid="toast"
          className={`pointer-events-auto w-full max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur sm:w-auto ${
            t.kind === 'success'
              ? 'border-emerald-300 bg-emerald-50/95 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/95 dark:text-emerald-200'
              : t.kind === 'error'
                ? 'border-red-300 bg-red-50/95 text-red-900 dark:border-red-800 dark:bg-red-950/95 dark:text-red-200'
                : 'border-gray-300 bg-white/95 text-gray-800 dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-200'
          }`}
        >
          <span className="hex-break break-words">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
