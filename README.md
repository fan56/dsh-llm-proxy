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

⚠️ 铁律：本包的 `@deepseek-ai/*` 只声明在 **peerDependencies**
（devDependencies 保留供本地构建）。请勿把它们挪进 dependencies——那会装出第二份
cordis 闭包，导致双实例崩溃（详见 dsh 生态 link-dsh-closure 机制）。

## 配置示例（settings.yaml）

```yaml
llm-proxy:
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

### match 规则

| 写法 | 含义 |
|------|------|
| `api.example.com` | host 精确匹配，**任意端口**都算命中 |
| `api.example.com:8443` | host + 显式端口必须相等（https 默认 443 / http 默认 80 会补全比较） |
| `*.example.com` | `example.com` 本身及任意层级子域 |
| `https://api.example.com` | 完整 origin 精确匹配（scheme 也要一致） |

匹配全部大小写不敏感、纯词法比较（无 DNS/IO）。实现为纯函数（`src/match.ts`），有完整单测。

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
    失败）；用 originalGlobalFetch 双守卫只在未被替换时 install。
  - undici Client 中途断流会发裸 `error` 事件导致 unhandled crash——对本插件创建的
    每个 dispatcher 挂 EventEmitter 级 error 兜底 listener（与 pi-src
    `http-dispatcher.ts` 同款机制，覆盖进程内所有由本插件创建的 dispatcher）。
- dispose（cordis effect 语义）时恢复 original dispatcher/fetch，且只恢复自己仍持有的层
  （HMR 重载叠层时不会打掉别人的路由器），并关闭自建的全部 dispatcher。
- 与 `NODE_USE_ENV_PROXY` 官方姿势的关系：本插件是等价替代——无需该变量、无需重启，
  对新请求即时生效，且额外提供 LLM 分流能力。

## 手动 e2e 验证（CI 无网，不做真实请求测试）

```bash
# 1. 配一个本地回显代理（如 clash/mihomo 的 mixed-port 7890）
export HTTPS_PROXY=http://127.0.0.1:7890
# 2. settings.yaml 配 llmProxy 把某个 API 域名指到另一端口
# 3. 启动 dsh 后发起对话，观察代理访问日志：
#    - llmProxy 命中域名的请求出现在该条代理日志里
#    - 其他外网请求出现在 7890 日志里
# 4. unset HTTPS_PROXY 重启 → 只有 llmProxy 命中的流量走代理，其余直连
```

## 开发

```bash
npm run build   # tsc -> lib/
npm run check   # tsc --noEmit
npm test        # node --test（23 个单测：match / router 探针分流 / config 边界 / dispose 对称性）
```
