import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
    <Select value={value} items={options} onValueChange={handleValueChange}>
      <SelectTrigger className={triggerClassName} iconClassName={iconClassName} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent positionerClassName={positionerClassName} className={popupClassName} listClassName={listClassName}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label} className={itemClassName}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
