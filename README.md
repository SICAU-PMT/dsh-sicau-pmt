# dsh-sicau-pmt

给 DeepSeek Harness（dsh）用的中转站同步插件。装好之后：

- 中转上新模型，DSH 里跟着出现，不用改配置、不用等发版；
- 模型选择器里每个中转模型都有「思考强度」，可以按模型选 low / medium / high / max 之类的档位。

## 它解决什么问题

DeepSeek Harness 的思考档位是**按路由声明的能力**，不是运行时探测的：

- `@deepseek-ai/dsh-llm-pi-ai` 只把路由里每个模型显式写的 `reasoningEfforts` 交给界面；
- 没写就等于「这个模型不支持思考」，选择器里一个档位都不出现；
- 中转站（[oh-pmt-api](https://api.hhy.homes) 这类 OpenAI 兼容网关）的 `/v1/models` 只给 id、显示名、上下文长度、输出上限，没有任何思考能力字段；DSH 的模型发现类型也没有承载档位的字段，探到了也传不进选择器。

所以缺档位是客户端没声明，不是中转的问题：中转收到 `reasoning_effort` 会原样转发给上游。这个插件就在客户端把声明补齐。

还有一个容易漏的点：**光声明档位不够**。请求只有在真正「选中了档位」时才会带上 `reasoning_effort`，而这个中转不传该字段时上游完全不思考。所以插件还会给默认模型补一个默认档位，否则选择器里能选、实际用起来还是不思考。

## 它做什么

启动时同步一次，之后每隔 30 分钟再同步一次，结果都写进当前 profile 的 `cordis.patch.yml`：

1. 拉一次中转的 `/v1/models`，把路由里还没有的模型追加进去。
2. 给每个模型补 `reasoningEfforts`，以及缺失的 `contextWindow` 与 `maxTokens`。长度上限优先用网关给的 `context` / `max_output`，网关没给才用能力表（DSH 默认按 262144 上下文算，Hy3 这类只有 192k 的模型会被高估）。
3. 如果默认模型正好在这条路由上、且没指定档位，补一个该模型支持得上的档（默认 `high`）。

写入走官方 `configEditor`，和设置页保存是同一条路径：校验整份配置、原子替换、保留文件里的注释、按正常热更新流程生效。

**只加不删，只补空不覆盖。** 网关不再列出的模型留在路由里；你自己写过的 `reasoningEfforts`、`contextWindow`、`maxTokens` 一律不动；写 `reasoningEfforts: false` 表示「这个模型不思考」也会被尊重。配置已经是最新时不会重复写盘，网关也拉不到时只按能力表补，不会把模型列表清空。

## 安装

桌面版（DeepSeek Harness.app）的 profile 由应用独占，命令行 `dsh plugin` 会被拒绝，需要在应用里的 **Plugins** 页面安装：填包名、tarball 路径或 `link:<绝对目录>`，插件管理器会把它加进 `dsh.profile.bundles`。

命令行 profile 也可以手动接：

```sh
cd ~/.dsh/profiles/<profile>
pnpm add /path/to/dsh-sicau-pmt     # 或 npm publish 之后直接装包名
node -e 'const f="package.json",p=require("./"+f);p.dsh.profile.bundles.push("dsh-sicau-pmt");require("fs").writeFileSync(f,JSON.stringify(p,null,2))'
```

装完重启一次 DeepSeek Harness。首次启动写配置的同时会发出第一条请求，那一条还没带上档位，从第二条起才按新档位走。

## 配置

一般不用配。换中转、换路由名时在插件行里改：

```yaml
- id: sicau-pmt
  name: dsh-sicau-pmt
  config:
    routes: [sicau-pmt]                      # 按路由名认
    baseURLs: [https://api.hhy.homes/v1]     # 按 baseURL 认
    defaultEffort: high                      # 默认模型补哪个档；false = 不补
    refreshIntervalMs: 1800000               # 多久重新拉一次目录；0 = 只在启动时同步
```

只要路由名或 baseURL 命中一条，就会被补全。

## 能力表

`lib/sync.js` 里维护了一张按模型的能力表：档位列表、能不能真正关掉思考、上下文窗口、输出上限。

关不掉思考的模型（GLM、MiniMax、Hy 系：传 `none` 仍会吐出思考内容）不给 `off` 档，避免界面显示「已关闭」而实际还在思考；能关掉的（DeepSeek 系、Kimi-K3）给 `off`，关闭档发的是 `reasoning_effort: none`。

网关给走免费渠道的同一个模型另开一个 `<模型>-free` 的名字，能力与基础模型一样，查表时会剥掉这个后缀退回基础模型的条目，两个名字给出同一套档位。

表里没有的模型走保守兜底：`off` / `low` / `medium` / `high`。长度上限会先用网关给的值，所以新模型即使还没进表，长度也是对的；档位在补表之前是通用三档。

能力表按归一化后的名字查（忽略大小写、空格、点、横线、下划线、斜杠、冒号），显示名与上游 key 都能命中。中转按显示名发布、表里按上游 key 记录时（比如 `Xiaomi MiMo-V2.6-Pro` 对 `mimo-v2.6-pro`），在 `CAPABILITY_ALIASES` 里补一行别名。

插件不引任何运行时依赖，装进任何 profile 都不会因为解析不到包而加载失败。

## 为什么不是「独立的路由插件」

`dsh-llm` 的 `registerAdapter` 是按路由独占的，`llm-pi-ai` 已经占着整族路由，再挂一份同款模块会因为内置厂商标重复直接加载失败；`LlmRuntime` 的适配器表也是私有的，没有接口能包装已注册路由的元数据。所以插件只能补配置，不能自己接管路由。好处是流式、工具调用这些全部复用 `llm-pi-ai`，不碰请求路径。

## 测试

```sh
node --test test/
```

覆盖档位补全、从网关目录追加新模型、长度上限优先取网关值、默认档位选择、幂等性（第二次不改动配置），以及不误伤非中转路由（实测把路由改成别家后，配置一个字节都没被改写）。

端到端验证走的是真实 dsh 进程 + 真实网关：路由里只写一个模型启动，配置里会补齐网关当时的全部模型；把 mock 网关的目录在第 N 次请求后加一个模型，`refreshIntervalMs` 到了之后配置里就多出这个模型。

## License

MIT
