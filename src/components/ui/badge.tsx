import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-subtle text-muted border-border',
        success: 'bg-success-subtle text-success border-transparent',
        warning: 'bg-warning-subtle text-warning border-transparent',
        danger: 'bg-danger-subtle text-danger border-transparent',
        info: 'bg-info-subtle text-info border-transparent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
