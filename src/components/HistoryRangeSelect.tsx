import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { HISTORY_RANGE_OPTIONS, isHistoryRangeValue } from '../extension/history-range.js'

export function HistoryRangeSelect({
  value,
  onValueChange
}: {
  value: string
  onValueChange?: (historyRange: string) => void | Promise<void>
}) {
  function handleValueChange(nextValue: unknown) {
    if (!isHistoryRangeValue(nextValue)) return
    if (nextValue === value) return
    void onValueChange?.(nextValue)
  }

  return (
    <Select value={value} items={HISTORY_RANGE_OPTIONS} onValueChange={handleValueChange}>
      <SelectTrigger
        data-tabout="history-range"
        className="h-(--header-control-height)! rounded-(--header-control-radius) border-(--warm-gray) bg-tab-card text-(length:--header-control-font-size) leading-(--header-control-line-height) [corner-shape:squircle]"
        aria-label="History search range"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        className="rounded-(--header-control-radius) [corner-shape:squircle]"
      >
        <SelectGroup>
          {HISTORY_RANGE_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              label={option.label}
              className="rounded-[calc(var(--header-control-radius)_-_6px)] text-(length:--header-control-font-size) leading-(--header-control-line-height) [corner-shape:squircle]"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
