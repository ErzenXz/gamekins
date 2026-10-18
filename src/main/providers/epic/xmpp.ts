// Minimal XMPP-over-WebSocket client (RFC 7395) for Epic's presence and chat service:
// SASL PLAIN with the account id + access token, resource bind, presence, chat messages
// and pings. Each WebSocket frame carries exactly one top-level element.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export const XMPP_DOMAIN = 'prod.ol.epicgames.com'
const XMPP_URL = 'wss://xmpp-service-prod.ol.epicgames.com//'
const PING_MS = 60_000

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m)
  )
export const escapeXml = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

/** Parses one stanza. Enough XML for XMPP: elements, attributes, text, entities, CDATA. */
export function parseXml(src: string): XmlNode | null {
  let i = 0
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1].text += decode(src.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt))
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt)
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? src.length : end)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) break
    const raw = src.slice(lt + 1, gt)
    i = gt + 1
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const name = body.match(/^[^\s/]+/)?.[0] ?? ''
    const node: XmlNode = { name, attrs: {}, children: [], text: '' }
    for (const m of body.slice(name.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      node.attrs[m[1]] = decode(m[3] ?? m[4] ?? '')
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root.children[0] ?? null
}

export const child = (n: XmlNode | undefined, name: string): XmlNode | undefined =>
  n?.children.find((c) => c.name === name || c.name.endsWith(':' + name))

export interface XmppEvents {
  presence: [XmlNode]
  message: [XmlNode]
  online: []
  closed: [Error | null]
}

/** One connection. Reconnecting is the owner's job (it may need a fresh token). */
export class XmppConnection extends EventEmitter<XmppEvents> {
  private ws: WebSocket | null = null
  private ping: ReturnType<typeof setInterval> | undefined
  private stage: 'auth' | 'bind' | 'ready' = 'auth'
  private closedByUs = false
  readonly resource = `V2:launcher:WIN::${randomUUID().replace(/-/g, '').toUpperCase()}`
  jid = ''

  constructor(
    private readonly accountId: string,
    private readonly token: string
  ) {
    super()
  }

  connect(): void {
    const ws = new WebSocket(XMPP_URL, 'xmpp')
    this.ws = ws
    ws.onopen = () => this.open()
    ws.onmessage = (e) => this.receive(String(e.data))
    ws.onerror = () => undefined // 'close' follows with the details
    ws.onclose = (e) => {
      clearInterval(this.ping)
      this.ws = null
      this.emit('closed', this.closedByUs ? null : new Error(`XMPP closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`))
    }
  }

  close(): void {
    this.closedByUs = true
    clearInterval(this.ping)
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send('<presence type="unavailable"/>')
        this.send('<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>')
      }
      this.ws?.close()
    } catch {
      /* already gone */
    }
  }

  get ready(): boolean {
    return this.stage === 'ready' && this.ws?.readyState === WebSocket.OPEN
  }

  send(xml: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(xml)
  }

  private open(): void {
    this.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${XMPP_DOMAIN}" version="1.0"/>`)
  }

  private receive(data: string): void {
    const node = parseXml(data)
    if (!node) return
    const name = node.name.replace(/^stream:/, '')
    if (name === 'features') {
      if (this.stage === 'auth' && child(node, 'mechanisms')) {
        const creds = Buffer.from(`\0${this.accountId}\0${this.token}`).toString('base64')
        this.send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${creds}</auth>`)
      } else if (child(node, 'bind')) {
        this.stage = 'bind'
        this.send(
          `<iq type="set" id="bind"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${escapeXml(this.resource)}</resource></bind></iq>`
        )
      }
    } else if (name === 'success') {
      this.open() // restart the stream after authenticating
    } else if (name === 'failure') {
      this.closedByUs = false
      this.ws?.close()
    } else if (name === 'iq') {
      if (node.attrs.id === 'bind' && node.attrs.type === 'result') {
        this.jid = child(child(node, 'bind'), 'jid')?.text ?? ''
        this.send('<iq type="set" id="session"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>')
      } else if (node.attrs.id === 'session') {
        this.stage = 'ready'
        this.ping = setInterval(() => this.send(`<iq type="get" id="ping-${Date.now()}" to="${XMPP_DOMAIN}"><ping xmlns="urn:xmpp:ping"/></iq>`), PING_MS)
        this.emit('online')
      } else if (node.attrs.type === 'get' && child(node, 'ping')) {
        this.send(`<iq type="result" id="${escapeXml(node.attrs.id ?? '')}" to="${escapeXml(node.attrs.from ?? XMPP_DOMAIN)}"/>`)
      }
    } else if (name === 'presence') {
      this.emit('presence', node)
    } else if (name === 'message') {
      this.emit('message', node)
    }
  }
}
