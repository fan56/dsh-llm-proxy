import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as undici from 'undici'
import { apply } from '../lib/index.js'

function fakeCtx() {
  const factories = []
  return {
    factories,
    // cordis semantics: ctx.effect(factory) stores a factory whose returned
    // function is the actual dispose routine.
    effect(factory, label) {
      factories.push({ factory, label })
    },
    // cordis semantics: inject runs the callback once all named services are
    // mounted. Tests run without any settings service, so it stays dormant
    // and only the entry-config layer applies.
    inject(_names, _callback) {},
    // apply() registers the bundled skill unconditionally (inject ['skills']
    // guarantees the service on real hosts); assertions live in skill.test.mjs.
    skills: {
      registerProvider(_create) {
        return () => {}
      },
    },
  }
}

async function runDispose(entry) {
  // The factory returns the dispose routine; invoke it, then await it.
  const dispose = entry.factory()
  await dispose()
}

async function disposeAll(ctx) {
  for (const entry of ctx.factories.reverse()) await runDispose(entry)
}

test('enabled=false never touches the global dispatcher or fetch', async () => {
  const before = undici.getGlobalDispatcher()
  const fetchBefore = globalThis.fetch
  const ctx = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.factories.length, 0)
  assert.equal(undici.getGlobalDispatcher(), before)
  assert.equal(globalThis.fetch, fetchBefore)
})

test('apply/dispose is symmetric on the global dispatcher', async () => {
  const before = undici.getGlobalDispatcher()
  const ctx = fakeCtx()
  apply(ctx, {})
  try {
    const router = undici.getGlobalDispatcher()
    assert.notEqual(router, before)
  } finally {
    await disposeAll(ctx)
  }
  assert.equal(undici.getGlobalDispatcher(), before)
})

test('layered applies unwind in reverse order without clobbering', async () => {
  const initial = undici.getGlobalDispatcher()
  const ctxA = fakeCtx()
  apply(ctxA, {})
  const routerA = undici.getGlobalDispatcher()

  const ctxB = fakeCtx()
  apply(ctxB, {})
  const routerB = undici.getGlobalDispatcher()
  assert.notEqual(routerB, routerA)

  await runDispose(ctxB.factories[0])
  assert.equal(undici.getGlobalDispatcher(), routerA)

  await runDispose(ctxA.factories[0])
  assert.equal(undici.getGlobalDispatcher(), initial)
})

test('a pre-existing fetch override is preserved and left alone', async () => {
  const realFetch = globalThis.fetch
  const sentinel = async () => ({})
  globalThis.fetch = sentinel
  try {
    const ctx = fakeCtx()
    apply(ctx, {})
    try {
      // install() must be skipped: fetch was deliberately overridden first.
      assert.equal(globalThis.fetch, sentinel)
    } finally {
      await disposeAll(ctx)
    }
    assert.equal(globalThis.fetch, sentinel)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('dispose returns without draining in-flight requests; close finishes in background', async () => {
  const before = undici.getGlobalDispatcher()
  const ctx = fakeCtx()
  apply(ctx, {})
  const router = undici.getGlobalDispatcher()

  // Simulate an in-flight LLM stream: close() blocks until released.
  let releaseClose
  let closeCalled = false
  router.close = () =>
    new Promise((resolve) => {
      closeCalled = true
      releaseClose = resolve
    })

  const dispose = ctx.factories[0].factory()
  await dispose() // must resolve immediately, not wait for the drain

  assert.equal(closeCalled, true)
  // Globals are handed back even though the router has not finished closing:
  // nothing new can reach it, and hot reload never stalls behind the stream.
  assert.equal(undici.getGlobalDispatcher(), before)
  releaseClose()
})
