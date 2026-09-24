# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **迁移 dsh 0.1.7 settings 体系**（peer 地板：`dsh-settings`/`dsh-skill` `>=0.1.7-rc.1`）。插件配置从 `SettingsProvider.installSection`（settings.yaml 命名空间段 + scope 分层）迁到插件 **static Config schema**（声明即注册）：`enabled`/`systemMode`/`llmProxy` 三字段全部 `.volatile()`——设置页可编辑且**免重启热生效**（volatile-only 写入不重挂插件，router 原地重建；解析值未变的写入自动跳过重建）。热更触发由旧 settings watcher 改为订阅 `settings/document-updated`（按 entry id `dsh-llm-proxy` 过滤）。
- **旧用户值自动迁移**：旧 settings.yaml `dsh-llm-proxy:` 段名与 bundle entry id 同名、三个键均为 volatile 字段，0.1.7 宿主启动时一次性导入 profile patch，存量用户值零手工迁移。
- **依赖钉点**：peer `@deepseek-ai/dsh-settings`/`@deepseek-ai/dsh-skill` 地板抬到 `>=0.1.7-rc.1`（宿主兼容预检据此拦截旧宿主装载）；dev 钉 exact `0.1.7-rc.1`；`@deepseek-ai/cordis` 4.0.2→4.0.4、`@deepseek-ai/schemastery` 3.18.2→3.18.4（volatile 支持随此线）。
- **dsh-skill 面零改动**：`BUNDLED_SKILL_RANK`/`SkillCandidate`/`SkillDefinition`/`SkillProvider` 导出与 0.1.5 一致；出站 HTTP 代理/LLM 分流机制不受 0.1.7 Messages 变更影响（不解析报文，已核实）。内置 skill 描述同步新配置入口表述（frontmatter 与代码常量成对更新）。
- Plugin Manager 展示元数据：新增 icon.svg 与 locale/{en,zh}.json（`meta.title`/`meta.description`，官方 readPluginMeta 约定），package.json 声明 `icon` 并将两者入包。

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
