'use strict'

const { spawnSync } = require('node:child_process')
const { statSync } = require('node:fs')
const { join } = require('node:path')
const { targets, releaseConfig, pnpmInvocation, releaseEnvironment } = require('./release-policy.cjs')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}

function assertFresh(file, started) {
  if (statSync(file).mtimeMs < started - 2000) throw new Error(`Stale release artifact: ${file}`)
}

function pnpm(args, env) {
  const invocation = pnpmInvocation(process.env.npm_execpath, process.execPath, process.platform)
  run(invocation.command, [...invocation.prefix, ...args], { env, shell: invocation.shell })
}

try {
  const [target, ...flags] = process.argv.slice(2)
  if (flags.some(flag => !['--unsigned', '--check', '--dir', '--arch=x64', '--arch=arm64', '--arch=universal'].includes(flag))) {
    throw new Error('Unknown option. Supported: --unsigned, --check, --dir, --arch=x64|arm64|universal.')
  }
  const unsigned = flags.includes('--unsigned')
  releaseConfig(target, unsigned)
  const archFlags = flags.filter(flag => flag.startsWith('--arch='))
  if (archFlags.length > 1) throw new Error('Specify only one architecture.')
  const arch = archFlags[0]?.split('=')[1] || targets[target].arch
  if (arch === 'universal' && target !== 'mac') throw new Error('Universal builds are macOS only.')
  if (target === 'store' && arch !== 'x64') throw new Error('The Store submission pipeline currently supports x64 only.')
  if (flags.includes('--check')) {
    console.log(`Release configuration valid: ${target}, ${arch}, ${unsigned ? 'UNSIGNED VALIDATION' : 'release'}. No build performed.`)
    process.exit(0)
  }
  if (process.platform !== targets[target].host) throw new Error(`Build ${target} on ${targets[target].host}; use its native CI runner.`)
  const env = releaseEnvironment(target, unsigned)
  const buildStarted = Date.now()
  pnpm(['exec', 'electron-vite', 'build'], env)
  pnpm(['exec', 'electron-builder', '--config', 'scripts/release-config.cjs', ...(flags.includes('--dir') ? [targets[target].builder[0], '--dir'] : targets[target].builder), `--${arch}`, '--publish', 'never'], env)
  if (target === 'mac' && !unsigned) {
    const folder = arch === 'x64' ? 'mac' : `mac-${arch}`
    const bundle = join('dist', folder, 'Gamekins.app')
    assertFresh(join(bundle, 'Contents', 'MacOS', 'Gamekins'), buildStarted)
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle])
    run('spctl', ['--assess', '--verbose', '--type', 'exec', bundle])
    run('xcrun', ['stapler', 'validate', bundle])
  }
  if (target === 'win' && !unsigned && !flags.includes('--dir')) {
    const version = require('../package.json').version
    const installer = join('dist', `Gamekins-${version}-windows-${arch}-setup.exe`)
    const executable = join('dist', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`, 'Gamekins.exe')
    for (const file of [installer, executable]) {
      assertFresh(file, buildStarted)
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; if ((Get-AuthenticodeSignature -LiteralPath $env:GAMEKINS_VERIFY_FILE).Status -ne 'Valid') { throw 'Invalid Authenticode signature' }"], { env: { ...process.env, GAMEKINS_VERIFY_FILE: file } })
    }
  }
  console.log(unsigned ? 'UNSIGNED validation artifacts only. Do not distribute as a signed release.' : 'Artifacts prepared for review. Nothing was published.')
} catch (error) {
  console.error(`Release blocked: ${error.message}`)
  process.exitCode = 1
}
