// DOM-free React server-render CPU comparison. This is not a browser paint/mount benchmark.
process.env.NODE_ENV = 'production'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { installLoader, mockWindow, root } = require('./load-source.cjs')
const before = process.argv.includes('--before')
const cwd = path.resolve(root, '../../..')
const read = (file) => before ? execFileSync('git', ['show', 'HEAD:' + path.relative(cwd, file).replaceAll('\\', '/')], { cwd, encoding: 'utf8' }) : fs.readFileSync(file, 'utf8')
installLoader(read, (source, file) => {
  if (before && file.endsWith('libraryData.ts')) {
    // The old implementation eventually mounts the entire grid. Compare that steady state.
    source = source.replace(/export function useProgressiveCount\([\s\S]*?\n}\n/, 'export function useProgressiveCount(total: number): number { return total }\n')
  }
  return source
})
mockWindow()
global.location = { search: '?mock=many' }
const interval = global.setInterval
global.setInterval = (...args) => { const timer = interval(...args); timer.unref(); return timer }
const React = require('react')
const { renderToString } = require('react-dom/server')

async function run() {
  require(root + '/lib/devMock.ts').installDevMock()
  const games = await window.lodestar.library.get()
  if (!before) require(root + '/components/library/virtualWindow.ts').useVirtualViewport = () => ({ top: 0, bottom: 700, width: 900, capsuleWidth: 154 })
  const { GameGrid } = require(root + '/views/library/GameGrid.tsx')
  const render = () => renderToString(React.createElement(GameGrid, { games, width: 154, sort: 'alpha', jobs: new Map() }))
  for (let i = 0; i < 10; i++) render()
  const times = []
  let output
  for (let i = 0; i < 25; i++) { const start = performance.now(); output = render(); times.push(performance.now() - start) }
  times.sort((a, b) => a - b)
  console.log(JSON.stringify({ mode: before ? 'before (steady state)' : 'after (900x700 supplied viewport)', games: games.length,
    renderedCapsules: (output.match(/class="cap-wrap"/g) ?? []).length,
    medianMs: +times[12].toFixed(3), p95Ms: +times[23].toFixed(3), meanMs: +(times.reduce((a, b) => a + b) / times.length).toFixed(3) }))
}
run().catch((err) => { console.error(err); process.exitCode = 1 })
