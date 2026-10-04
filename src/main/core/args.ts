/** Windows CommandLineToArgvW quoting; Unix accepts single quotes as well. */
export function splitArgs(command: string): string[] {
  const result: string[] = []
  let word = '', quote = '', started = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\' && process.platform !== 'win32' && quote !== "'" && i + 1 < command.length) {
      if (!quote || ['\\', '"', '$', '`'].includes(command[i + 1])) { word += command[++i]; started = true; continue }
    }
    if (c === '\\' && (process.platform === 'win32' || quote !== "'")) {
      let count = 1
      while (command[i + 1] === '\\') { count++; i++ }
      if (command[i + 1] === '"') {
        word += '\\'.repeat(Math.floor(count / 2))
        if (count % 2) { word += '"'; i++ }
      } else word += '\\'.repeat(count)
      started = true
    } else if (c === '"' || (c === "'" && process.platform !== 'win32')) {
      if (!quote) quote = c
      else if (quote === c) quote = ''
      else word += c
      started = true
    } else if (/\s/.test(c) && !quote) {
      if (started) result.push(word)
      word = ''; started = false
    } else { word += c; started = true }
  }
  if (quote) throw new Error('Unclosed quote in launch arguments')
  if (started) result.push(word)
  return result
}
