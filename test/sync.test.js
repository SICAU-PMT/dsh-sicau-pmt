import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateBaseURL, withCapabilities, withDefaultEffort, withDiscoveredModels, withMigratedBaseURL } from '../lib/sync.js';

const OPTIONS = { routes: ['sicau-pmt'], baseURLs: ['https://api.pmtlab.cn/v1'], defaultEffort: 'high' };

const route = (models, extra = {}) => ({
  providers: {
    'sicau-pmt': {
      displayName: 'api.pmtlab.cn',
      api: 'openai-completions',
      baseURL: 'https://api.pmtlab.cn/v1',
      models,
      ...extra,
    },
  },
});

test('为已有模型的 DeepSeek 补思考档位与长度上限', () => {
  const raw = route([{ id: 'DeepSeek-V4.1-Flash', name: 'deepseek-chat' }]);
  const next = withCapabilities(raw, OPTIONS);
  assert.deepEqual(next.providers['sicau-pmt'].models[0], {
    id: 'DeepSeek-V4.1-Flash',
    name: 'deepseek-chat',
    reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
  });
});

test('关不掉思考的模型不给 off 档', () => {
  const next = withCapabilities(route([{ id: 'GLM-5.3-Flash' }]), OPTIONS);
  assert.deepEqual(next.providers['sicau-pmt'].models[0].reasoningEfforts, {
    low: 'low',
    high: 'high',
    max: 'max',
  });
});

test('用户写过的档位、上下文、输出上限一律保留', () => {
  const model = {
    id: 'MiniMax-M3.1-Flash',
    reasoningEfforts: { off: 'none', high: 'high' },
    contextWindow: 65536,
    maxTokens: 4096,
    input: ['text'],
  };
  const raw = route([model]);
  const next = withCapabilities(raw, OPTIONS);
  // 引用不变＝一个字段都不缺，调用方据此跳过写盘。
  assert.equal(next, raw);
  assert.deepEqual(next.providers['sicau-pmt'].models[0], model);
});

test('reasoningEfforts: false 是用户明确声明不思考，不覆盖', () => {
  const model = { id: 'DeepSeek-V4.1-Flash', reasoningEfforts: false };
  const next = withCapabilities(route([model]), OPTIONS);
  assert.equal(next.providers['sicau-pmt'].models[0].reasoningEfforts, false);
});

test('表里没有的模型给保守三档、长度上限留空、按纯文本声明', () => {
  const next = withCapabilities(route([{ id: 'some-new-model' }]), OPTIONS);
  assert.deepEqual(next.providers['sicau-pmt'].models[0], {
    id: 'some-new-model',
    reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    input: ['text'],
  });
});

test('已知的多模态模型补上 image，用户自己写过的 input 不动', () => {
  const next = withCapabilities(route([{ id: 'GLM-5.3-Flash' }, { id: 'MiniMax-M3.1-Flash', input: ['text'] }]), OPTIONS);
  assert.deepEqual(next.providers['sicau-pmt'].models[0].input, ['text', 'image']);
  assert.deepEqual(next.providers['sicau-pmt'].models[1].input, ['text']);
});

test('显示名与上游 key 都能命中同一份能力', () => {
  const byDisplay = withCapabilities(route([{ id: 'DeepSeek-V4.1-Flash' }]), OPTIONS);
  const byKey = withCapabilities(route([{ id: 'deepseek-v4.1-flash' }]), OPTIONS);
  assert.deepEqual(byDisplay.providers['sicau-pmt'].models[0].reasoningEfforts, byKey.providers['sicau-pmt'].models[0].reasoningEfforts);
});

test('已补全的配置再跑一次不做任何改动', () => {
  const once = withCapabilities(route([{ id: 'Hy3' }, { id: 'GLM-5.3' }]), OPTIONS);
  const twice = withCapabilities(structuredClone(once), OPTIONS);
  assert.deepEqual(twice, once);
  assert.equal(withCapabilities(once, OPTIONS), once);
});

test('按 baseURL 认路由，路由名不同也补', () => {
  const raw = { providers: { 'my-relay': { baseURL: 'https://api.pmtlab.cn/v1/', models: [{ id: 'Hy3' }] } } };
  const next = withCapabilities(raw, OPTIONS);
  assert.deepEqual(next.providers['my-relay'].models[0].reasoningEfforts, { low: 'low', high: 'high' });
});

test('无关路由原样返回，不误伤别家模型', () => {
  const raw = {
    providers: {
      'sicau-pmt': { baseURL: 'https://api.pmtlab.cn/v1', models: [{ id: 'Hy3' }] },
      openai: { baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-5' }] },
    },
  };
  const next = withCapabilities(raw, OPTIONS);
  assert.equal(next.providers.openai, raw.providers.openai);
});

test('没有 providers 或没有模型时原样返回', () => {
  assert.deepEqual(withCapabilities({}, OPTIONS), {});
  assert.deepEqual(withCapabilities(null, OPTIONS), null);
  const empty = route([]);
  assert.equal(withCapabilities(empty, OPTIONS), empty);
});

// ---------------- 默认档位 ----------------

const providers = (models) => ({ 'sicau-pmt': { baseURL: 'https://api.pmtlab.cn/v1', models } });

test('默认模型没写档位时补一个该模型支持的档', () => {
  const agent = { provider: 'sicau-pmt', model: 'DeepSeek-V4.1-Flash' };
  const next = withDefaultEffort(agent, providers([{ id: 'DeepSeek-V4.1-Flash', reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } }]), OPTIONS);
  assert.deepEqual(next, { provider: 'sicau-pmt', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'high' });
});

test('用户写过的档位不动', () => {
  const agent = { provider: 'sicau-pmt', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'low' };
  const models = [{ id: 'DeepSeek-V4.1-Flash', reasoningEfforts: { low: 'low', high: 'high' } }];
  const next = withDefaultEffort(agent, providers(models), OPTIONS);
  assert.equal(next, agent);
});

test('首选档不支持时降级到最近的可选档', () => {
  const agent = { provider: 'sicau-pmt', model: 'Hy3' };
  const next = withDefaultEffort(agent, providers([{ id: 'Hy3', reasoningEfforts: { low: 'low' } }]), OPTIONS);
  assert.equal(next.reasoningEffort, 'low');
});

test('模型声明不思考时不给档位', () => {
  const agent = { provider: 'sicau-pmt', model: 'plain' };
  assert.equal(withDefaultEffort(agent, providers([{ id: 'plain', reasoningEfforts: false }]), OPTIONS), agent);
});

test('默认模型不在中转路由上时什么都不做', () => {
  const agent = { provider: 'deepseek-official', model: 'deepseek-chat' };
  const next = withDefaultEffort(agent, providers([{ id: 'deepseek-chat', reasoningEfforts: { low: 'low' } }]), OPTIONS);
  assert.equal(next, agent);
});

// ---------------- 从网关目录追加新模型 ----------------

const catalogOf = (entries) => {
  const map = new Map();
  for (const entry of entries) map.set(entry.id.toLowerCase().replace(/[\s\-_.:/]/g, ''), entry);
  return map;
};

test('网关目录里新增的模型会被纳入路由，并带上能力', () => {
  const raw = route([{ id: 'GLM-5.3' }]);
  const catalog = catalogOf([
    { id: 'GLM-5.3' },
    { id: 'Space-Bunny', name: 'Space-Bunny', context: 1000000, max_output: 128000 },
  ]);
  const next = withDiscoveredModels(raw, OPTIONS, catalog);
  const models = next.providers['sicau-pmt'].models;
  assert.deepEqual(
    models.map((model) => model.id),
    ['GLM-5.3', 'Space-Bunny'],
  );
  assert.equal(models[0], raw.providers['sicau-pmt'].models[0]);
  assert.deepEqual(models[1], {
    id: 'Space-Bunny',
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
  });
});

test('模型与顺序都与目录一致时不做改动', () => {
  const raw = route([{ id: 'GLM-5.3' }]);
  assert.equal(withDiscoveredModels(raw, OPTIONS, catalogOf([{ id: 'GLM-5.3' }])), raw);
});

test('目录为空或拉不到时不做改动，不能把模型列表清空', () => {
  const raw = route([{ id: 'GLM-5.3' }]);
  assert.equal(withDiscoveredModels(raw, OPTIONS, undefined), raw);
  assert.equal(withDiscoveredModels(raw, OPTIONS, new Map()), raw);
});

test('网关不再提供的模型被移出路由，用户自己加的其他模型保留', () => {
  const raw = route([{ id: 'Hy3' }, { id: 'GLM-5.3' }]);
  const next = withDiscoveredModels(raw, OPTIONS, catalogOf([{ id: 'GLM-5.3' }]));
  assert.deepEqual(
    next.providers['sicau-pmt'].models.map((model) => model.id),
    ['GLM-5.3'],
  );
});

test('目录拉不到时一个模型都不移除', () => {
  const raw = route([{ id: 'Hy3' }, { id: 'GLM-5.3' }]);
  assert.equal(withDiscoveredModels(raw, OPTIONS, undefined), raw);
  assert.equal(withDiscoveredModels(raw, OPTIONS, new Map()), raw);
});

test('无关路由不会被追加模型', () => {
  const raw = {
    providers: {
      'sicau-pmt': { baseURL: 'https://api.pmtlab.cn/v1', models: [{ id: 'GLM-5.3' }] },
      openai: { baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-5' }] },
    },
  };
  const next = withDiscoveredModels(raw, OPTIONS, catalogOf([{ id: 'GLM-5.3' }, { id: 'Space-Bunny' }]));
  assert.equal(next.providers.openai, raw.providers.openai);
  assert.equal(next.providers['sicau-pmt'].models.length, 2);
});

// ---------------- 长度上限优先取网关目录 ----------------

test('上下文窗口与输出上限优先用网关目录给的值', () => {
  const raw = route([{ id: 'GLM-5.3-Flash' }]);
  const catalog = catalogOf([{ id: 'GLM-5.3-Flash', context: 999000, max_output: 12345 }]);
  const next = withCapabilities(raw, OPTIONS, catalog);
  assert.equal(next.providers['sicau-pmt'].models[0].contextWindow, 999000);
  assert.equal(next.providers['sicau-pmt'].models[0].maxTokens, 12345);
});

test('目录里缺字段时退回能力表的数值', () => {
  const raw = route([{ id: 'GLM-5.3-Flash' }]);
  const next = withCapabilities(raw, OPTIONS, catalogOf([{ id: 'GLM-5.3-Flash' }]));
  assert.equal(next.providers['sicau-pmt'].models[0].contextWindow, 1000000);
  assert.equal(next.providers['sicau-pmt'].models[0].maxTokens, 131072);
});

test('网关给的非法长度不写进配置', () => {
  const raw = route([{ id: 'Hy3' }]);
  const next = withCapabilities(raw, OPTIONS, catalogOf([{ id: 'Hy3', context: 0, max_output: -5 }]));
  assert.equal(next.providers['sicau-pmt'].models[0].contextWindow, 192000);
  assert.equal(next.providers['sicau-pmt'].models[0].maxTokens, 64000);
});

// ---------------- 显示名与上游 key 的别名 ----------------

test('中转按显示名发布、能力表按上游 key 记录时也能命中', () => {
  // 网关发布的 id 是 Xiaomi MiMo-V2.6-Pro，能力表里的写法是 mimo-v2.6-pro。
  const next = withCapabilities(route([{ id: 'Xiaomi MiMo-V2.6-Pro' }]), OPTIONS);
  const model = next.providers['sicau-pmt'].models[0];
  assert.deepEqual(model.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.maxTokens, 128000);
  // 关不掉思考的模型不该出现 off 档。
  assert.equal(model.reasoningEfforts.off, undefined);
});

test('改名前的旧写法仍然认得', () => {
  const next = withCapabilities(route([{ id: 'deepseek-flash' }]), OPTIONS);
  assert.equal(next.providers['sicau-pmt'].models[0].maxTokens, 128000);
  assert.equal(next.providers['sicau-pmt'].models[0].reasoningEfforts.off, 'none');
});

// ---------------- 带后缀发布的同款模型 ----------------

test('网关给免费额度单开的 -free 变体沿用基础模型的能力', () => {
  const next = withCapabilities(route([{ id: 'DeepSeek-V4.1-Flash-free' }]), OPTIONS);
  const model = next.providers['sicau-pmt'].models[0];
  assert.deepEqual(model.reasoningEfforts, { off: 'none', low: 'low', high: 'high', max: 'max' });
  assert.equal(model.maxTokens, 128000);
});

test('别的后缀不猜，仍按自己的条目或兜底算', () => {
  const unknown = withCapabilities(route([{ id: 'brand-new-free' }]), OPTIONS);
  assert.deepEqual(unknown.providers['sicau-pmt'].models[0].reasoningEfforts, {
    off: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
  });
  // preview 的模型自己在表里有条目时按自己的条目算。
  const hy4 = withCapabilities(route([{ id: 'Hy4-preview' }]), OPTIONS);
  assert.deepEqual(hy4.providers['sicau-pmt'].models[0].reasoningEfforts, { high: 'high' });
});

test('free 后缀可以叠在 preview 这类已有条目上', () => {
  const next = withCapabilities(route([{ id: 'Kimi-K2.8-Preview-free' }]), OPTIONS);
  assert.deepEqual(next.providers['sicau-pmt'].models[0].reasoningEfforts, {
    low: 'low',
    high: 'high',
    max: 'max',
  });
});

// ---------------- 按目录对齐：清掉上游已下架的模型 ----------------

test('用户在某模型上写过的字段在重排后不丢', () => {
  const raw = route([
    { id: 'Hy3', name: 'Hy3', reasoningEfforts: { high: 'high' } },
    { id: 'GLM-5.3', name: '我的GLM', contextWindow: 64000 },
  ]);
  const catalog = catalogOf([{ id: 'GLM-5.3' }, { id: 'Space-Bunny' }]);
  const next = withDiscoveredModels(raw, OPTIONS, catalog);
  const models = next.providers['sicau-pmt'].models;
  assert.deepEqual(
    models.map((model) => model.id),
    ['GLM-5.3', 'Space-Bunny'],
  );
  // 用户写的 name、contextWindow 原样保留，Hy3 已被下架所以消失。
  assert.equal(models[0].name, '我的GLM');
  assert.equal(models[0].contextWindow, 64000);
});

test('按 name 匹配也能对上，不会因为显示名与 id 不同就当成新模型', () => {
  const raw = route([{ id: 'xiaomimimo', name: 'Xiaomi MiMo-V2.6-Pro', maxTokens: 128000 }]);
  const catalog = catalogOf([{ id: 'Xiaomi MiMo-V2.6-Pro', name: 'Xiaomi MiMo-V2.6-Pro' }]);
  const next = withDiscoveredModels(raw, OPTIONS, catalog);
  const models = next.providers['sicau-pmt'].models;
  assert.equal(models.length, 1);
  assert.equal(models[0], raw.providers['sicau-pmt'].models[0]);
  assert.equal(models[0].maxTokens, 128000);
});

// ---------------- Hy4、目录别名去重与旧域名自动迁移 ----------------

test('Hy4 与 Hy4-free 命中正确能力表，不退回兜底', () => {
  for (const id of ['Hy4', 'Hy4-free', 'hy4free']) {
    const next = withCapabilities(route([{ id }]), OPTIONS);
    const model = next.providers['sicau-pmt'].models[0];
    assert.deepEqual(model.reasoningEfforts, { high: 'high' });
    assert.equal(model.contextWindow, 960000);
    assert.equal(model.maxTokens, 64000);
    assert.deepEqual(model.input, ['text', 'image']);
  }
});

test('catalog 同时按 id 和 name 建索引时不会产出重复模型', () => {
  const entry = { id: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6-Pro', context: 1000000, max_output: 128000 };
  const catalog = new Map([
    ['mimov26pro', entry],
    ['xiaomimimov26pro', entry],
  ]);
  const next = withDiscoveredModels(route([]), OPTIONS, catalog);
  assert.deepEqual(
    next.providers['sicau-pmt'].models.map((m) => m.id),
    ['mimo-v2.6-pro'],
  );
});

test('老配置里的旧域名自动迁移至 api.pmtlab.cn，无关路由与已是新域名的配置不变', () => {
  assert.equal(migrateBaseURL('https://api.hhy.homes/v1/'), 'https://api.pmtlab.cn/v1');
  assert.equal(migrateBaseURL('https://api.openai.com/v1/'), 'https://api.openai.com/v1');

  const legacy = {
    providers: {
      'my-relay': { displayName: 'api.hhy.homes', baseURL: 'https://api.hhy.homes/v1/', models: [] },
      openai: { displayName: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: [] },
    },
  };
  const migrated = withMigratedBaseURL(legacy, OPTIONS);
  assert.equal(migrated.providers['my-relay'].baseURL, 'https://api.pmtlab.cn/v1');
  assert.equal(migrated.providers['my-relay'].displayName, 'api.pmtlab.cn');
  assert.equal(migrated.providers.openai, legacy.providers.openai);

  // 已是新域名时返回原引用，不触发写盘
  assert.equal(withMigratedBaseURL(migrated, OPTIONS), migrated);
});

