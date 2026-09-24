import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as undici from 'undici'
import { apply, Config } from '../lib/index.js'

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

// Minimal cordis-like context that also emulates the dsh 0.1.7 settings seam:
// inject(['settings']) runs once the service is mounted and registers the
// plugin's `settings/document-updated` listener; publishing a settings edit
// swaps the volatile values in place (the reference protocol the host uses —
// `.get()` reads whatever is current) and emits the event for the entry id,
// which is the plugin's only trigger to rejudge.
//
// The config handed to apply() carries hand-rolled volatile references with
// exactly the protocol the plugin consumes (`.get()` per field); the real
// schema path (defaults + frozen snapshots) is covered in config.test.mjs.
function fakeCtx(initial = {}) {
  const factories = []
  const listeners = []
  const values = { enabled: true, systemMode: 'env', llmProxy: [], ...initial }
  const config = {
    enabled: { get: () => values.enabled },
    systemMode: { get: () => values.systemMode },
    llmProxy: { get: () => values.llmProxy },
  }
  const ctx = {
    factories,
    listeners,
    values,
    config,
    effect(factory, label) {
      factories.push({ factory, label })
    },
    inject(_names, callback) {
      assert.deepEqual(_names, ['settings'])
      callback({
        effect: (factory, label) => ctx.effect(factory, label),
        on(event, cb) {
          assert.equal(event, 'settings/document-updated')
          listeners.push(cb)
        },
      })
    },
    // apply() registers the bundled skill unconditionally (inject ['skills']
    // guarantees the service on real hosts); detailed assertions live in
    // skill.test.mjs, this fixture only needs the seam to exist.
    skills: {
      registerProvider(_create) {
        return () => {}
      },
    },
    /**
     * Simulate a settings-page write for one settings document: swap the
     * volatile values in place, then emit `settings/document-updated` to the
     * registered listeners (ns, revision) — the same shape the real service
     * emits after a successful volatile-only write.
     */
    publishSection(section, ns = 'dsh-llm-proxy') {
      Object.assign(values, section)
      for (const cb of [...listeners]) cb(ns, 1)
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
    Config({ llmProxy: [{ match: 'hit.example.com', proxy: 'http://127.0.0.1:7890' }] }),
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

  apply(ctxA, Config({ llmProxy: [{ match: 'a.example.com', proxy: 'http://127.0.0.1:7890' }] }), internalsWith(llmA, sysA))
  const routerA = undici.getGlobalDispatcher()
  const fetchB = globalThis.fetch

  // Cordis Group.update creates the replacement BEFORE disposing the old one.
  apply(ctxB, Config({ llmProxy: [{ match: 'b.example.com', proxy: 'http://127.0.0.1:7891' }] }), internalsWith(llmB, sysB))
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

  apply(ctxA, Config({}), internalsWith(new Probe('llmA'), new Probe('sysA')))
  const routerA = undici.getGlobalDispatcher()
  const fetchA = globalThis.fetch

  apply(ctxB, Config({}), internalsWith(new Probe('llmB'), new Probe('sysB')))

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
  apply(ctx1, Config({ llmProxy: [{ match: 'one.example.com', proxy: 'http://127.0.0.1:7890' }] }), internalsWith(llm1, sys1))
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
    mod2.Config({ llmProxy: [{ match: 'two.example.com', proxy: 'http://127.0.0.1:7891' }] }),
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

test('settings edits hot-publish through volatile reference swaps without a remount', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  const llmV1 = new Probe('llmV1')
  const sys = new Probe('sys')
  const llmV2 = new Probe('llmV2')

  // No user section yet: the entry config drives routing.
  const ctx = fakeCtx({ llmProxy: [{ match: 'v1.example.com', proxy: 'http://127.0.0.1:7890' }] })
  apply(ctx, ctx.config, {
    createSystemDispatcher: () => sys,
    createProxyDispatcher: (url) => (url === 'http://127.0.0.1:7890' ? llmV1 : llmV2),
  })
  const fiberCountAtBoot = ctx.factories.length

  await fetch('https://v1.example.com/ping')
  assert.deepEqual(llmV1.calls, ['https://v1.example.com'])

  // The user edits the dsh-llm-proxy form on the settings page; the host
  // swaps the volatile references in place and announces the write through
  // `settings/document-updated` — the plugin must rebuild in place WITHOUT a
  // remount (volatile-only edits never rerun apply()).
  ctx.publishSection({ llmProxy: [{ match: 'v2.example.com', proxy: 'http://127.0.0.1:7891' }] })

  assert.equal(ctx.factories.length, fiberCountAtBoot, 'volatile-only edits must not remount the plugin')
  await fetch('https://v2.example.com/ping')
  assert.deepEqual(llmV2.calls, ['https://v2.example.com'])
  // The stale v1 rule is gone: its origin now falls through to the system probe.
  await fetch('https://v1.example.com/ping')
  assert.deepEqual(sys.calls.slice(-1), ['https://v1.example.com'])

  await disposeAll(ctx)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('document-updated events for other entries never trigger a rejudge', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  let builds = 0
  const ctx = fakeCtx({ llmProxy: [{ match: 'same.example.com', proxy: 'http://127.0.0.1:7890' }] })
  apply(ctx, ctx.config, {
    createSystemDispatcher: () => {
      builds++
      return new Probe(`sys#${builds}`)
    },
    createProxyDispatcher: () => new Probe('llm'),
  })
  const routerV1 = undici.getGlobalDispatcher()
  assert.equal(builds, 1)

  // A foreign entry's settings document changed; the listener must filter it
  // out by namespace and leave this plugin's router untouched.
  ctx.publishSection({ llmProxy: [{ match: 'other.example.com', proxy: 'http://127.0.0.1:7891' }] }, 'some-other-entry')
  assert.equal(builds, 1, 'foreign ns events must be ignored')
  assert.equal(undici.getGlobalDispatcher(), routerV1)

  await disposeAll(ctx)
  assert.equal(undici.getGlobalDispatcher(), pristineDispatcher)
  assert.equal(globalThis.fetch, pristineFetch)
})

test('a settings write resolving to unchanged values skips the rebuild', async () => {
  const pristineDispatcher = undici.getGlobalDispatcher()
  const pristineFetch = globalThis.fetch
  let builds = 0
  const ctx = fakeCtx({ llmProxy: [{ match: 'same.example.com', proxy: 'http://127.0.0.1:7890' }] })
  apply(
    ctx,
    ctx.config,
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

  // A settings write whose resolved policy is identical to the live one (the
  // document-updated event still fires) must not tear down and reinstall an
  // identical router.
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

  apply(ctx, ctx.config, internalsWith(llm, sys))
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
