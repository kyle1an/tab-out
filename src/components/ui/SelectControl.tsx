import { Select } from '@base-ui/react/select'
import { cn } from '../../lib/cn'
import type { ComponentProps } from 'react'

export interface SelectControlOption<TValue extends string> {
  value: TValue
  label: string
}

interface SelectControlProps<TValue extends string> {
  value: TValue
  options: readonly SelectControlOption<TValue>[]
  ariaLabel: string
  triggerClassName?: string
  iconClassName?: string
  positionerClassName?: string
  popupClassName?: string
  listClassName?: string
  itemClassName?: string
  onValueChange: (value: TValue) => void | Promise<void>
}

function isSelectControlValue<TValue extends string>(
  options: readonly SelectControlOption<TValue>[],
  value: unknown
): value is TValue {
  return typeof value === 'string' && options.some((option) => option.value === value)
}

export function SelectControl<TValue extends string>({
  value,
  options,
  ariaLabel,
  triggerClassName,
  iconClassName,
  positionerClassName,
  popupClassName,
  listClassName,
  itemClassName,
  onValueChange
}: SelectControlProps<TValue>) {
  function handleValueChange(nextValue: unknown) {
    if (!isSelectControlValue(options, nextValue)) return
    if (nextValue === value) return
    void onValueChange(nextValue)
  }

  return (
    <Select.Root value={value} items={options} onValueChange={handleValueChange}>
      <Select.Trigger
        data-slot="select-trigger"
        data-size="default"
        className={cn(
          "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none [corner-shape:squircle] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          triggerClassName
        )}
        aria-label={ariaLabel}
      >
        <Select.Value data-slot="select-value" className="flex flex-1 text-left" />
        <Select.Icon className={cn('flex', iconClassName)}>
          <ChevronDownIcon aria-hidden="true" className="pointer-events-none size-4 text-muted-foreground" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          alignOffset={0}
          alignItemWithTrigger={false}
          className={cn('isolate z-50', positionerClassName)}
        >
          <Select.Popup
            data-slot="select-content"
            className={cn(
              'relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 [corner-shape:squircle] duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
              popupClassName
            )}
          >
            <Select.ScrollUpArrow
              data-slot="select-scroll-up-button"
              className="top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4"
            >
              <ChevronUpIcon />
            </Select.ScrollUpArrow>
            <Select.List className={cn('p-1', listClassName)}>
              {options.map((option) => (
                <Select.Item
                  data-slot="select-item"
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  className={cn(
                    "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none [corner-shape:squircle] focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
                    itemClassName
                  )}
                >
                  <Select.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                    <CheckIcon className="pointer-events-none" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
            <Select.ScrollDownArrow
              data-slot="select-scroll-down-button"
              className="bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4"
            >
              <ChevronDownIcon />
            </Select.ScrollDownArrow>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function ChevronDownIcon(props: ComponentProps<'svg'>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function ChevronUpIcon(props: ComponentProps<'svg'>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  )
}

function CheckIcon(props: ComponentProps<'svg'>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
