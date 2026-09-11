# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-11

### Changed

- **dsh 支持下限抬到 `>= 0.1.5-rc.2`**（peer floors：`dsh-settings` / `dsh-skill`；README 同步）。dev 闭包随 0.1.5-rc.2 线（0.1.5 是 rc.1 的纯版本重钉、代码零差异）。

## [0.4.2] - 2026-09-09

### Changed

- 内置 skill 改名：`dsh-llm-proxy` → `dsh-llm-proxy-config`（生态统一：配置/使用指南类 skill 一律以 `-config` 结尾）。skill 为进程内注册、无落盘状态——更新包并重启 dsh 即自动切换，旧斜杠名不再解析；手动安装副本的路径同步为 `~/.dsh/skills/dsh-llm-proxy-config`（README 已更新）。
## [0.4.1] - 2026-09-05

### Changed

- README 新增「卸载」一节：`dsh plugin remove` 命令与宿主自动清理范围（bundles 条目 + patch 层）；说明插件自身不在磁盘上留状态（无 fs 写入，环境变量只读不写，undici/fetch 接管的 dispose 对称且经 `test/dispose.test.mjs` 测试），唯一残留是手动安装的 skill（`~/.dsh/skills/dsh-llm-proxy` 与 `~/.agents/skills/` 条目），需手工删除。
- boot 冒烟（`scripts/smoke-boot.mjs`）新增卸载环节：boot 证明之后执行 `dsh plugin --profile smoke remove`，并断言组合树已回到 stock 形态（再次 `--dump-config` 中插件 id 消失）；同时补上缺失的 `smoke` npm script（`package.json`）。
