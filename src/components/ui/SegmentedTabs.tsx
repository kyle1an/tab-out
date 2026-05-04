import { Tabs } from '@base-ui/react/tabs'

export interface SegmentedTabsOption<TValue extends string> {
  value: TValue
  label: string
}

interface SegmentedTabsProps<TValue extends string> {
  value: TValue
  options: readonly SegmentedTabsOption<TValue>[]
  ariaLabel: string
  rootClassName?: string
  listClassName?: string
  tabClassName?: string
  onValueChange: (value: TValue) => void | Promise<void>
}

function isSegmentedTabValue<TValue extends string>(
  options: readonly SegmentedTabsOption<TValue>[],
  value: unknown
): value is TValue {
  return typeof value === 'string' && options.some((option) => option.value === value)
}

export function SegmentedTabs<TValue extends string>({
  value,
  options,
  ariaLabel,
  rootClassName,
  listClassName,
  tabClassName,
  onValueChange
}: SegmentedTabsProps<TValue>) {
  function handleValueChange(nextValue: unknown) {
    if (!isSegmentedTabValue(options, nextValue)) return
    if (nextValue === value) return
    void onValueChange(nextValue)
  }

  return (
    <Tabs.Root className={rootClassName} value={value} onValueChange={handleValueChange}>
      <Tabs.List className={listClassName} aria-label={ariaLabel}>
        {options.map((option) => (
          <Tabs.Tab key={option.value} className={tabClassName} value={option.value}>
            {option.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  )
}
