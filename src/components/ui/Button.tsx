import { Button as BaseButton } from '@base-ui/react/button'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/cn'

export type ButtonProps = ComponentPropsWithoutRef<typeof BaseButton>

export function Button({ type = 'button', className, ...props }: ButtonProps) {
  return (
    <BaseButton
      type={type}
      className={cn('focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-amber)]', className)}
      {...props}
    />
  )
}
