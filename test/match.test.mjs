import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchOrigin } from '../lib/match.js'

test('exact host match, case-insensitive', () => {
  assert.equal(matchOrigin('api.deepseek.org', 'https://api.deepseek.org'), true)
  assert.equal(matchOrigin('API.DEEPSEEK.ORG', 'https://api.deepseek.org'), true)
  assert.equal(matchOrigin('api.deepseek.org', 'https://API.DEEPSEEK.ORG'), true)
  assert.equal(matchOrigin('  api.deepseek.org  ', ' https://api.deepseek.org '), true)
})

test('bare-domain wildcard matches the domain itself and subdomains', () => {
  assert.equal(matchOrigin('*.volces.com', 'https://volces.com'), true)
  assert.equal(matchOrigin('*.volces.com', 'https://ark.volces.com'), true)
  assert.equal(matchOrigin('*.volces.com', 'https://a.b.volces.com'), true)
  assert.equal(matchOrigin('*.volces.com', 'https://notvolces.com'), false)
  assert.equal(matchOrigin('*.volces.com', 'https://evil-volces.com'), false)
  assert.equal(matchOrigin('*.volces.com', 'https://volces.com.evil.io'), false)
})

test('non-wildcard pattern does not cover subdomains', () => {
  assert.equal(matchOrigin('api.deepseek.org', 'https://v2.api.deepseek.org'), false)
})

test('port matching: explicit pattern port required; no port means any port', () => {
  assert.equal(matchOrigin('api.example.com:8443', 'https://api.example.com:8443'), true)
  assert.equal(matchOrigin('api.example.com:8443', 'https://api.example.com'), false)
  assert.equal(matchOrigin('api.example.com:443', 'https://api.example.com'), true)
  assert.equal(matchOrigin('api.example.com:80', 'http://api.example.com'), true)
  assert.equal(matchOrigin('api.example.com:443', 'http://api.example.com'), false)
  // A pattern without a port intentionally matches the host on any port.
  assert.equal(matchOrigin('api.example.com', 'https://api.example.com:8443'), true)
  assert.equal(matchOrigin('api.example.com', 'https://api.example.com:443'), true)
})

test('full-origin patterns are exact matches', () => {
  assert.equal(matchOrigin('https://api.deepseek.org', 'https://api.deepseek.org'), true)
  assert.equal(matchOrigin('HTTPS://API.DEEPSEEK.ORG', 'https://api.deepseek.org'), true)
  assert.equal(matchOrigin('https://api.deepseek.org', 'https://api.openai.com'), false)
  assert.equal(matchOrigin('http://api.deepseek.org', 'https://api.deepseek.org'), false)
})

test('no hit on empty or malformed inputs', () => {
  assert.equal(matchOrigin('', 'https://api.example.com'), false)
  assert.equal(matchOrigin('   ', 'https://api.example.com'), false)
  assert.equal(matchOrigin('api.example.com', ''), false)
  assert.equal(matchOrigin('api.example.com', 'not a url %%%'), false)
})
