#!/usr/bin/env node
// Boot-smoke: mount the freshly built plugin into a scratch dsh profile
// (bundle patch + packed tarball) and boot it with the real dsh CLI.
//
//   1. npm pack the repo → tarball
//   2. scratch $DSH_HOME/profiles/smoke with the plugin as a file: dep and a
//      dsh.profile.bundles entry (same shape as the user's real profiles)
//   3. pnpm install
//   4. `dsh --profile smoke --dump-config` must compose the plugin into the
//      tree (mount/patch-layer proof)
//   5. a real boot under a timeout must load the plugin tree without a
//      loader error (a healthy boot is silent and survives to the kill
//      signal; a broken plugin dies within ~1s with the loader error)
//   6. `dsh plugin --profile smoke remove <pkg>` must reconcile the profile
//      tree back to stock: the bundles entry spliced, the patch layer
//      dropped, and the plugin id gone from a fresh --dump-config
//
// Coverage notes (empirical, dsh 0.1.1-rc.2 and 0.1.2-alpha.3 hosts):
// - Everything apply() does synchronously — ctx.skills.registerProvider(),
//   the entry-config router install, the global dispatcher takeover — is
//   gated hard: a throw there dies with "plugin tree failed to load".
// - The ctx.inject(['settings']) wiring is NOT judgeable from the boot: a
//   cordis inject sub-fiber that throws (missing method, schema-rejected
//   stored section) is contained silently. That seam is gated instead by
//   `npm run check` against the linked dsh closure (signature-level) plus
//   the unit suite (semantics-level). The valid settings.yaml section below
//   still exercises the real provider path as far as the boot can show.
// - The host must match the plugin's target line (CI installs dsh@alpha):
//   a mismatched older host can boot "cleanly" while the contained inject
//   error silently drops the settings integration.
//
// Exit 0 = mounted and boots clean. Temp dir is kept and printed on failure,
// removed on success.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const ownName = pkg.name // @aiwayds/dsh-llm-proxy

const work = mkdtempSync(path.join(tmpdir(), 'dsh-llm-proxy-smoke-'))
const home = path.join(work, 'dsh-home')
const profile = path.join(home, 'profiles', 'smoke')
mkdirSync(profile, { recursive: true })

function fail(message, output = '') {
  console.error(`smoke-boot: FAIL — ${message}`)
  if (output) console.error(output.split('\n').slice(0, 30).join('\n'))
  console.error(`smoke-boot: scratch kept at ${work}`)
  process.exit(1)
}

const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, encoding: 'utf8' })
if (pack.status !== 0 || pack.error) fail('npm pack failed', `${pack.stdout}\n${pack.stderr}`)
const tarball = path.join(work, pack.stdout.trim().split('\n').at(-1))

writeFileSync(path.join(profile, 'cordis.yml'), '# dsh profile root — empty; the tree is composed from the bundle patches\n[]\n')
writeFileSync(path.join(profile, 'cordis.patch.yml'), '# scratch smoke profile: no extra patch layer\n[]\n')
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-smoke',
  private: true,
  dependencies: {
    [ownName]: `file:${tarball}`,
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        ownName,
      ],
    },
  },
}, null, 2) + '\n')

// A user settings.yaml section for the plugin's namespace: with dsh-base
// mounting dsh-settings-file, the boot proves the settings seam registers and
// resolves against the real provider (an invalid registration would die at
// apply time and trip the loader-error gate below).
writeFileSync(path.join(home, 'settings.yaml'), `\
# smoke: user section consumed by the mounted dsh-llm-proxy plugin
dsh-llm-proxy:
  enabled: true
  systemMode: env
  llmProxy:
    - match: "smoke.example.test"
      proxy: "http://127.0.0.1:1"
`)

const install = spawnSync('pnpm', ['install'], { cwd: profile, encoding: 'utf8' })
if (install.status !== 0 || install.error) fail('pnpm install in the scratch profile failed', `${install.stdout}\n${install.stderr}`)

const dshEnv = { ...process.env, DSH_HOME: home }

// Phase 1 — mount proof: the composed tree must include the plugin.
const dump = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (dump.status !== 0 || dump.error) fail('dsh --dump-config failed on the scratch profile', `${dump.stdout}\n${dump.stderr}`)
if (!dump.stdout.includes(ownName)) {
  fail(`the composed profile tree does not contain ${ownName} — the bundle patch insert is broken`, dump.stdout)
}

// Phase 2 — boot proof: the plugin tree must LOAD without a loader error.
const bootSeconds = 25
const boot = spawnSync('dsh', ['--profile', 'smoke'], {
  cwd: profile,
  encoding: 'utf8',
  timeout: bootSeconds * 1000,
  killSignal: 'SIGKILL',
  env: dshEnv,
})
const output = `${boot.stdout ?? ''}\n${boot.stderr ?? ''}`
const loaderErrors = [
  /plugin tree failed to load/,
  /failed to apply loader entry/,
  /cannot get property ".*" without inject/,
  /cannot get required service/,
  /Cannot find (package|module)/,
]
const hit = loaderErrors.filter((re) => re.test(output))
if (hit.length > 0) {
  fail('the real host failed to load the plugin tree:', output.split('\n').filter((line) => hit.some((re) => re.test(line)) || /Error/.test(line)).slice(0, 15).join('\n'))
}
if (boot.signal !== 'SIGKILL' && boot.status !== 0) {
  fail(`dsh exited early with code ${boot.status} and no loader error — unexpected`, output)
}

// Phase 3 — uninstall leg: removal must reconcile the profile tree back to stock.
const remove = spawnSync('dsh', ['plugin', '--profile', 'smoke', 'remove', ownName], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (remove.status !== 0 || remove.error) fail('dsh plugin remove failed', `${remove.stdout}\n${remove.stderr}`)
const dumpAfter = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (dumpAfter.status !== 0 || dumpAfter.error) fail('dsh --dump-config failed after removal', `${dumpAfter.stdout}\n${dumpAfter.stderr}`)
if (dumpAfter.stdout.includes('dsh-llm-proxy')) {
  fail('the composed tree still contains the plugin entry after removal', dumpAfter.stdout)
}

console.log(`smoke-boot: PASS — ${ownName} composed into the scratch profile tree and booted clean in real dsh (${boot.signal === 'SIGKILL' ? `survived ${bootSeconds}s boot window` : `exited ${boot.status}`}); removal restored the stock tree`)
rmSync(work, { recursive: true, force: true })
