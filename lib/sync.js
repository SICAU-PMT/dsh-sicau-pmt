/**
 * 纯计算部分：把模型能力和中转路由的声明合并成 llm-pi-ai 的配置。
 *
 * 这里不引 dsh 的任何包，方便直接单测；与 Cordis 的接线在 index.js。
 */

/** 默认按路由名识别中转路由。 */
export const DEFAULT_ROUTES = ['sicau-pmt'];

/** 默认按 baseURL 识别中转路由。 */
export const DEFAULT_BASE_URLS = ['https://api.pmtlab.cn/v1'];

/**
 * 已停用旧域名到新域名的映射：老用户升级插件后自动把本地 profile 里的旧 baseURL
 * 迁到新网关，无需手改 cordis.patch.yml。
 */
const LEGACY_BASE_URLS = new Map([['https://api.hhy.homes/v1', 'https://api.pmtlab.cn/v1']]);

/** 把已停用的旧中转地址折到当前官方地址，其余地址原样返回。 */
export function migrateBaseURL(baseURL) {
  const normalized = String(baseURL ?? '').trim().replace(/\/+$/, '');
  return LEGACY_BASE_URLS.get(normalized) ?? normalized;
}

/** 这些模型的图片能力都实测过：中转把 image_url 原样转给上游，模型确实看得到图。 */
const IMAGE = ['text', 'image'];

/** 表里没有的模型不假设它看得见图，按纯文本声明：猜错成 image 只会让上游收到图文后失败。 */
const TEXT_ONLY = ['text'];

/**
 * 模型能力表。键是去掉分隔符的小写名字，显示名、上游 key、改名前的旧名都列进来：
 * 中转给人的 id 是显示名，换上游或改名后同一个模型会换个写法，只按一种写法人认不全。
 *
 * efforts 是上游认的档位；off 表示这个模型能不能真的关掉思考。数值与档位来自网关
 * 目录（internal/workbuddy/catalog.go）、厂商产品配置与实测：GLM、MiniMax、Hy 系列
 * 关不掉思考（传 none 仍会吐 reasoning_content），把 off 摆出来只会让人以为关掉了，
 * 所以只给 DeepSeek 系列和 Kimi-K3 开这个档。
 */
const CAPABILITY_ROWS = {
  deepseekv41flash: { efforts: ['low', 'high', 'max'], off: true, contextWindow: 1000000, maxTokens: 128000, input: IMAGE },
  deepseekv4pro: { efforts: ['high', 'xhigh', 'max'], off: true, contextWindow: 1000000, maxTokens: 128000, input: IMAGE },
  glm53flash: { efforts: ['low', 'high', 'max'], off: false, contextWindow: 1000000, maxTokens: 131072, input: IMAGE },
  glm53: { efforts: ['low', 'high', 'max'], off: false, contextWindow: 1000000, maxTokens: 64000, input: IMAGE },
  kimik3: { efforts: ['low', 'high', 'xhigh'], off: true, contextWindow: 1000000, maxTokens: 32000, input: IMAGE },
  kimik31pro: { efforts: ['low', 'high', 'max'], off: false, contextWindow: 1000000, maxTokens: 32000, input: IMAGE },
  kimik28preview: { efforts: ['low', 'high', 'max'], off: false, contextWindow: 1000000, maxTokens: 64000, input: IMAGE },
  minimaxm31flash: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], off: false, contextWindow: 1000000, maxTokens: 128000, input: IMAGE },
  mimov26pro: { efforts: ['low', 'medium', 'high'], off: false, contextWindow: 1000000, maxTokens: 128000, input: IMAGE },
  hy3: { efforts: ['low', 'high'], off: false, contextWindow: 192000, maxTokens: 64000, input: IMAGE },
  hy4: { efforts: ['high'], off: false, contextWindow: 960000, maxTokens: 64000, input: IMAGE },
  step5preview: { efforts: ['low', 'medium', 'high'], off: false, contextWindow: 1000000, maxTokens: 64000, input: IMAGE },
  spacebunny: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], off: false, contextWindow: 1000000, maxTokens: 128000, input: IMAGE },
  qwen38: { efforts: ['low', 'medium', 'xhigh'], off: false, contextWindow: 180000, maxTokens: 64000, input: IMAGE },
};

/**
 * 别名 → 能力。中转发布的 id 是显示名（Xiaomi MiMo-V2.6-Pro），而各家上游的 key 是
 * 另一种写法（mimo-v2.6-pro），归一化后对不上，所以要显式列出别名。
 *
 * 加一行别名只影响「查到哪条能力」，不会让兜底失效：查不到仍然走 FALLBACK。
 */
const CAPABILITY_ALIASES = {
  xiaomimimov26pro: 'mimov26pro',
  mimov26pro: 'mimov26pro',
  deepseekflash: 'deepseekv41flash',
  kimik31: 'kimik3',
  kimik3pro: 'kimik31pro',
  k3: 'kimik3',
  hy4preview: 'hy4',
  hy4free: 'hy4',
  step5: 'step5preview',
  spacebunnypro: 'spacebunny',
  qwen38flash: 'qwen38',
  qwen38max: 'qwen38',
};

const CAPABILITIES = new Map(
  Object.entries(CAPABILITY_ROWS).map(([key, capability]) => [key, capability]),
);
for (const [alias, target] of Object.entries(CAPABILITY_ALIASES)) {
  CAPABILITIES.set(normalizeModel(alias), CAPABILITY_ROWS[target]);
}

/**
 * 表里没有的模型按「能思考、三个常规档」处理：漏一条记录的表现是这个模型完全不能
 * 思考，用户直接能感觉到；多给一个档位最多是选了没区别。上下文窗口与输出上限不猜，
 * 留空沿用 DSH 的默认值。
 */
const FALLBACK = { efforts: ['low', 'medium', 'high'], off: true };

/** 默认档位的降级顺序：想要的档没有就往下找，最后才往上升。 */
const EFFORT_FALLBACK = ['high', 'medium', 'low', 'minimal', 'xhigh', 'max'];

/** 从网关目录里只读这几个字段，别的一概不信。 */
const POSITIVE_INT = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

/** 去掉大小写与分隔符，让显示名和上游 key 落到同一个键上。 */
export function normalizeModel(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\-_.:/]/g, '');
}

/**
 * 网关给「走免费渠道」的同一个模型另开一个 `-free` 的名字（见 oh-pmt-api 的
 * FreeSuffix），能力与基础模型完全相同。归一化只差一个后缀，不这样退回就会落兜底，
 * 同一个模型在界面里两套档位。
 */
const FREE_SUFFIX = 'free';

/** 按归一化名字查能力，查不到再按 `-free` 变体退回基础模型。 */
function lookup(name) {
  const key = normalizeModel(name);
  if (key === '') return undefined;
  const direct = CAPABILITIES.get(key);
  if (direct !== undefined) return direct;
  if (!key.endsWith(FREE_SUFFIX)) return undefined;
  return CAPABILITIES.get(key.slice(0, -FREE_SUFFIX.length));
}

/** 查一个模型的能力，查不到给兜底。 */
function capabilityOf(model) {
  return lookup(model?.id) ?? lookup(model?.name) ?? FALLBACK;
}

/**
 * 生成 reasoningEfforts：键是界面上的档位，值是发给上游的写法。
 *
 * 关不掉思考的模型不写 off —— 不写等于该档位不可用，界面就不会给出这个选项。
 * 关闭档写成 none 而不是留空：留空等于不下发 reasoning_effort，上游会按自己的默认
 * 档思考，用户看到「已关闭」但实际还在思考。
 */
function effortsOf(capability) {
  const efforts = {};
  if (capability.off) efforts.off = 'none';
  for (const level of capability.efforts) efforts[level] = level;
  return efforts;
}

/**
 * 补一个模型缺的声明；一个字段都不缺时返回原对象，
 * 调用方据此按引用判断有没有变化。
 *
 * 上下文窗口与输出上限先看网关目录（catalog 里按 id 查到的那条），查不到才用能力表
 * 的数值：网关是权威来源，但目录里缺字段或暂时拉不到时不能让这两个值空着。
 */
function describeModel(model, catalog) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return model;
  const capability = capabilityOf(model);
  const listed = catalog?.get(normalizeModel(model.id)) ?? catalog?.get(normalizeModel(model.name));
  const patch = {};
  // reasoningEfforts: false 是用户明确声明「这个模型不思考」，不要覆盖。
  if (model.reasoningEfforts === undefined) patch.reasoningEfforts = effortsOf(capability);
  if (model.contextWindow === undefined) {
    const contextWindow = POSITIVE_INT(listed?.context) ?? capability.contextWindow;
    if (contextWindow !== undefined) patch.contextWindow = contextWindow;
  }
  if (model.maxTokens === undefined) {
    const maxTokens = POSITIVE_INT(listed?.max_output) ?? capability.maxTokens;
    if (maxTokens !== undefined) patch.maxTokens = maxTokens;
  }
  // 不声明 image 时 DSH 会把图片换成一段占位文字（projectImagesForTextModel），
  // 模型根本看不到图；这些模型上游都看得见，漏写等于白丢多模态能力。
  if (model.input === undefined) patch.input = [...(capability.input ?? TEXT_ONLY)];
  return Object.keys(patch).length === 0 ? model : { ...model, ...patch };
}

/** 这个路由是不是要补的中转路由：按路由名、当前 baseURL 或已停用旧 baseURL 认。 */
export function isTargetRoute(route, profile, options) {
  if (options.routes.includes(route)) return true;
  const rawBase = String(profile?.baseURL ?? '').trim().replace(/\/+$/, '');
  if (rawBase === '') return false;
  const migrated = migrateBaseURL(rawBase);
  return options.baseURLs.some((candidate) => {
    const target = candidate.trim().replace(/\/+$/, '');
    return target === rawBase || target === migrated;
  });
}

/**
 * 自动把指向旧域名（api.hhy.homes）的目标路由迁移到当前官方地址（api.pmtlab.cn）。
 * 没有任何路由需要迁移时返回原对象本身，避免无意义写盘。
 */
export function withMigratedBaseURL(raw, options) {
  const providers = raw?.providers;
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return raw;
  let changed = false;
  const nextProviders = {};
  for (const [route, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object' || !isTargetRoute(route, profile, options)) {
      nextProviders[route] = profile;
      continue;
    }
    const rawBase = String(profile.baseURL ?? '').trim().replace(/\/+$/, '');
    const migrated = LEGACY_BASE_URLS.get(rawBase);
    if (migrated === undefined) {
      nextProviders[route] = profile;
      continue;
    }
    const next = { ...profile, baseURL: migrated };
    if (profile.displayName === 'api.hhy.homes') next.displayName = 'api.pmtlab.cn';
    nextProviders[route] = next;
    changed = true;
  }
  return changed ? { ...raw, providers: nextProviders } : raw;
}

/**
 * 产出补全后的 llm-pi-ai 配置。没有任何字段要补时返回原对象本身，
 * 调用方据此跳过写盘——否则每次启动都会重写一遍配置文件。
 *
 * @param raw 当前的 llm-pi-ai 配置。
 * @param options 见 index.js 的 readOptions。
 * @param catalog 网关 /v1/models 的结果（normalizeModel → 条目）；拉不到就传 undefined，
 *                这时长度上限退回能力表。
 */
export function withCapabilities(raw, options, catalog) {
  const providers = raw?.providers;
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return raw;
  let changed = false;
  const nextProviders = {};
  for (const [route, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object' || !isTargetRoute(route, profile, options)) {
      nextProviders[route] = profile;
      continue;
    }
    const models = Array.isArray(profile.models) ? profile.models : [];
    const nextModels = models.map((model) => describeModel(model, catalog));
    if (nextModels.every((model, index) => model === models[index])) {
      nextProviders[route] = profile;
      continue;
    }
    changed = true;
    nextProviders[route] = { ...profile, models: nextModels };
  }
  return changed ? { ...raw, providers: nextProviders } : raw;
}

/**
 * 按网关目录对齐路由的模型列表。
 *
 * 目录是这一把密钥能跑的模型全集（中转按白名单过滤过），所以它才是权威来源：路由里
 * 手写的那份只是上一次的快照，上游下架、改名之后它就过时了。对齐规则：
 *
 *   - 目录里有的模型保留，顺序跟目录走；
 *   - 用户在每个模型上写过的字段（name、reasoningEfforts、contextWindow…）原样保留；
 *   - 目录里没有的模型移出，这正是清掉上游已下架模型的地方。
 *
 * 拉不到目录时完全不动。这个区别必须保留：拉取失败（没密钥、网络抖动）和「上游说
 * 这些模型都没了」是两件事，前者删模型会让列表凭一次抖动就空掉。
 */
export function withDiscoveredModels(raw, options, catalog) {
  const providers = raw?.providers;
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return raw;
  if (!(catalog instanceof Map) || catalog.size === 0) return raw;
  // catalog 同时按 id 与 name 建索引：同一个模型若 id/name 写法不同会在 Map 里占两条，
  // 这里按归一化 id 去重，避免给路由写出重复条目。
  const seenListed = new Set();
  const listed = [];
  for (const entry of catalog.values()) {
    if (typeof entry?.id !== 'string' || entry.id === '') continue;
    const key = normalizeModel(entry.id);
    if (key === '' || seenListed.has(key)) continue;
    seenListed.add(key);
    listed.push(entry);
  }
  if (listed.length === 0) return raw;
  let changed = false;
  const nextProviders = {};
  for (const [route, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object' || !isTargetRoute(route, profile, options)) {
      nextProviders[route] = profile;
      continue;
    }
    const models = Array.isArray(profile.models) ? profile.models : [];
    // 用户写过的字段按 id 与 name 两种写法都对得上，免得因为改名把设置弄丢。
    const existing = new Map();
    for (const model of models) {
      for (const key of [normalizeModel(model?.id), normalizeModel(model?.name)]) {
        if (key !== '' && !existing.has(key)) existing.set(key, model);
      }
    }
    const aligned = listed.map((entry) => {
      const key = normalizeModel(entry.id);
      const declared = existing.get(key);
      // 已经声明过的模型直接复用原对象：引用不变才能判断出「这一轮没什么可写」。
      return declared === undefined ? describeModel({ id: entry.id }, catalog) : declared;
    });
    const same = aligned.length === models.length && aligned.every((model, index) => model === models[index]);
    if (same) {
      nextProviders[route] = profile;
      continue;
    }
    changed = true;
    nextProviders[route] = { ...profile, models: aligned };
  }
  return changed ? { ...raw, providers: nextProviders } : raw;
}

/**
 * 挑一个该模型支持的默认档位。表里没有的档一律不给：DSH 对未声明的档位直接报错，
 * 不会静默降级，选错档等于这个模型发不出请求。
 */
function preferredEffort(model, wanted) {
  const declared = model?.reasoningEfforts;
  const efforts =
    declared === false || declared === undefined || declared === null || Array.isArray(declared)
      ? []
      : Object.keys(declared).filter((level) => level !== 'off');
  if (efforts.includes(wanted)) return wanted;
  return EFFORT_FALLBACK.find((level) => efforts.includes(level));
}

/**
 * 给默认模型补一个档位。
 *
 * 只声明 reasoningEfforts 是不够的：请求只有在「选中了档位」时才会带上
 * reasoning_effort，而这个中转不传该字段就完全不思考。所以默认模型得有一个档位，
 * 否则选择器里能选、实际用起来还是不思考。用户已经写过档位就尊重用户的选择。
 */
export function withDefaultEffort(agentConfig, providers, options) {
  const config = agentConfig ?? {};
  const profile = providers?.[config.provider];
  if (profile === null || typeof profile !== 'object') return agentConfig;
  if (!isTargetRoute(config.provider, profile, options)) return agentConfig;
  if (config.reasoningEffort !== undefined) return agentConfig;
  const models = Array.isArray(profile.models) ? profile.models : [];
  const model = models.find((candidate) => candidate?.id === config.model);
  if (model === undefined) return agentConfig;
  const effort = preferredEffort(model, options.defaultEffort);
  return effort === undefined ? agentConfig : { ...config, reasoningEffort: effort };
}
