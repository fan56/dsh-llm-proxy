import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, redactProxyUrl, resolveConfig } from '../lib/index.js'

test('defaults: enabled=true, systemMode=env, empty llmProxy', () => {
  const policy = resolveConfig(undefined)
  assert.equal(policy.enabled, true)
  assert.equal(policy.systemMode, 'env')
  assert.deepEqual([...policy.llmProxy], [])
  const empty = resolveConfig({})
  assert.equal(empty.enabled, true)
  assert.equal(empty.systemMode, 'env')
  assert.deepEqual([...empty.llmProxy], [])
})

test('entries are trimmed and frozen', () => {
  const policy = resolveConfig({
    systemMode: 'off',
    llmProxy: [{ match: '  api.deepseek.org ', proxy: ' http://127.0.0.1:7890 ' }],
  })
  assert.deepEqual([...policy.llmProxy], [{ match: 'api.deepseek.org', proxy: 'http://127.0.0.1:7890' }])
  assert.equal(Object.isFrozen(policy), true)
  assert.equal(Object.isFrozen(policy.llmProxy), true)
})

test('unknown config keys are rejected', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key "nope"/)
})

test('invalid values are rejected with a named error', () => {
  assert.throws(() => resolveConfig({ systemMode: 'auto' }), /systemMode/)
  assert.throws(() => resolveConfig({ llmProxy: [{ match: '', proxy: 'http://x' }] }), /llmProxy\[0\]\.match/)
  assert.throws(() => resolveConfig({ llmProxy: [{ match: 'a.com', proxy: '' }] }), /llmProxy\[0\]\.proxy/)
  assert.throws(() => resolveConfig({ llmProxy: [{ match: 'a.com', proxy: 'not-a-url' }] }), /valid URL/)
})

test('socks proxies are rejected at startup with an explicit reason', () => {
  assert.throws(
    () => resolveConfig({ llmProxy: [{ match: '*.volces.com', proxy: 'socks5://127.0.0.1:1080' }] }),
    /SOCKS is not supported/,
  )
})

test('proxy URLs with credentials are redacted for logs and error messages', () => {
  assert.equal(redactProxyUrl('http://user:secret@127.0.0.1:7890'), 'http://***:***@127.0.0.1:7890')
  assert.equal(redactProxyUrl('http://user@127.0.0.1:7890'), 'http://***@127.0.0.1:7890')
  assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  // Unparsable input still gets a best-effort credential masking.
  assert.equal(redactProxyUrl('not a url but user:pass@host'), 'not a url but ***@host')
})

test('validation errors never echo proxy credentials', () => {
  assert.throws(
    () => resolveConfig({ llmProxy: [{ match: 'a.com', proxy: 'socks5://user:hunter2@127.0.0.1:1080' }] }),
    (error) => !String(error).includes('hunter2'),
  )
})

test('static Config schema resolves every field to a volatile reference with defaults', () => {
  const config = Config({})
  assert.equal(typeof config.enabled.get, 'function')
  assert.equal(typeof config.systemMode.get, 'function')
  assert.equal(typeof config.llmProxy.get, 'function')
  assert.equal(config.enabled.get(), true)
  assert.equal(config.systemMode.get(), 'env')
  assert.deepEqual([...config.llmProxy.get()], [])
})

test('Config({...}) carries the given values through live volatile references', () => {
  const config = Config({
    enabled: false,
    systemMode: 'off',
    llmProxy: [{ match: 'a.com', proxy: 'http://127.0.0.1:7890' }],
  })
  assert.equal(config.enabled.get(), false)
  assert.equal(config.systemMode.get(), 'off')
  assert.deepEqual([...config.llmProxy.get()], [{ match: 'a.com', proxy: 'http://127.0.0.1:7890' }])
  // Snapshots are deep-frozen, mirroring the host's volatile reference protocol.
  assert.equal(Object.isFrozen(config.llmProxy.get()), true)
})

test('schema-resolved values agree with resolveConfig (the apply() read path)', () => {
  const config = Config({ llmProxy: [{ match: ' x.com ', proxy: ' http://127.0.0.1:3 ' }] })
  const policy = resolveConfig({
    enabled: config.enabled.get(),
    systemMode: config.systemMode.get(),
    llmProxy: config.llmProxy.get(),
  })
  assert.equal(policy.enabled, true)
  assert.equal(policy.systemMode, 'env')
  assert.deepEqual([...policy.llmProxy], [{ match: 'x.com', proxy: 'http://127.0.0.1:3' }])
})
