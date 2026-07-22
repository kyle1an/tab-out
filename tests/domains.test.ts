import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDomainGroups } from '../src/extension/domain-groups.js'
import { registrableDomain, splitDomainForDisplay, subdomainPrefix } from '../src/extension/domains.js'
import type { DashboardTab } from '../src/extension/types.js'

function dashboardTab(id: number, url: string): DashboardTab {
  return {
    id,
    url,
    rawUrl: url,
    title: url,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    suspended: false
  }
}

test('registrableDomain follows complete ICANN and private suffix rules', () => {
  assert.equal(registrableDomain('docs.alpha.org.uk'), 'alpha.org.uk')
  assert.equal(registrableDomain('app.beta.com.sg'), 'beta.com.sg')
  assert.equal(registrableDomain('district.k12.ak.us'), 'district.k12.ak.us')
  assert.equal(registrableDomain('project.github.io'), 'project.github.io')
  assert.equal(registrableDomain('preview.surge.sh'), 'preview.surge.sh')
  assert.equal(registrableDomain('a.b.ck'), 'a.b.ck')
  assert.equal(registrableDomain('www.ck'), 'www.ck')
})

test('domain helpers normalize case and a DNS trailing dot without changing local hosts', () => {
  assert.equal(registrableDomain('WWW.Example.COM.'), 'example.com')
  assert.equal(registrableDomain('localhost.'), 'localhost')
  assert.equal(registrableDomain('192.168.1.1'), '192.168.1.1')
  assert.equal(registrableDomain('[::1]'), '[::1]')
  assert.deepEqual(splitDomainForDisplay('Alpha.ORG.UK.'), { name: 'alpha', suffix: '.org.uk' })
  assert.deepEqual(splitDomainForDisplay('preview.surge.sh'), { name: 'preview', suffix: '.surge.sh' })
  assert.deepEqual(splitDomainForDisplay('surge.sh'), { name: 'surge', suffix: '.sh' })
  assert.deepEqual(splitDomainForDisplay('netlify.com'), { name: 'netlify', suffix: '.com' })
  assert.equal(subdomainPrefix('WWW.Docs.Example.COM.', 'example.com.'), 'www.docs')
})

test('domain grouping never merges unrelated sites under an unlisted multi-label suffix', () => {
  const groups = buildDomainGroups([
    dashboardTab(1, 'https://docs.alpha.org.uk/report'),
    dashboardTab(2, 'https://app.beta.org.uk/settings'),
    dashboardTab(3, 'https://shop.alpha.org.uk/cart')
  ])

  assert.deepEqual(groups.map((group) => group.domain).sort(), ['alpha.org.uk', 'beta.org.uk'])
  assert.equal(groups.find((group) => group.domain === 'alpha.org.uk')?.tabs.length, 2)
})

test('domain grouping uses exact suffix data for every sibling host', () => {
  const groups = buildDomainGroups([
    dashboardTab(1, 'https://alpha.bxpkteb.test/report'),
    dashboardTab(2, 'https://beta.bxpkteb.test/settings')
  ])

  assert.deepEqual(groups.map((group) => group.domain), ['bxpkteb.test'])
  assert.equal(groups[0]?.tabs.length, 2)
})
