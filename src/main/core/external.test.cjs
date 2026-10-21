const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const ts = require('typescript')
const calls = []
const moduleUnderTest = { exports: {} }
const output = ts.transpileModule(readFileSync(join(__dirname, 'external.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
new Function('require', 'module', 'exports', output)(() => ({ shell: {
  openExternal: async (url) => calls.push(url), openPath: async () => ''
} }), moduleUnderTest, moduleUnderTest.exports)
const { openExternalSafe } = moduleUnderTest.exports

test('safety report opens a user-composed message to the single published contact', async () => {
  await openExternalSafe('mailto:erzen@quad-labs.com?subject=Gamekins%20safety%20report&body=I%20want%20to%20report')
  assert.equal(calls.at(-1), 'mailto:erzen@quad-labs.com?subject=Gamekins%20safety%20report&body=I%20want%20to%20report')
})
test('mail cannot add recipients, attachments, or other email destinations', async () => {
  for (const url of ['mailto:other@example.com', 'mailto:erzen@quad-labs.com?cc=other@example.com',
    'mailto:erzen@quad-labs.com?bcc=other@example.com', 'mailto:erzen@quad-labs.com?attachment=/private/log',
    'mailto:erzen@quad-labs.com,other@example.com', 'mailto:erzen@quad-labs.com#other',
    'javascript:alert(1)', 'file:///private/log']) {
    const before = calls.length
    await assert.rejects(openExternalSafe(url))
    assert.equal(calls.length, before)
  }
})
test('normal web links remain available and embedded credentials remain refused', async () => {
  await openExternalSafe('https://www.epicgames.com/help/')
  assert.equal(calls.at(-1), 'https://www.epicgames.com/help/')
  await assert.rejects(openExternalSafe('https://user:secret@example.com'))
})
