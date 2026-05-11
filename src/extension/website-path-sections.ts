import type { WebsitePathSectionResult, WebsitePathSectionRule } from './types'

function recognizedPathPrefix(pathname: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix
  }
  return ''
}

function pathSection(prefix: string): WebsitePathSectionResult | null {
  return prefix ? { key: prefix, label: prefix } : null
}

const GOOGLE_DOCS_PREFIXES = [
  '/document',
  '/spreadsheets',
  '/presentation',
  '/forms',
  '/drawings'
]

const ATLASSIAN_PREFIXES = [
  '/jira/servicedesk',
  '/jira/software',
  '/jira/core',
  '/jira/your-work',
  '/jira/projects',
  '/servicedesk',
  '/browse',
  '/issues',
  '/wiki'
]

const BUILT_IN_WEBSITE_PATH_SECTION_RULES: WebsitePathSectionRule[] = [
  {
    hostname: 'docs.google.com',
    extract: (url) => pathSection(recognizedPathPrefix(url.pathname, GOOGLE_DOCS_PREFIXES))
  },
  {
    hostnameEndsWith: '.atlassian.net',
    extract: (url) => pathSection(recognizedPathPrefix(url.pathname, ATLASSIAN_PREFIXES))
  }
]

export function resolveWebsitePathSection(url: string): WebsitePathSectionResult | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  for (const rule of BUILT_IN_WEBSITE_PATH_SECTION_RULES) {
    const hostMatch = rule.hostname
      ? parsed.hostname === rule.hostname
      : rule.hostnameEndsWith
        ? parsed.hostname.endsWith(rule.hostnameEndsWith)
        : false
    if (!hostMatch) continue
    try {
      const result = rule.extract(parsed)
      if (result && result.key && result.label) return result
    } catch {
      return null
    }
  }

  return null
}
