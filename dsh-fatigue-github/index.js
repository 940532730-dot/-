/**
 * dsh-fatigue — 疲劳 / 睡眠经济插件（Host 半侧）。
 *
 * 它不生成内容，只做三件事：
 *   1. 记录「工作 / 休息 / 深度睡眠」，跨进程持久化；
 *   2. 按过去 24 小时的深度睡眠缺口，下调模型算力；
 *   3. 把当前状态写进系统提示，并在 /dsh-fatigue/state.json 暴露给其它插件 / UI。
 *
 * 规则见 lib/engine.mjs 顶部注释，全部阈值由 Config 控制。
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { FatigueEngine } from './lib/engine.mjs'

export const name = 'fatigue'

/** webServer 提供状态接口，systemPrompt 注入疲劳提示，timer 驱动空闲检测。 */
export const inject = ['systemPrompt', 'tools', 'webServer', 'timer']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 目标深度睡眠小时数；缺口按此计算。 */
  targetSleepHours: z.number().default(8),
  /** 深度睡眠的统计窗口（滚动小时）。 */
  windowHours: z.number().default(24),
  /** 多久没有工作算进入休息。 */
  restIdleMinutes: z.number().default(5),
  /** 休息持续多久算深度睡眠。 */
  deepSleepMinutes: z.number().default(40),
  /** 小憩时长折算进深度睡眠的比例。 */
  napCreditRatio: z.number().default(0.5),
  /** 缺口每满多少小时算一档。 */
  hoursPerStep: z.number().default(1),
  /** 每档削减的算力比例（1/8 = 0.125）。 */
  reductionPerStep: z.number().default(0.125),
  /** 算力最低保留比例。 */
  minRatio: z.number().default(0.25),
  /** 限制方式：speed=按比例放慢流式输出（默认），tokens=压缩输出上限，off=只记录不限制。 */
  throttleMode: z.string().default('speed'),
  /** speed 模式：每个输出块的基础延迟（毫秒）。 */
  baseChunkDelayMs: z.number().default(25),
  /** speed 模式：单块延迟上限（毫秒），防止卡死。 */
  maxChunkDelayMs: z.number().default(120),
  /** 是否限制输出 token 上限（仅 throttleMode=tokens 时生效）。 */
  throttleMaxTokens: z.boolean().default(false),
  /** 模型未给出 maxTokens 时，作为缩放基准的输出上限（仅 tokens 模式）。 */
  baselineMaxTokens: z.natural().default(8192),
  /** 是否同时下调 reasoning effort 档位（默认关闭，避免影响输出质量）。 */
  degradeReasoning: z.boolean().default(false),
  /** 是否把疲劳状态注入系统提示。 */
  promptNotice: z.boolean().default(true),
  /** 状态文件目录，空 = $DSH_HOME/dsh-fatigue。 */
  stateDir: z.string().default(''),
})

function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

/** 已知档位按高 → 低排序；未知取值一律保持原样。 */
const EFFORT_LADDER = ['max', 'high', 'medium', 'low', 'minimal']

function degradeEffort(current, ratio) {
  if (typeof current !== 'string') return undefined
  const lower = current.toLowerCase()
  const index = EFFORT_LADDER.indexOf(lower)
  if (index < 0) return undefined
  // ratio > 0.75 只降一档，<= 0.5 直接压到 low，更低则 minimal。
  let targetIndex = index
  if (ratio <= 0.4) targetIndex = Math.max(index, EFFORT_LADDER.length - 1)
  else if (ratio <= 0.6) targetIndex = Math.max(index, EFFORT_LADDER.indexOf('low'))
  else if (ratio <= 0.8) targetIndex = Math.max(index, EFFORT_LADDER.indexOf('medium'))
  const next = EFFORT_LADDER[targetIndex]
  if (next === lower) return undefined
  // 保留原字符串大小写风格很难判断，直接返回规范小写。
  return next
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 每个流式块之间的延迟；ratio=0.25、base=25ms 时约 75ms/块。 */
function chunkDelayMs(chunk, ratio, cfg) {
  if (!chunk) return 0
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta' && chunk.type !== 'tool-call-delta') {
    return 0
  }
  const base = Number(cfg.baseChunkDelayMs) || 0
  if (base <= 0) return 0
  const safeRatio = Math.max(0.05, Math.min(1, ratio))
  const raw = base * (1 / safeRatio - 1)
  const cap = Number(cfg.maxChunkDelayMs) || 0
  return Math.max(0, Math.round(cap > 0 ? Math.min(cap, raw) : raw))
}

async function* slowStream(source, ratio, cfg) {
  for await (const chunk of source) {
    const delay = chunkDelayMs(chunk, ratio, cfg)
    if (delay > 0) await sleep(delay)
    yield chunk
  }
}

export function apply(ctx, config = {}) {
  const stateDir =
    typeof config?.stateDir === 'string' && config.stateDir.trim()
      ? config.stateDir.trim()
      : join(resolveDshHome(), 'dsh-fatigue')
  const statePath = join(stateDir, 'state.json')
  const userConfigPath = join(stateDir, 'config.json')

  // 设置页保存过的用户覆盖层优先于 cordis.patch.yml 里的 config。
  let cfg = Config(config ?? {})
  try {
    const overlay = JSON.parse(readFileSync(userConfigPath, 'utf8'))
    if (overlay && typeof overlay === 'object') cfg = Config({ ...cfg, ...overlay })
  } catch {
    /* 没有用户覆盖 = 用默认 */
  }
  const engine = new FatigueEngine(cfg)

  let ready = false
  let saveTimer = null
  let persistChain = Promise.resolve()

  /** 设置页允许改的字段（白名单；其余保持 patch 层配置）。 */
  const EDITABLE_KEYS = [
    'enabled',
    'targetSleepHours',
    'windowHours',
    'restIdleMinutes',
    'deepSleepMinutes',
    'napCreditRatio',
    'hoursPerStep',
    'reductionPerStep',
    'minRatio',
    'throttleMode',
    'baseChunkDelayMs',
    'maxChunkDelayMs',
    'throttleMaxTokens',
    'baselineMaxTokens',
    'degradeReasoning',
    'promptNotice',
  ]

  function currentConfigView() {
    const out = {}
    for (const key of EDITABLE_KEYS) out[key] = cfg[key]
    return out
  }

  async function saveUserConfig(patch) {
    let stored = {}
    try {
      stored = JSON.parse(await readFile(userConfigPath, 'utf8')) || {}
    } catch {
      stored = {}
    }
    if (patch && typeof patch === 'object') {
      for (const key of EDITABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) stored[key] = patch[key]
      }
    }
    await mkdir(stateDir, { recursive: true })
    await writeFile(userConfigPath, JSON.stringify(stored, null, 2), 'utf8')
    cfg = Config({ ...cfg, ...stored })
    engine.setConfig(cfg)
    return currentConfigView()
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 65536) {
          reject(new Error('body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  async function persist() {
    persistChain = persistChain.then(async () => {
      try {
        await mkdir(stateDir, { recursive: true })
        await writeFile(statePath, JSON.stringify(engine.state), 'utf8')
      } catch (error) {
        console.warn('[fatigue] cannot write state:', error?.message ?? error)
      }
    })
    return persistChain
  }

  function schedulePersist() {
    if (!ready || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, 1500)
  }

  void (async () => {
    try {
      const text = await readFile(statePath, 'utf8')
      engine.load(JSON.parse(text))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[fatigue] cannot read state:', error?.message ?? error)
      }
    }
    engine.bootstrap(Date.now())
    ready = true
    await persist()
  })()

  /** 一次工作活动：结算休息段并重置空闲计时。 */
  function activity() {
    if (!ready) return
    engine.touch(Date.now())
    schedulePersist()
  }

  ctx.on('session/event', () => activity())

  ctx.on('agent/status', (payload) => {
    const id = String(payload?.agent?.id ?? '')
    if (!id) return
    if (payload?.status === 'running') engine.running.add(id)
    else engine.running.delete(id)
    activity()
  })

  // tokens 模式：压缩输出上限。speed 模式不改请求参数，只放慢流。
  ctx.on('agent/request', async (payload, next) => {
    const callConfig = await next()
    if (!ready || !cfg.enabled) return callConfig
    const throttle = engine.computeThrottle(Date.now())
    if (throttle.ratio >= 0.999) return callConfig
    const out = { ...callConfig }
    if (cfg.throttleMode === 'tokens' && cfg.throttleMaxTokens) {
      const base =
        typeof callConfig.maxTokens === 'number' && callConfig.maxTokens > 0
          ? callConfig.maxTokens
          : cfg.baselineMaxTokens
      if (base > 0) out.maxTokens = Math.max(256, Math.floor(base * throttle.ratio))
    }
    if (cfg.degradeReasoning) {
      const effort = degradeEffort(callConfig.reasoningEffort, throttle.ratio)
      if (effort) out.reasoningEffort = effort
    }
    return out
  })

  // speed 模式：按疲劳比例放慢流式输出（真正的「运算速度」限制），
  // 不截断内容、不改请求参数，因此不会把回答卡成半句话。
  ctx.on('llm/stream', (options, next) => {
    const source = next()
    if (!ready || !cfg.enabled || cfg.throttleMode !== 'speed') return source
    if (options?.purpose === 'compaction' || options?.purpose === 'session-title') return source
    const throttle = engine.computeThrottle(Date.now())
    if (throttle.ratio >= 0.999) return source
    return slowStream(source, throttle.ratio, cfg)
  })

  if (cfg.promptNotice) {
    ctx.systemPrompt.section({
      name: 'fatigue',
      order: 900,
      text: () => (ready ? engine.promptText(Date.now()) : ''),
    })
  }

  ctx.effect(
    () =>
      ctx.timer.interval(() => {
        if (!ready) return
        const now = Date.now()
        if (engine.running.size > 0) engine.touch(now)
        else engine.maybeRest(now)
        engine.prune(now)
        schedulePersist()
      }, 20_000),
    'fatigue: idle tick',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'fatigue_status',
          description:
            '查看当前疲劳/睡眠状态与算力限制（只读）。返回值里的 computePercent 是当前生效的算力百分比，deepSleepMinutes 是过去窗口内累计的深度睡眠。',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute() {
            return JSON.stringify(engine.snapshot(Date.now()), null, 2)
          },
        }),
      ),
    'fatigue: status tool',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-fatigue',
        handler: async (req, res) => {
          const path = (req.url ?? '/').split('?')[0]
          const send = (code, obj) => {
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(obj, null, 2))
          }
          try {
            if (path === '/dsh-fatigue/state.json') {
              const snapshot = engine.snapshot(Date.now())
              // 诊断用：client 半侧是否已被 client-modules 收录（有 graph 服务时才有意义）。
              try {
                const graph = ctx.get?.('clientModules')?.graph?.()
                const ids = Array.isArray(graph?.entries) ? graph.entries.map((entry) => entry.id) : []
                snapshot.clientInGraph = ids.includes('@local/dsh-fatigue')
                snapshot.clientGraphIds = ids
              } catch {
                snapshot.clientInGraph = null
              }
              send(200, snapshot)
              return
            }
            if (path === '/dsh-fatigue/config') {
              // POST 在部分宿主版本会被前缀路由挡成 405，所以同时支持 GET ?patch=<json>。
              const query = new URL(req.url ?? '/', 'http://localhost').searchParams
              const patchRaw = query.get('patch')
              if (patchRaw) {
                const patch = JSON.parse(patchRaw)
                const next = await saveUserConfig(patch)
                send(200, { ok: true, config: next })
                return
              }
              if (req.method === 'POST') {
                const raw = await readBody(req)
                const patch = JSON.parse(raw || '{}')
                const next = await saveUserConfig(patch)
                send(200, { ok: true, config: next })
                return
              }
              send(200, {
                ok: true,
                config: currentConfigView(),
                snapshot: engine.snapshot(Date.now()),
              })
              return
            }
            send(404, { ok: false, error: 'not found' })
          } catch (error) {
            send(400, { ok: false, error: error?.message ?? String(error) })
          }
        },
      }),
    'fatigue: state route',
  )

  ctx.effect(() => () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    void persist()
  }, 'fatigue: persist on teardown')
}
