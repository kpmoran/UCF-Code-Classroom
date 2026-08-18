import { cva, type VariantProps } from 'class-variance-authority'
import Link from 'next/link'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-foreground text-background hover:opacity-90',
        accent: 'bg-accent-bright text-accent-contrast hover:brightness-95 font-semibold',
        outline: 'border border-border-strong bg-surface hover:bg-surface-subtle',
        ghost: 'hover:bg-surface-subtle',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4',
        lg: 'h-11 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

/**
 * A link styled as a button. Separate from `Button` rather than an `asChild`
 * prop because nesting an anchor inside a button is invalid HTML and breaks
 * keyboard and screen-reader behavior.
 */
export type ButtonLinkProps = ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>

export function ButtonLink({ className, variant, size, ...props }: ButtonLinkProps) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
