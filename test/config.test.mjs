import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactProxyUrl, resolveConfig } from '../lib/index.js'

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
