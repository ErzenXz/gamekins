'use strict'

const targets = {
  mac: { host: 'darwin', builder: ['--mac', 'dmg'], arch: 'universal' },
  win: { host: 'win32', builder: ['--win', 'nsis'], arch: 'x64' },
  store: { host: 'win32', builder: ['--win', 'appx'], arch: 'x64' },
  linux: { host: 'linux', builder: ['--linux', 'AppImage', 'deb'], arch: 'x64' }
}

function requireValues(env, names) {
  const missing = names.filter(name => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing release configuration: ${missing.join(', ')}`)
}

function releaseConfig(target, unsigned = false, env = process.env) {
  if (!targets[target]) throw new Error('Choose a release target: mac, win, store, or linux.')
  const config = {}
  if (target === 'store') {
    requireValues(env, ['WINDOWS_STORE_IDENTITY_NAME', 'WINDOWS_STORE_PUBLISHER', 'WINDOWS_STORE_PUBLISHER_DISPLAY_NAME'])
    if (Object.entries(env).some(([name, value]) => name.startsWith('WINDOWS_STORE_') && /REPLACE|PLACEHOLDER|YOUR[ _-]/i.test(value))) {
      throw new Error('Replace Microsoft Store placeholders with the exact Partner Center identity.')
    }
    if (!/^[A-Za-z0-9.-]{3,50}$/.test(env.WINDOWS_STORE_IDENTITY_NAME) || !env.WINDOWS_STORE_PUBLISHER.startsWith('CN=')) {
      throw new Error('Invalid Microsoft Store identity name or publisher. Copy the exact values from Partner Center.')
    }
    config.appx = {
      identityName: env.WINDOWS_STORE_IDENTITY_NAME,
      publisher: env.WINDOWS_STORE_PUBLISHER,
      publisherDisplayName: env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME
    }
    // Microsoft signs Store submissions. These packages are not signed for sideloading.
    config.win = { forceCodeSigning: false, signExecutable: false }
  }
  if (target === 'mac') {
    if (unsigned) {
      config.mac = { identity: null, forceCodeSigning: false, hardenedRuntime: false, notarize: false }
    } else {
      if (env.CSC_LINK) requireValues(env, ['CSC_KEY_PASSWORD'])
      else {
        requireValues(env, ['CSC_NAME'])
        if (!env.CSC_NAME.startsWith('Developer ID Application:')) throw new Error('CSC_NAME must identify a Developer ID Application certificate.')
      }
      const notarizationMethods = [
        ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
        ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
        ['APPLE_KEYCHAIN_PROFILE']
      ]
      if (!notarizationMethods.some(names => names.every(name => env[name]?.trim()))) {
        throw new Error('Apple notarization credentials are required (Apple ID, API key, or keychain profile).')
      }
      if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('Signing cannot be disabled for a macOS release.')
    }
  }
  if (target === 'win') {
    if (unsigned) config.win = { forceCodeSigning: false, signExecutable: false }
    else {
      const prefix = env.WIN_CSC_LINK ? 'WIN_CSC' : 'CSC'
      requireValues(env, [`${prefix}_LINK`, `${prefix}_KEY_PASSWORD`])
    }
  }
  if (unsigned) {
    const artifactName = '${productName}-${version}-' + target + '-${arch}-UNSIGNED.${ext}'
    config[{ mac: 'dmg', win: 'nsis', store: 'appx', linux: 'linux' }[target]] = { ...config[{ mac: 'dmg', win: 'nsis', store: 'appx', linux: 'linux' }[target]], artifactName }
  }
  return config
}

function pnpmInvocation(execPath, nodePath, platform) {
  if (execPath && /\.(?:cjs|mjs|js)$/i.test(execPath)) return { command: nodePath, prefix: [execPath], shell: false }
  const command = execPath || (platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  return { command, prefix: [], shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(command) }
}

module.exports = { targets, releaseConfig, pnpmInvocation }
