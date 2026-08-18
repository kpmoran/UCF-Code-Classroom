'use client'

import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'

/**
 * Confirmation for a consequential action.
 *
 * Uses a native `<dialog>` so focus trapping, Escape to close, and the backdrop
 * come from the platform rather than a hand-rolled implementation that usually
 * gets keyboard behaviour wrong.
 *
 * When `confirmText` is given the action stays disabled until it is typed back
 * exactly. That is reserved for genuinely irreversible operations — deleting a
 * GitHub repository — because applying it to everything trains people to copy
 * strings without reading them, which defeats the point.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmText,
  destructive = true,
  busy = false,
  error,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmLabel: string
  /** Require this exact string to be typed before confirming. */
  confirmText?: string | null
  destructive?: boolean
  busy?: boolean
  error?: string | null
  children?: React.ReactNode
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState('')
  const inputId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open && !dialog.open) {
      setTyped('')
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Escape and backdrop dismissal fire `close` without going through onCancel,
  // so the parent's state is synchronised here rather than left stale.
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const handler = () => onCancel()
    dialog.addEventListener('close', handler)
    return () => dialog.removeEventListener('close', handler)
  }, [onCancel])

  const satisfied = !confirmText || typed.trim() === confirmText

  return (
    <dialog
      ref={ref}
      className="backdrop:bg-black/50 rounded-lg border border-border bg-surface p-0 max-w-md w-[calc(100%-2rem)] text-foreground"
      aria-labelledby={`${inputId}-title`}
    >
      <div className="px-5 py-4 border-b border-border">
        <h2 id={`${inputId}-title`} className="text-base font-semibold">
          {title}
        </h2>
      </div>

      <div className="px-5 py-4 space-y-3 text-sm">
        {description ? <div className="text-muted">{description}</div> : null}
        {children}

        {error ? (
          <p role="alert" className="rounded-md bg-danger-subtle text-danger px-3 py-2">
            {error}
          </p>
        ) : null}

        {confirmText ? (
          <div>
            <Label htmlFor={inputId}>
              Type <code className="font-mono">{confirmText}</code> to confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              placeholder={confirmText}
            />
          </div>
        ) : null}
      </div>

      <div className="px-5 py-3 border-t border-border bg-surface-subtle rounded-b-lg flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={busy || !satisfied}
        >
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </dialog>
  )
}
