const params = new URLSearchParams(window.location.search)
if (params.get('view') === 'bookmarks') {
  document.documentElement.setAttribute('data-tabout-startup-view', 'bookmarks')
}
