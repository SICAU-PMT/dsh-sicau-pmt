/**
 * Cordis 接线：等 configEditor 就绪，把 lib/sync.js 算出的配置写回 profile patch。
 *
 * DSH 的思考档位是「按路由声明的能力」，不是运行时探测的：llm-pi-ai 只把路由里每个
 * 模型显式写的 reasoningEfforts 交给界面，没写就当成不支持思考的模型，选择器里连一个
 * 档位都不出现。中转站（oh-pmt-api）这边 reasoning_effort 是原样转发的，不需要额外
 * 字段，所以缺档位纯粹是客户端没声明。
 *
 * 这个插件只补配置，不改调度：
 *   0. 识别到已停用旧域名时自动迁移至当前官方网关地址（api.pmtlab.cn）；
 *   1. 拉一次网关的 /v1/models，按它对齐路由的模型列表（缺的补上、已下架的移出）；
 *   2. 给每个模型补 reasoningEfforts，以及缺失的上下文窗口与输出上限（先用网关给的
 *      context / max_output，网关没给才用能力表）；
 *   3. 默认模型没有指定档位时补一个，否则请求不带 reasoning_effort，上游根本不思考。
 *
 * 写入走官方 configEditor（和设置页保存同一条路径：校验、原子写、保留注释、热更新），
 * 并且只补用户没写过的字段，用户自己声明的档位、上下文窗口、输出上限一律不动。
 *
 * 为什么不做成独立路由：dsh-llm 的 registerAdapter 是按路由独占的，llm-pi-ai 已经占着
 * 整族路由，第二份同款模块会因为内置厂商标重复直接加载失败。插件只能补配置，不能
 * 自己接管路由。
 *
 * 为什么档位不能也靠网关：/v1/models 没有承载思考能力的字段，DSH 的模型发现类型
 * （LlmDiscoveredModel）同样没有，探到了也传不进选择器。档位只能声明在客户端，所以
 * 维护 lib/sync.js 那张表；能自动化的只有「有哪些模型」和两个长度上限。
 */
import { fetchCatalog } from './catalog.js';
import {
  DEFAULT_BASE_URLS,
  DEFAULT_ROUTES,
  isTargetRoute,
  migrateBaseURL,
  withCapabilities,
  withDefaultEffort,
  withDiscoveredModels,
  withMigratedBaseURL,
} from './sync.js';

/** 承载路由与模型声明的行。 */
const LLM_PI_AI = '@deepseek-ai/dsh-llm-pi-ai';

/** 承载默认模型选择的行。 */
const AGENT_DEFAULT_MODEL = '@deepseek-ai/dsh-agent-default-model';

/**
 * 默认多久重新拉一次目录。`-free` 福利变体会随账号测活状态动态上下线，压到 5 分钟可
 * 及时反映变化；目录与声明均无变化时不会触发写盘。
 */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

/** 插件名。 */
export const name = 'sicau-pmt';

/**
 * 读插件配置：默认只盯 api.pmtlab.cn（含历史旧地址迁移）这一条路由，换中转时在插件行里覆盖。
 *
 * 这里不导出 Config，也就不引 schemastery：插件的字段没有需要热更新的响应式语义，
 * 少一个依赖就少一种「profile 里解析不到包导致整个 bundle 加载失败」的可能。
 */
function readOptions(config) {
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  const routes = strings(config?.routes);
  const baseURLs = strings(config?.baseURLs);
  const refresh = config?.refreshIntervalMs;
  return {
    routes: routes.length > 0 ? routes : [...DEFAULT_ROUTES],
    baseURLs: baseURLs.length > 0 ? baseURLs : [...DEFAULT_BASE_URLS],
    // false 表示不替用户选档位；字符串表示默认补哪个档。
    defaultEffort:
      config?.defaultEffort === false
        ? false
        : typeof config?.defaultEffort === 'string'
          ? config.defaultEffort
          : 'high',
    // 0 表示只在启动时同步一次。
    refreshIntervalMs: config?.refreshIntervalMs === 0 ? 0 : Number.isFinite(refresh) && refresh > 0 ? refresh : DEFAULT_REFRESH_MS,
  };
}

/**
 * 解析路由的 apiKeyEnv。
 *
 * 顺序与 dsh 自己解析凭据一致：托管凭据库 → 启动环境快照 → 进程环境。前两个服务在
 * 某些 profile 里可能不存在，所以每一层都按可选处理。
 */
async function resolveApiKey(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined;
  try {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit?.value) return hit.value;
    }
  } catch {
    // 凭据库不可用就当没配过，继续往下一层找。
  }
  try {
    const launch = ctx.get('launchEnvironment');
    const hit = launch?.get?.(ref);
    if (hit?.value) return hit.value;
  } catch {
    // 同上。
  }
  return typeof process !== 'undefined' ? process.env?.[ref] : undefined;
}

/** 把所有目标路由的目录都拉回来，按 baseURL + 密钥去重，同一个网关只打一次。 */
async function fetchCatalogs(ctx, providers, options) {
  const catalogs = new Map();
  const pending = new Map();
  for (const [route, profile] of Object.entries(providers ?? {})) {
    if (profile === null || typeof profile !== 'object' || !isTargetRoute(route, profile, options)) continue;
    const baseURL = migrateBaseURL(profile.baseURL);
    if (baseURL === '') continue;
    const key = await resolveApiKey(ctx, profile.apiKeyEnv);
    const cacheKey = `${baseURL}\n${key ?? ''}`;
    if (!pending.has(cacheKey)) pending.set(cacheKey, fetchCatalog(baseURL, key));
    catalogs.set(route, { baseURL, cacheKey });
  }
  const results = new Map();
  for (const [route, { baseURL, cacheKey }] of catalogs) {
    const catalog = await pending.get(cacheKey);
    if (catalog !== undefined) results.set(route, catalog);
    else ctx.logger.debug?.(`sicau-pmt: ${baseURL} 的模型目录这次没拉到，沿用现有声明`);
  }
  return results;
}

/**
 * 合并一次：先迁移已停用旧地址，再用网关目录对齐模型列表，最后补全每个模型的能力。
 *
 * 逐条路由处理，因为不同路由指向的网关和密钥都可能不同，目录也就不同。每一步都按
 * 引用判断有没有变化，最终引用不变就意味着不必写盘。
 */
function reconcile(raw, options, catalogs) {
  const migrated = withMigratedBaseURL(raw, options);
  const providers = migrated?.providers;
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return migrated;
  let changed = migrated !== raw;
  const nextProviders = { ...providers };
  for (const [route, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object' || !isTargetRoute(route, profile, options)) continue;
    // 网关暂时不通时 catalog 是 undefined，这时只按能力表补，别让缺档位等网络。
    const catalog = catalogs.get(route);
    const single = { providers: { [route]: profile } };
    const nextProfile = withCapabilities(withDiscoveredModels(single, options, catalog), options, catalog).providers[route];
    if (nextProfile !== profile) {
      nextProviders[route] = nextProfile;
      changed = true;
    }
  }
  return changed ? { ...migrated, providers: nextProviders } : raw;
}

/** 把补全结果写回承载行；配置已经是最新时什么都不做。 */
async function sync(ctx, options) {
  const entries = ctx.configEditor.entries();
  const llmEntry = entries.find((entry) => entry.options.name === LLM_PI_AI);
  if (llmEntry === undefined) return;

  const current = llmEntry.options.config ?? {};
  const catalogs = await fetchCatalogs(ctx, current.providers, options);

  let providers = current.providers ?? {};
  if (reconcile(current, options, catalogs) !== current) {
    try {
      // 写之前 configEditor 会把最新值交给 change，以那一刻的配置为准。
      await ctx.configEditor.edit(llmEntry, (live) => {
        const next = reconcile(live, options, catalogs);
        providers = next.providers ?? providers;
        return next;
      });
      const added = catalogs.size > 0 ? '，并已按网关目录对齐模型列表' : '';
      ctx.logger.info(`sicau-pmt: 已同步 ${llmEntry.options.id} 里中转模型的声明${added}`);
    } catch (error) {
      // 上层（命令行 overlay 或 home 配置）整块覆盖了这条路由时编辑会被拒绝，
      // 那不是故障，只是这份声明该由用户自己维护。
      ctx.logger.warn(`sicau-pmt: 没能写入 ${llmEntry.options.id} 的配置：${error?.message ?? error}`);
      return;
    }
  }

  if (options.defaultEffort === false) return;
  const agentEntry = entries.find((entry) => entry.options.name === AGENT_DEFAULT_MODEL);
  if (agentEntry === undefined) return;
  const agentConfig = agentEntry.options.config ?? {};
  const next = withDefaultEffort(agentConfig, providers, options);
  if (next === agentConfig) return;
  try {
    await ctx.configEditor.edit(agentEntry, () => next);
    ctx.logger.info(`sicau-pmt: 默认模型 ${agentConfig.model} 的思考档位设为 ${next.reasoningEffort}`);
  } catch (error) {
    ctx.logger.warn(`sicau-pmt: 没能写入 ${agentEntry.options.id} 的配置：${error?.message ?? error}`);
  }
}

/** 挂载：configEditor 只在有 profileContext 的 profile 里存在，等它出现再干活。 */
export function apply(ctx, config) {
  const options = readOptions(config);
  ctx.inject(['configEditor'], (child) => {
    let running = false;
    const run = () => {
      // 上一轮还没写完就别叠上来：两次写盘会互相覆盖。
      if (running) return;
      running = true;
      void sync(child, options)
        .catch((error) => child.logger.warn(`sicau-pmt: 同步失败：${error?.message ?? error}`))
        .finally(() => {
          running = false;
        });
    };
    run();
    if (options.refreshIntervalMs > 0) {
      child.effect(() => {
        const timer = setInterval(run, options.refreshIntervalMs);
        return () => clearInterval(timer);
      }, 'sicau-pmt.refresh');
    }
  });
}
