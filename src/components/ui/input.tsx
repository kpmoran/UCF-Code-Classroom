import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

const fieldStyles =
  'w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-muted disabled:opacity-50'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldStyles, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldStyles, 'min-h-20', className)} {...props} />
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(fieldStyles, 'h-10', className)} {...props} />
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('block text-sm font-medium mb-1.5', className)} {...props} />
}

export function FieldHint({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-xs text-muted mt-1', className)} {...props} />
}

export function FieldError({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-xs text-danger mt-1', className)} {...props} />
}
