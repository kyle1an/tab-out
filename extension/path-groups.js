/* ================================================================
   Path-group adapters

   Given a tab URL (already suspender-unwrapped upstream in tabs.js),
   return a { key, label } identifying which "path group" the tab
   belongs to — a cluster of tabs that share a meaningful path-level
   grouping on a given site (e.g. all issues for the same Jira
   project, all PRs for the same GitHub repo).

   The render layer turns the label into a small inline pill on each
   chip, but only when 2+ chips in the same subdomain section share
   a key. A chip with no matching adapter returns null (no pill, no
   noise). A lone "group" of one is silent clutter, so we drop it.

   User rules (window.LOCAL_PATH_GROUPERS from config.local.js) are
   checked BEFORE built-ins so personal overrides always win.

   Adapter shape:
     { hostname, extract(urlObj) → { key, label } | null }
     { hostnameEndsWith, extract(urlObj) → { key, label } | null }

   Multiple adapters can match the same hostname — the first one to
   return a non-null result wins. That's how Jira and Confluence can
   share the atlassian.net host: whichever path pattern hits first.
   ================================================================ */

const BUILT_IN_PATH_GROUPERS = [
  // GitHub: /{owner}/{repo}/... → group by "owner/repo".
  // RESERVED owners are GitHub's top-level routes (not user/org names)
  // so they can't produce spurious groups like "settings/billing".
  {
    hostname: 'github.com',
    extract: (u) => {
      // Capture up to the fourth path segment. The third segment
      // classifies the page area (pull / issues / commits / code);
      // the fourth distinguishes a specific item (a PR number, an
      // issue number) from the browsing list at that path — e.g.
      // /pull/1234 (action item) vs /pulls?q=… (browse all PRs).
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/)
      if (!m) return null
      const RESERVED = new Set([
        'orgs',
        'settings',
        'notifications',
        'marketplace',
        'explore',
        'pulls',
        'issues',
        'search',
        'login',
        'join',
        'about',
        'new',
        'topics',
        'trending',
        'collections',
        'events',
        'sponsors',
        'codespaces',
        'account'
      ])
      if (RESERVED.has(m[1])) return null
      const label = `${m[1]}/${m[2]}`
      const sub = m[3] || ''
      const item = m[4] || ''
      // Category: used by render.js to order chips within a cluster so
      // PRs sit together, issues sit together, etc. — and (for PRs)
      // to split the cluster into a dedicated "PRs" sub-section with
      // its own display limit. `other` covers the repo homepage plus
      // pages like /actions, /releases, /wiki.
      //
      // IMPORTANT: `/pulls?q=…` (the browse-all-PRs list) is NOT a
      // PR — it's a browsing page. Only /pull/<N> (singular + item)
      // counts as a PR. Same rationale could apply to /issues/<N>
      // vs /issues?q=… but we leave issues unsplit for now since
      // they don't get their own sub-cluster anyway.
      let category = 'other'
      if (sub === 'pull' && item) category = 'pull'
      else if (sub === 'issues') category = 'issue'
      else if (sub === 'commits' || sub === 'commit') category = 'commit'
      else if (sub === 'blob' || sub === 'tree') category = 'code'
      return { key: label, label, category }
    }
  },

  // Atlassian Jira: /browse/PROJ-N → group by project key prefix.
  // Only /browse/ carries a project in its URL; list views like
  // /jira/for-you or /issues?jql=... stay ungrouped (no signal).
  {
    hostnameEndsWith: '.atlassian.net',
    extract: (u) => {
      const m = u.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+)-\d+/)
      if (!m) return null
      return { key: `jira:${m[1]}`, label: m[1] }
    }
  },

  // Atlassian Confluence: /wiki/spaces/<SPACE>/... → group by space.
  {
    hostnameEndsWith: '.atlassian.net',
    extract: (u) => {
      const m = u.pathname.match(/^\/wiki\/spaces\/([^/]+)/)
      if (!m) return null
      return { key: `wiki:${m[1]}`, label: m[1] }
    }
  },

  // Contentful: /spaces/<SPACE>/environments/<ENV>/... → group by env.
  // Environment is the axis that actually varies across tabs (dev2,
  // master, prod); the space is usually constant for a given user.
  {
    hostname: 'app.contentful.com',
    extract: (u) => {
      const m = u.pathname.match(/^\/spaces\/([^/]+)\/environments\/([^/]+)/)
      if (!m) return null
      return { key: `${m[1]}/${m[2]}`, label: m[2] }
    }
  },

  // Figma: /design/<fileId>/<decodedName> (and /file/ for legacy).
  // Decode the slug into a human-readable label — figma URLs already
  // carry the file name, just URL-encoded with hyphens/underscores.
  {
    hostname: 'www.figma.com',
    extract: (u) => {
      const m = u.pathname.match(/^\/(?:design|file)\/([^/]+)\/([^/?]+)/)
      if (!m) return null
      let label
      try {
        label = decodeURIComponent(m[2]).replace(/[_-]+/g, ' ').trim()
      } catch {
        label = m[2]
      }
      return { key: m[1], label: label || m[1] }
    }
  },

  // Reddit: /r/<subreddit>/... → group by subreddit.
  {
    hostname: 'www.reddit.com',
    extract: (u) => {
      const m = u.pathname.match(/^\/r\/([^/]+)/)
      if (!m) return null
      return { key: `r/${m[1]}`, label: `r/${m[1]}` }
    }
  }
]

export function resolvePathGroup(url) {
  if (!url) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const rules = [...(window.LOCAL_PATH_GROUPERS || []), ...BUILT_IN_PATH_GROUPERS]
  for (const rule of rules) {
    const hostMatch = rule.hostname ? parsed.hostname === rule.hostname : rule.hostnameEndsWith ? parsed.hostname.endsWith(rule.hostnameEndsWith) : false
    if (!hostMatch) continue
    try {
      const result = rule.extract(parsed)
      if (result && result.key && result.label) return result
    } catch {
      // Adapter threw on an unexpected URL shape — treat as no match.
    }
  }
  return null
}
