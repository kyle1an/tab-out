import { Button as BaseButton } from '@base-ui/react/button'
import type { ComponentPropsWithoutRef } from 'react'

export type ButtonProps = ComponentPropsWithoutRef<typeof BaseButton>

export function Button({ type = 'button', ...props }: ButtonProps) {
  return <BaseButton type={type} {...props} />
}
