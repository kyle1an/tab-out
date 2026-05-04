import { Input as BaseInput } from '@base-ui/react/input'
import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, Ref } from 'react'

export type TextInputProps = ComponentPropsWithoutRef<typeof BaseInput>

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(props, ref) {
  return <BaseInput {...props} ref={ref as Ref<HTMLElement>} />
})
