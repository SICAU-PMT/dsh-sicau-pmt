/**
 * 拉一次网关的模型目录。
 *
 * 中转的 GET /v1/models 是指向中转站自己的静态列表（按密钥白名单过滤过），返回
 * id、display_name、context、max_output，没有任何思考能力字段。这几项里上下文与输出
 * 上限是可以直接用的，档位仍然只能靠 lib/sync.js 的能力表。
 *
 * 目录拿不到时返回 undefined，调用方当作「这次没有新信息」，不要当成「上游一个模型都
 * 没有」——否则一次网络抖动就会让模型列表空掉。
 */

/** 网关的目录就是个静态列表，不需要等太久，也别让启动卡在这。 */
const TIMEOUT_MS = 8000;

/**
 * 请求目录。baseURL 已经带 /v1 时直接接 /models。
 *
 * @param baseURL 路由的 baseURL（例如 https://api.hhy.homes/v1）。
 * @param apiKey 可能为空：有的网关不验 key 也能列目录。
 * @returns 归一化后的条目表（见 normalizeModel 的键），失败返回 undefined。
 */
export async function fetchCatalog(baseURL, apiKey) {
  const base = String(baseURL ?? '').replace(/\/+$/, '');
  if (base === '') return undefined;
  const url = `${base}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    const catalog = new Map();
    for (const entry of entries) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (id === '') continue;
      const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : id;
      catalog.set(normalizeModel(id), { id, name, context: entry.context, max_output: entry.max_output });
      // 显示名与 id 不同时两个键都能查到，能力表按哪个写法都能命中。
      const alias = normalizeModel(name);
      if (alias !== '' && !catalog.has(alias)) catalog.set(alias, { id, name, context: entry.context, max_output: entry.max_output });
    }
    return catalog.size > 0 ? catalog : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 与 lib/sync.js 同一套归一化规则。 */
function normalizeModel(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\-_.:/]/g, '');
}
