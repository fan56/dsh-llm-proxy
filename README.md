# dsh-llm-proxy

dsh 插件：**SYSTEM proxy + LLM 分流代理**。通过一个进程级 undici 路由 Dispatcher，
把 LLM 流量按配置列表分流到指定代理，其余流量走系统代理（启动环境变量），都没配则直连。

## 优先级语义

```
LLM 列表命中 > SYSTEM proxy（env 语义）> 直连
```

- 请求 origin 命中 `llmProxy` 列表条目 → 走该条目指定的代理（undici `ProxyAgent`）
- 未命中 → 走共享的 undici `EnvHttpProxyAgent`，它自己处理
  `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`
  （大小写均兼容）——即标准 env 代理语义
- SYSTEM 也未配置 → 直连

> 环境变量**只读不写**：插件不会修改 `process.env.HTTP_PROXY`——对已启动进程无意义。

## 安装

```bash
# 方式一：作为 npm 插件加入 profile
dsh plugin add @aiwayds/dsh-llm-proxy   # 或在 settings.yaml 的 plugins 里声明

# 方式二：手动 patch 挂载（本包自带 cordis.patch.yml）
# 在 profile 的 bundles 中插入：
#   - id: dsh-llm-proxy
#     name: '@aiwayds/dsh-llm-proxy'
```

> **要求 dsh >= 0.1.2-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

> ⚠️ 最低宿主要求：0.2.0 起本插件声明 `inject: ['skills']`，要求宿主 dsh 提供 skills
> 服务（`@deepseek-ai/dsh-skill` 0.1.1-rc 系列+）。无该服务的旧宿主上，本插件（含代理
> 路由功能）不会加载。

> 发布状态：本包已发布到 npm（0.2.0，自带内置 skill），方式一
> `dsh plugin add @aiwayds/dsh-llm-proxy` 即可直接用。

## 卸载

```bash
dsh plugin --profile <profile> remove @aiwayds/dsh-llm-proxy
```

宿主自动清理：profile 清单里的 `dsh.profile.bundles` 条目被摘除，本包的 patch 层随之卸下。

插件自身**不在磁盘上留下任何状态**——不写任何文件，环境变量只读不写；进程级 undici/fetch 全局接管的拆除是对称且经过测试的（`test/dispose.test.mjs` 覆盖 dispose 后 globals 还原与 HMR 窗口），dispose 干净。

会留存的只有**手动安装的 skill**（见上文 Skill 一节），需手工删除：

```bash
rm ~/.dsh/skills/dsh-llm-proxy    # 手动拷贝/软链的副本
rm -r ~/.agents/skills/dsh-llm-proxy   # npx skills add 装出的条目
```

## Skill（内置使用指南）

本仓库自带一个 dsh skill（`skills/dsh-llm-proxy/SKILL.md`）：面向 agent 的配置 + 排障
使用指南，frontmatter `description` 内嵌触发词（dsh 代理、HTTP 代理、LLM 分流、llmProxy、
407、CONNECT 挂起、SOCKS、NODE_USE_ENV_PROXY 等），进入每会话模型目录用于路由。三种获取方式：

1. **随插件自动注册（零操作）**：通过 npm 包或 bundle（cordis.patch.yml）挂载本插件后，
   skill 随插件 `apply()` 自动注册——进入每会话 skill 目录（`<available_skills>`，
   frontmatter `description` 供模型路由），`/dsh-llm-proxy` 手势可直接调出指南（已实测可用）。
2. **GitHub 安装（不装插件，只要 skill）**：

   ```bash
   npx skills add fan56/dsh-llm-proxy   # 安装到 ~/.agents/skills/
   ```

3. **手动**：`git clone` 本仓库后，把 `skills/dsh-llm-proxy/` 拷贝或软链到 `~/.dsh/skills/`：

   ```bash
   git clone https://github.com/fan56/dsh-llm-proxy.git
   ln -s "$(pwd)/dsh-llm-proxy/skills/dsh-llm-proxy" ~/.dsh/skills/dsh-llm-proxy
   ```

⚠️ 铁律：本包的 `@deepseek-ai/*` 只声明在 **peerDependencies**
（devDependencies 保留供本地构建）。请勿把它们挪进 dependencies——那会装出第二份
cordis 闭包，导致双实例崩溃（详见 dsh 生态 link-dsh-closure 机制）。

## 配置入口（settings.yaml 命名空间段）

dsh 插件的用户配置唯一入口是 **settings.yaml 里按插件 id 命名的命名空间段**。本插件通过
`@deepseek-ai/dsh-settings`（要求 `>=0.1.2-rc.1`）settings provider 的
`installSection` 注册了 `dsh-llm-proxy` 命名空间
（与 harness 内置插件 `llm-deepseek` 的 `llm-deepseek:` 段同机制），所以请在
`~/.dsh/settings.yaml` 写：

```yaml
dsh-llm-proxy:
  enabled: true                    # 总开关，默认 true；false 时完全不动全局
  systemMode: env                  # 'env'（默认，读环境变量）| 'off'（全部直连，仅 llmProxy 生效）
  llmProxy:                        # 匹配列表，按顺序首条命中生效
    - match: "api.deepseek.org"    # 域名精确匹配（含任意端口）
      proxy: "http://127.0.0.1:7890"
    - match: "*.volces.com"        # 通配：volces.com 本身 + 任意子域
      proxy: "http://127.0.0.1:7891"
    - match: "https://api.openai.com"  # 完整 origin 精确匹配（大小写不敏感）
      proxy: "http://127.0.0.1:7892"
```

要点：

- **顶层键必须是 `dsh-llm-proxy:`**（与插件 id 一致）。写其他键（如 `llm-proxy:`）不会
  被读到，静默失效。
- 编辑 settings.yaml **热生效**：settings provider 发布变更后，插件会拆掉旧 router、按新
  配置重建，无需重启。
- bundle entry config（`cordis.patch.yml` insert 行的 `config:`）作为 base 层仍然有效；
  settings.yaml 段覆盖其上的同名键。
- 未挂载 settings 服务的宿主自动回退到 entry config，插件照常工作。

### match 规则

| 写法 | 含义 |
|------|------|
| `api.example.com` | host 精确匹配，**任意端口**都算命中 |
| `api.example.com:8443` | host + 显式端口必须相等（https 默认 443 / http 默认 80 会补全比较） |
| `*.example.com` | `example.com` 本身及任意层级子域 |
| `https://api.example.com` | 完整 origin 精确匹配（scheme 也要一致） |

匹配全部大小写不敏感、纯词法比较（无 DNS/IO）。IDN 域名在匹配前统一归一化为 punycode
（`中文.com` 与 `xn--fiq228c.com` 两种写法等价，pattern 和 origin 两侧对称处理）。
实现为纯函数（`src/match.ts`），有完整单测。

### proxy 协议限制

undici `ProxyAgent` 只支持 **http:// 与 https://** 上游代理。
`socks5://` 等 schema 在启动校验时直接报错（fail-fast），README 明说：**SOCKS 不支持**。

## 实现要点

- service start 时创建自定义 undici 路由 Dispatcher 并 `setGlobalDispatcher(router)`；
  router 的 `dispatch()` 按 origin 分流：命中 → 该条的 `ProxyAgent`（按 URL 缓存复用）；
  未命中 → 共享 `EnvHttpProxyAgent`（或 `systemMode: off` 时直连 `Agent`）。
- **照抄 pi-src 生产模板的防御细节**：
  - `undici.install?.()` 防 Node 内建 fetch 与 npm undici 版本偏斜 bug
    （Node 26 bundled fetch 经 npm undici dispatcher 不解压导致 `response.json()`
    失败）；用 pristine/owned 双守卫只在未被替换时 install。
  - undici Client 中途断流会发裸 `error` 事件导致 unhandled crash——对本插件创建的
    每个 dispatcher 挂 EventEmitter 级 error 兜底 listener（与 pi-src
    `http-dispatcher.ts` 同款机制，覆盖进程内所有由本插件创建的 dispatcher）。
- **HMR 重载窗口闭环**：接管状态（原始 dispatcher/fetch + 活跃层列表）存放在
  `Symbol.for` 共享槽位，跨模块副本可见。cordis `Group.update` 先 create 后 remove、
  vendor HMR 先 re-import 后 dispose——新版 apply 可能发生在旧版 dispose 之前；
  dispose 只摘除自己那一层，把 globals 还给最近的存活层，绝不打掉别人的路由器。
- dispose（cordis effect 语义）时**非阻塞拆除**：先把 globals 还回去（新请求立即不再
  进入旧 router），再后台 fire-and-forget 地 `close()` 排空在途请求——长 LLM 流式响应
  不会拖住热重载。
- proxy URL 中可能出现的 userinfo 凭证（`user:pass@host`）在日志/error message 里一律
  脱敏为 `***@host`。
- 与 `NODE_USE_ENV_PROXY` 官方姿势的关系：本插件是等价替代——无需该变量、无需重启，
  对新请求即时生效，且额外提供 LLM 分流能力。

## 手动 e2e 验证（CI 无网，不做真实请求测试）

```bash
# 1. 配一个本地回显代理（如 clash/mihomo 的 mixed-port 7890）
export HTTPS_PROXY=http://127.0.0.1:7890
# 2. settings.yaml 配 dsh-llm-proxy 段，把某个 API 域名指到另一端口
# 3. 启动 dsh 后发起对话，观察代理访问日志：
#    - llmProxy 命中域名的请求出现在该条代理日志里
#    - 其他外网请求出现在 7890 日志里
# 4. unset HTTPS_PROXY 重启 → 只有 llmProxy 命中的流量走代理，其余直连
```

## 开发

```bash
npm run build   # tsc -> lib/
npm run check   # tsc --noEmit
npm test        # node --test（match / router 探针分流 / config 边界 / skill 注册 /
                # dispose 对称性 / e2e 全链路：apply → 全局 fetch 分流 → dispose 恢复 + HMR 窗口回归）
```
