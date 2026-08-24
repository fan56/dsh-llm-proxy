import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as undici from 'undici'
import { createProxyRouterDispatcher, resolveRoute, withUndiciErrorListener } from '../lib/router.js'

// Probe dispatcher: records the origins routed through it; never performs I/O.
class Probe extends undici.Dispatcher {
  constructor(name) {
    super()
    this.name = name
    this.calls = []
    this.closed = false
    this.destroyed = false
  }
  dispatch(options, handler) {
    this.calls.push(options.origin instanceof URL ? options.origin.origin : String(options.origin))
    return true
  }
  async close() {
    this.closed = true
  }
  async destroy() {
    this.destroyed = true
  }
}

const HANDLER = {}

function dispatchTo(router, origin) {
  router.dispatch({ origin, path: '/', method: 'GET' }, HANDLER)
}

test('resolveRoute picks the first matching entry', () => {
  const entries = [
    { match: '*.volces.com', proxy: 'http://127.0.0.1:7891' },
    { match: 'a.volces.com', proxy: 'http://127.0.0.1:7892' },
  ]
  const hit = resolveRoute(entries, 'https://a.volces.com')
  assert.deepEqual(hit, { kind: 'llm', index: 0, proxyUrl: 'http://127.0.0.1:7891' })
  assert.deepEqual(resolveRoute(entries, 'https://other.example.com'), { kind: 'system' })
})

test('llm hits go to the entry proxy, misses go to the system fallback', () => {
  const llmProbe = new Probe('llm')
  const sysProbe = new Probe('system')
  const router = createProxyRouterDispatcher(
    [
      { match: 'api.deepseek.org', proxy: 'http://127.0.0.1:7890' },
      { match: '*.volces.com', proxy: 'http://127.0.0.1:7891' },
    ],
    {
      systemDispatcher: sysProbe,
      proxyFactory: (proxyUrl) => {
        assert.ok(proxyUrl.startsWith('http://127.0.0.1'))
        return llmProbe
      },
    },
  )

  dispatchTo(router, 'https://api.deepseek.org')
  dispatchTo(router, 'https://ark.volces.com')
  dispatchTo(router, 'https://api.openai.com')

  assert.deepEqual(llmProbe.calls, ['https://api.deepseek.org', 'https://ark.volces.com'])
  assert.deepEqual(sysProbe.calls, ['https://api.openai.com'])
})

test('empty list routes everything to the system fallback', () => {
  const sysProbe = new Probe('system')
  const router = createProxyRouterDispatcher([], {
    systemDispatcher: sysProbe,
    proxyFactory: () => {
      throw new Error('no proxy should be created for an empty list')
    },
  })
  dispatchTo(router, 'https://api.deepseek.org')
  assert.deepEqual(sysProbe.calls, ['https://api.deepseek.org'])
})

test('URL origins route identically to string origins', () => {
  const llmProbe = new Probe('llm')
  const sysProbe = new Probe('system')
  const router = createProxyRouterDispatcher(
    [{ match: 'api.deepseek.org', proxy: 'http://127.0.0.1:7890' }],
    { systemDispatcher: sysProbe, proxyFactory: () => llmProbe },
  )
  router.dispatch({ origin: new URL('https://api.deepseek.org'), path: '/', method: 'GET' }, HANDLER)
  router.dispatch({ origin: new URL('https://api.openai.com'), path: '/', method: 'GET' }, HANDLER)
  assert.deepEqual(llmProbe.calls, ['https://api.deepseek.org'])
  assert.deepEqual(sysProbe.calls, ['https://api.openai.com'])
})

test('close tears down the system fallback and cached proxies once each', async () => {
  const sysProbe = new Probe('system')
  const proxies = [new Probe('p0'), new Probe('p1')]
  let created = 0
  const router = createProxyRouterDispatcher(
    [
      { match: 'a.example.com', proxy: 'http://127.0.0.1:7890' },
      { match: 'b.example.com', proxy: 'http://127.0.0.1:7891' },
    ],
    { systemDispatcher: sysProbe, proxyFactory: () => proxies[created++] },
  )
  dispatchTo(router, 'https://a.example.com')
  dispatchTo(router, 'https://b.example.com')
  dispatchTo(router, 'https://a.example.com') // cache reuse: no third creation
  assert.equal(created, 2)

  await router.close()
  assert.equal(sysProbe.closed, true)
  for (const proxy of proxies) assert.equal(proxy.closed, true)
})

test('withUndiciErrorListener swallows bare mid-stream error events', () => {
  const probe = withUndiciErrorListener(new Probe('guarded'))
  assert.doesNotThrow(() => probe.emit('error', new Error('mid-stream abort')))
})

test('factory exit wraps the router with the undici error listener', () => {
  const sysProbe = new Probe('system')
  const router = createProxyRouterDispatcher(
    [{ match: 'api.deepseek.org', proxy: 'http://127.0.0.1:7890' }],
    { systemDispatcher: sysProbe, proxyFactory: () => new Probe('llm') },
  )
  // The router performs no I/O today, but it is an EventEmitter; a stray
  // 'error' must never crash the host process.
  assert.equal(router.listenerCount('error'), 1)
  assert.doesNotThrow(() => router.emit('error', new Error('unexpected router error')))
})

test('default construction works without injected deps', async () => {
  const router = createProxyRouterDispatcher([{ match: 'direct.invalid', proxy: 'http://127.0.0.1:1' }])
  await assert.doesNotReject(() => router.close())
})
