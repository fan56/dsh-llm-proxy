---
name: dsh-llm-proxy
description: "dsh 出站代理 / LLM 分流插件（@aiwayds/dsh-llm-proxy）使用指南。凡给 dsh 插件配置 HTTP 代理、LLM 出站分流，或排查代理网络问题时先读本指南：settings.yaml 顶层 `dsh-llm-proxy:` 段（enabled/systemMode/llmProxy）、llmProxy match 规则、代理 407、CONNECT 挂起、socks5 报错（SOCKS 不支持）、NODE_USE_ENV_PROXY 等价替代。触发词：dsh 代理、HTTP 代理、LLM 分流、llmProxy、llm-proxy、407、CONNECT 挂起、SOCKS、HTTPS_PROXY、NO_PROXY、出站代理、NODE_USE_ENV_PROXY。"
---

# dsh-llm-proxy 使用指南（LLM 分流代理）

> dsh 插件：**SYSTEM proxy + LLM 分流代理**。进程级 undici 路由 Dispatcher 把 LLM 流量
> 按配置列表分流到指定代理，其余流量走系统代理（启动环境变量），都没配则直连。

## 配置入口（settings.yaml 顶层命名空间段）

在 `~/.dsh/settings.yaml` 写**顶层 `dsh-llm-proxy:` 段**（与插件 id 一致，同 harness 内置
插件 `llm-deepseek:` 段机制）：

```yaml
dsh-llm-proxy:
  enabled: true                    # 总开关，默认 true；false 时完全不动全局
  systemMode: env                  # 'env'（默认，读环境变量）| 'off'（全部直连，仅 llmProxy 生效）
  llmProxy:                        # 匹配列表，按顺序首条命中生效
    - match: "api.deepseek.org"    # host 精确匹配（含任意端口）
      proxy: "http://127.0.0.1:7890"
    - match: "*.volces.com"        # 通配：volces.com 本身 + 任意子域
      proxy: "http://127.0.0.1:7891"
    - match: "https://api.openai.com"  # 完整 origin 精确匹配（大小写不敏感）
      proxy: "http://127.0.0.1:7892"
```

要点：

- 编辑 **热生效**：无需重启，插件拆旧 router 按新配置重建。
- bundle entry config（cordis.patch.yml 的 `config:`）是 base 层；settings.yaml 段覆盖其上
  同名键。未挂载 settings 服务的宿主自动回退 entry config，插件照常工作。

## 优先级语义

```
LLM 列表命中 > SYSTEM proxy（env 语义）> 直连
```

- 命中 `llmProxy` 条目 → 走该条目指定的代理（undici `ProxyAgent`）；**命中条目直接进指定
  代理，不读 env `no_proxy`**。
- 未命中 → 共享 `EnvHttpProxyAgent`：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` /
  `NO_PROXY`（大小写均兼容）；`systemMode: off` 时未命中流量一律直连。
- 环境变量**只读不写**：插件不改 `process.env.HTTP_PROXY`（对已启动进程无意义）。
- 与 `NODE_USE_ENV_PROXY` 的关系：等价替代——无需该变量、无需重启，对新请求即时生效，
  且额外提供 LLM 分流。

## match 规则

| 写法 | 含义 |
|------|------|
| `api.example.com` | host 精确匹配，**任意端口**都算命中 |
| `api.example.com:8443` | host + 显式端口必须相等（https 默认 443 / http 默认 80 会补全比较） |
| `*.example.com` | `example.com` 本身及任意层级子域 |
| `https://api.example.com` | 完整 origin 精确匹配（scheme 也要一致） |

匹配全部大小写不敏感、纯词法比较（无 DNS/IO）；IDN 域名两侧统一归一化为 punycode。

**proxy 仅支持 http:// 与 https://**（undici ProxyAgent 限制）；`socks5://` 等在启动校验
时直接报错（fail-fast）：**SOCKS 不支持**。

## 排障清单

1. **完全不生效** → 先查顶层键名：必须是 `dsh-llm-proxy:`；写成 `llm-proxy:` 等其他键
   不会被读到，**静默失效**。
2. **启动即报错** → proxy 用了 `socks5://` 等不支持的 schema；换 http(s) 代理。
3. **走了代理但目标返回 407** → 代理自身认证问题，检查代理凭证；本插件日志/error
   message 中 proxy URL 的 userinfo 一律脱敏为 `***@host`。
4. **疑似代理问题** → 先用 `curl -x <proxy> <目标URL>` 复验代理本身通不通，通了再查 dsh
   侧配置；随后按仓库 README「手动 e2e 验证」观察代理访问日志确认分流是否按预期。
