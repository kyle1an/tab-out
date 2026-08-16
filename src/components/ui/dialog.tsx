import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'

import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogBackdrop = DialogPrimitive.Backdrop
const DialogClose = DialogPrimitive.Close
const DialogPopup = DialogPrimitive.Popup
const DialogPortal = DialogPrimitive.Portal
const DialogTrigger = DialogPrimitive.Trigger
const DialogViewport = DialogPrimitive.Viewport

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI dialog primitive family is intentionally colocated in one file.
function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogBackdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-80 bg-black/28 backdrop-blur-[1px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogViewport
        data-slot="dialog-viewport"
        className="fixed inset-0 z-80 flex items-center justify-center overflow-y-auto p-4"
      >
        <DialogPopup
          data-slot="dialog-content"
          className={cn(
            'relative w-full max-w-105 rounded-[20px] bg-popover p-5 text-popover-foreground shadow-xl ring-1 ring-foreground/12 outline-none [corner-shape:squircle]',
            'transition-[opacity,transform] duration-180 ease-swift data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </DialogPopup>
      </DialogViewport>
    </DialogPortal>
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI dialog primitive family is intentionally colocated in one file.
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('m-0 text-base leading-6 font-semibold text-foreground', className)}
      {...props}
    />
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI dialog primitive family is intentionally colocated in one file.
function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('mt-2 text-sm leading-5 text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
}
