import { Select } from '@base-ui/react/select'

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
      <Select.Trigger className={triggerClassName} aria-label={ariaLabel}>
        <Select.Value />
        <Select.Icon className={iconClassName}>
          <svg className="block h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="3" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className={positionerClassName} sideOffset={6} alignItemWithTrigger={false}>
          <Select.Popup className={popupClassName}>
            <Select.List className={listClassName}>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value} label={option.label} className={itemClassName}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
