'use strict'

const { releaseConfig } = require('./release-policy.cjs')
module.exports = {
  extends: require('node:path').resolve(__dirname, '../electron-builder.yml'),
  ...releaseConfig(process.env.GAMEKINS_RELEASE_TARGET, process.env.GAMEKINS_UNSIGNED === '1')
}
