import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as undici from 'undici'
import { apply } from '../lib/index.js'

// Probe dispatcher: records routed origins and completes the fetch lifecycle
// synchronously (microtask) so global fetch() resolves without any I/O.
class Probe extends undici.Dispatcher {
  constructor(name) {
    super()
    this.name = name
    this.calls = []
  }

  dispatch(options, handler) {
    const origin = options.origin instanceof URL ? options.origin.origin : String(options.origin)
    this.calls.push(origin)
    // undici 8 handler contract; the controller is only used for abort/pause.
    const controller = {
      abort() {},
      pause() {},
      resume() {},
    }
    queueMicrotask(() => {
      try {
        handler.onRequestStart?.(controller, null)
        handler.onResponseStart?.(controller, 200, { 'content-type': 'text/plain' }, 'OK')
        handler.onResponseData?.(controller, Buffer.from('ok'))
        handler.onResponseEnd?.(controller, {})
      } catch (error) {
        handler.onResponseError?.(controller, error)
      }
    })
    return true
  }

  async close() {}

  async destroy() {}
}

// Minimal cordis-like context that also emulates the dsh settings seam:
// inject(['settings']) runs immediately, register() layers the stored user
// section over the entry config, and publishing a section edit replays it
// through the scope watcher (the same hook the real provider fires).
function fakeCtx() {
  const factories = []
  const watchers = []
  const ctx = {
    factories,
    watchers,
    stored: undefined,
    // cordis fiber state mirror: anything below UNLOADING(5)/DISPOSED(4)
    // counts as "still loaded" for the settings helper's unload guards.
    fiber: { state: 0 },
    effect(factory, label) {
      factories.push({ factory, label })
    },
    inject(_names, callback) {
      assert.deepEqual(_names, ['settings'])
      callback({
        effect: (factory, label) => ctx.effect(factory, label),
        settings: {
          register(_ns, _schema, options) {
            return {
              get: () => ({ ...options.base, ...ctx.stored }),
              watch: (cb) => watchers.push(cb),
            }
          },
        },
      })
    },
    /** Simulate the user editing the dsh-llm-proxy section in settings.yaml. */
    publishSection(section) {
      ctx.stored = section
      // The real provider keeps its subscription; every edit re-fires it.
      for (const watcher of [...watchers]) watcher()
    },
  }
  return ctx
}

async function disposeAll(ctx) {
  for (const entry of ctx.factories.reverse()) {
    const dispose = entry.factory()
    await dispose()
  }
}

function internalsWith(llmProbe, sysProbe) {
  return {
    createSystemDispatcher: () => sysProbe,
    createProxyDispatcher: () => llmProbe,
  }
}

test('end-to-end: global fetch splits between entry proxy and system fallback, dispose restores', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const llm = new Probe('llm')
  const sys = new Probe('sys')
  const ctx = fakeCtx()

  apply(
    ctx,
    { llmProxy: [{ match: 'hit.example.com', proxy: 'http://127.0.0.1:7890' }] },
    internalsWith(llm, sys),
  )
  try {
    assert.notEqual(globalThis.fetch, pristineFetch)

    const hit = await fetch('https://hit.example.com/v1/chat')
    assert.equal(hit.status, 200)
    const miss = await fetch('https://other.example.com/v1/models')
    assert.equal(miss.status, 200)

    assert.deepEqual(llm.calls, ['https://hit.example.com'])
    assert.deepEqual(sys.calls, ['https://other.example.com'])
  } finally {
    await disposeAll(ctx)
  }

  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('HMR window (create before remove): old dispose leaves the newer layer fully intact', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const llmA = new Probe('llmA')
  const sysA = new Probe('sysA')
  const llmB = new Probe('llmB')
  const sysB = new Probe('sysB')
  const ctxA = fakeCtx()
  const ctxB = fakeCtx()

  apply(ctxA, { llmProxy: [{ match: 'a.example.com', proxy: 'http://127.0.0.1:7890' }] }, internalsWith(llmA, sysA))
  const routerA = undici.getGlobalDispatcher()
  const fetchB = globalThis.fetch

  // Cordis Group.update creates the replacement BEFORE disposing the old one.
  apply(ctxB, { llmProxy: [{ match: 'b.example.com', proxy: 'http://127.0.0.1:7891' }] }, internalsWith(llmB, sysB))
  const routerB = undici.getGlobalDispatcher()
  assert.notEqual(routerB, routerA)
  // Every install() publishes the same npm-undici fetch reference, so the
  // fetch layer is asserted behaviorally (not pristine) instead of by identity.
  assert.notEqual(globalThis.fetch, pristineFetch)

  // Old instance disposes while the new one already owns the globals.
  await disposeAll(ctxA)

  assert.equal(undici.getGlobalDispatcher(), routerB, 'new router must survive the old dispose')
  assert.equal(globalThis.fetch, fetchB, "new install's fetch must not be clobbered")

  // Routing still flows through the surviving layer.
  await fetch('https://b.example.com/ping')
  assert.deepEqual(llmB.calls, ['https://b.example.com'])
  assert.equal(llmA.calls.length, 0)

  await disposeAll(ctxB)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('reverse unwind: removing the top layer hands globals back to the live one below', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const ctxA = fakeCtx()
  const ctxB = fakeCtx()

  apply(ctxA, {}, internalsWith(new Probe('llmA'), new Probe('sysA')))
  const routerA = undici.getGlobalDispatcher()
  const fetchA = globalThis.fetch

  apply(ctxB, {}, internalsWith(new Probe('llmB'), new Probe('sysB')))

  await disposeAll(ctxB)
  assert.equal(undici.getGlobalDispatcher(), routerA, 'nearest live layer resumes ownership')
  assert.equal(globalThis.fetch, fetchA)

  await disposeAll(ctxA)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('vendor re-import window: a fresh module copy takes over and survives the old copy dispose', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const llm1 = new Probe('llm1')
  const sys1 = new Probe('sys1')

  // Instance from the original module copy.
  const ctx1 = fakeCtx()
  apply(ctx1, { llmProxy: [{ match: 'one.example.com', proxy: 'http://127.0.0.1:7890' }] }, internalsWith(llm1, sys1))
  const router1 = undici.getGlobalDispatcher()

  // Vendor HMR re-imports before disposal: a fresh module copy loads with
  // blank module-level state but must share ownership through Symbol.for.
  const mod2 = await import('../lib/index.js?copy=vendor-hmr')
  assert.notEqual(mod2.apply, apply)
  const llm2 = new Probe('llm2')
  const sys2 = new Probe('sys2')
  const ctx2 = fakeCtx()
  mod2.apply(
    ctx2,
    { llmProxy: [{ match: 'two.example.com', proxy: 'http://127.0.0.1:7891' }] },
    internalsWith(llm2, sys2),
  )
  const router2 = undici.getGlobalDispatcher()
  const fetch2 = globalThis.fetch
  assert.notEqual(router2, router1)
  assert.notEqual(fetch2, pristineFetch)

  // Old copy's dispose runs after the fresh copy took over.
  await disposeAll(ctx1)

  assert.equal(undici.getGlobalDispatcher(), router2, 'fresh-copy router must survive old-copy dispose')
  assert.equal(globalThis.fetch, fetch2, "fresh copy's fetch install must not be reverted")

  await fetch('https://two.example.com/ping')
  assert.deepEqual(llm2.calls, ['https://two.example.com'])

  await disposeAll(ctx2)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('settings.yaml section layers over the entry config and hot-publishes edits', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const llmV1 = new Probe('llmV1')
  const sys = new Probe('sys')
  const llmV2 = new Probe('llmV2')

  // No settings.yaml section yet: the entry config drives routing.
  const ctx = fakeCtx()
  apply(ctx, { llmProxy: [{ match: 'v1.example.com', proxy: 'http://127.0.0.1:7890' }] }, {
    createSystemDispatcher: () => sys,
    createProxyDispatcher: (url) => (url === 'http://127.0.0.1:7890' ? llmV1 : llmV2),
  })

  await fetch('https://v1.example.com/ping')
  assert.deepEqual(llmV1.calls, ['https://v1.example.com'])

  // User adds/edits the dsh-llm-proxy section in settings.yaml; the provider
  // publishes the change through the scope watcher.
  ctx.publishSection({ llmProxy: [{ match: 'v2.example.com', proxy: 'http://127.0.0.1:7891' }] })

  await fetch('https://v2.example.com/ping')
  assert.deepEqual(llmV2.calls, ['https://v2.example.com'])
  // The stale v1 rule is gone: its origin now falls through to the system probe.
  await fetch('https://v1.example.com/ping')
  assert.deepEqual(sys.calls.slice(-1), ['https://v1.example.com'])

  await disposeAll(ctx)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('settings attach with unchanged values skips the rebuild', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  let builds = 0
  const ctx = fakeCtx()
  apply(
    ctx,
    { llmProxy: [{ match: 'same.example.com', proxy: 'http://127.0.0.1:7890' }] },
    {
      createSystemDispatcher: () => {
        builds++
        return new Probe(`sys#${builds}`)
      },
      createProxyDispatcher: () => new Probe('llm'),
    },
  )
  const routerV1 = undici.getGlobalDispatcher()
  assert.equal(builds, 1)

  // Attaching the settings scope fires onChange even though the layered
  // section resolves to exactly the entry base layer; the identical resolved
  // policy must not tear down and reinstall the router.
  ctx.publishSection({ llmProxy: [{ match: 'same.example.com', proxy: 'http://127.0.0.1:7890' }] })
  assert.equal(builds, 1, 'unchanged resolved policy must skip the rebuild')
  assert.equal(undici.getGlobalDispatcher(), routerV1, 'the live router must stay in place')

  // A real value change still rebuilds.
  ctx.publishSection({ llmProxy: [{ match: 'other.example.com', proxy: 'http://127.0.0.1:7891' }] })
  assert.equal(builds, 2)
  assert.notEqual(undici.getGlobalDispatcher(), routerV1)

  await disposeAll(ctx)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('enabled=false through settings disables routing; flipping back restores it', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const llm = new Probe('llm')
  const sys = new Probe('sys')
  const ctx = fakeCtx()

  apply(ctx, {}, internalsWith(llm, sys))
  const routerV1 = undici.getGlobalDispatcher()
  assert.notEqual(routerV1, pristineDispatcher)

  ctx.publishSection({ enabled: false })
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher, 'disabled section must detach the router')
  assert.equal(globalThis.fetch, pristineFetch)

  ctx.publishSection({ enabled: true })
  assert.notEqual(undici.getGlobalDispatcher(), pristineDispatcher, 're-enabled section must take over again')

  await disposeAll(ctx)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})
