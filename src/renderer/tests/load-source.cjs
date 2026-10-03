// Local, dependency-free verification loader. It compiles TypeScript in memory.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function installLoader(read = (file) => fs.readFileSync(file, 'utf8'), transform = (source) => source) {
  for (const extension of ['.ts', '.tsx']) {
    Module._extensions[extension] = (module, file) => {
      const source = transform(read(file), file).replaceAll('import.meta.env.DEV', 'false')
      module._compile(ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
      }, fileName: file }).outputText, file)
    }
  }
  Module._extensions['.css'] = () => undefined
  Module._extensions['.png'] = (module, file) => { module.exports = file }
}

function mockWindow() {
  global.localStorage = { getItem: () => null, setItem: () => undefined }
  global.window = {
    addEventListener: () => undefined, removeEventListener: () => undefined,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer },
    innerWidth: 1200
  }
  global.document = { documentElement: { dataset: {} } }
}

module.exports = { installLoader, mockWindow, root: path.resolve(__dirname, '../src') }
