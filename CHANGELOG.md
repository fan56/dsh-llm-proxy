# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-09-05

### Changed

- README 新增「卸载」一节：`dsh plugin remove` 命令与宿主自动清理范围（bundles 条目 + patch 层）；说明插件自身不在磁盘上留状态（无 fs 写入，环境变量只读不写，undici/fetch 接管的 dispose 对称且经 `test/dispose.test.mjs` 测试），唯一残留是手动安装的 skill（`~/.dsh/skills/dsh-llm-proxy` 与 `~/.agents/skills/` 条目），需手工删除。
- boot 冒烟（`scripts/smoke-boot.mjs`）新增卸载环节：boot 证明之后执行 `dsh plugin --profile smoke remove`，并断言组合树已回到 stock 形态（再次 `--dump-config` 中插件 id 消失）；同时补上缺失的 `smoke` npm script（`package.json`）。
