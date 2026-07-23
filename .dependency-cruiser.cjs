/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  extends: 'dependency-cruiser/configs/recommended.cjs',
  forbidden: [
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['[.]d[.]ts$', '^src/extension/(?:filter-focus-boot|manifest)[.]ts$']
      },
      to: {}
    },
    {
      name: 'source-does-not-depend-on-tests',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^tests/' }
    },
    {
      name: 'extension-does-not-depend-on-ui',
      severity: 'error',
      from: { path: '^src/extension/' },
      to: { path: '^src/(?:components|hooks)/' }
    },
    {
      name: 'library-does-not-depend-on-ui',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/(?:components|hooks)/' }
    },
    {
      name: 'hooks-do-not-depend-on-components',
      severity: 'error',
      from: { path: '^src/hooks/' },
      to: { path: '^src/components/' }
    }
  ],
  options: {
    tsConfig: {
      fileName: 'tsconfig.json'
    },
    tsPreCompilationDeps: true,
    skipAnalysisNotInRules: true
  }
}
