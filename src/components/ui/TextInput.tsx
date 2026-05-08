import { Input as BaseInput } from '@base-ui/react/input'
import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, Ref } from 'react'
import { cn } from '../../lib/cn'

export type TextInputProps = ComponentPropsWithoutRef<typeof BaseInput>

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({ className, ...props }, ref) {
  return (
    <BaseInput
      className={cn('focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-amber)]', className)}
      {...props}
      ref={ref as Ref<HTMLElement>}
    />
  )
})
