import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/**
 * Tables wrap in their own horizontally scrolling container so a wide roster
 * never forces the whole page to scroll sideways on a laptop.
 */
export function TableWrap({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('w-full overflow-x-auto rounded-lg border border-border', className)}
      {...props}
    />
  )
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table className={cn('w-full text-sm border-collapse', className)} {...props} />
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'text-left font-medium text-muted px-4 py-2.5 bg-surface-subtle border-b border-border whitespace-nowrap',
        className,
      )}
      {...props}
    />
  )
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td className={cn('px-4 py-2.5 border-b border-border align-middle', className)} {...props} />
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="text-center py-12 px-6">
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="text-sm text-muted mt-1 max-w-md mx-auto">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
