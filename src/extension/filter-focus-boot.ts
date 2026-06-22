const bootWindow = window as Window & { __tabOutFilterFocusBootValue?: string }
const params = new URLSearchParams(window.location.search)
const shell = document.getElementById('filterFocusBootShell')
const input = document.getElementById('filterFocusBootInput') as HTMLInputElement | null

if (params.get('focusFilter') !== '1') {
  shell?.remove()
} else if (shell && input) {
  input.value = params.get('filter') || ''
  bootWindow.__tabOutFilterFocusBootValue = input.value
  shell.hidden = false
  input.addEventListener('input', () => {
    bootWindow.__tabOutFilterFocusBootValue = input.value
  })
  input.focus()
}
