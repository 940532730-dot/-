# dsh-feiyu-mood 睡眠联动补丁（针对 0.4.6）

`dsh-fatigue` 会在 `~/.dsh/dsh-fatigue/state.json` 里写一条 `lastWake`（最近一次被叫醒、当时 24h 深度睡眠多少）。这个补丁让 **dsh-feiyu-mood** 在收到用户消息时读它，并按睡眠情况增减心情：

- 24h 深度睡眠 ≥ 目标 → 心情 +`sleepMoodBonus`，随后 `sleepCooldownHours`（默认 24h）内不再按睡眠调整；
- 不足 → 心情 −`sleepMoodPenalty`；
- 同一次唤醒只处理一次（按 `lastWake.at` 去重），而且只记账、不借她的嘴说出来（`lastConfidence = 0`）。

> 补丁只针对 **dsh-feiyu-mood 0.4.6**，作者升级后锚点可能失效。打完补丁重启 DSH。

## 改哪里

目标文件：`node_modules/dsh-feiyu-mood/lib/index.js`（link 安装时是包目录里的 `lib/index.js`）。

### 1. 顶部：加状态路径和读取函数

找到：

```js
const DIAG = join(STORE_DIR, 'diag.log')
```

在它下面加：

```js
// 睡眠联动：疲劳插件把「最近一次唤醒」写在这里
const FATIGUE_STATE_PATH = join(CFG_DIR, 'dsh-fatigue', 'state.json')

function readFatigueWake() {
  try {
    const raw = JSON.parse(readFileSync(FATIGUE_STATE_PATH, 'utf8'))
    const w = raw && raw.lastWake
    if (!w || !Number.isFinite(Number(w.at))) return null
    return {
      at: Number(w.at),
      deepSleepMs: Number(w.deepSleepMs) || 0,
      kind: w.kind === 'deep' ? 'deep' : 'nap',
    }
  } catch (e) {
    return null
  }
}
```

### 2. 默认值：DEFAULTS 里加五个字段

找到 `autoJudge: true,`，在它下面加：

```js
  sleepLink: true,
  sleepTargetHours: 8,
  sleepMoodPenalty: 4,
  sleepMoodBonus: 4,
  sleepCooldownHours: 24,
```

### 3. 配置读取：loadConfig 的 return 里

找到 `autoJudge: raw.autoJudge !== false,`，在它下面加：

```js
      sleepLink: raw.sleepLink !== false,
      sleepTargetHours: clamp(Number(raw.sleepTargetHours ?? DEFAULTS.sleepTargetHours) || DEFAULTS.sleepTargetHours, 1, 24),
      sleepMoodPenalty: clamp(Math.round(Number(raw.sleepMoodPenalty ?? DEFAULTS.sleepMoodPenalty) || 0), 0, 30),
      sleepMoodBonus: clamp(Math.round(Number(raw.sleepMoodBonus ?? DEFAULTS.sleepMoodBonus) || 0), 0, 30),
      sleepCooldownHours: clamp(Math.round(Number(raw.sleepCooldownHours ?? DEFAULTS.sleepCooldownHours) || 0), 1, 168),
```

### 4. 状态字段：blankState 与 normState

`blankState` 里找到 `timeline: [],`，在它上面加：

```js
    sleepHandledAt: 0,
    sleepCooldownUntil: 0,
```

`normState` 里找到给 `d.timeline` 赋值那行，在它上面加：

```js
    d.sleepHandledAt = Number(raw.sleepHandledAt) || 0
    d.sleepCooldownUntil = Number(raw.sleepCooldownUntil) || 0
```

（不加这两行的话，`normState` 会把它们剥掉，冷却和去重就失效。）

### 5. 联动逻辑：apply() 内

找到 `let judgeChain = Promise.resolve() // 判断串行…`，在它下面加：

```js
  function applySleepMoodIfAny() {
    if (!cfg.sleepLink) return
    const wake = readFatigueWake()
    if (!wake) return
    const s = getState(cfg.moodBase, { persist: false, halfHours: cfg.decayHalfHours })
    if (Number(s.sleepHandledAt) >= wake.at) return
    s.sleepHandledAt = wake.at
    if (Number(s.sleepCooldownUntil) > Date.now()) {
      saveState(s)
      return
    }
    const targetMs = cfg.sleepTargetHours * 3600e3
    const enough = wake.deepSleepMs >= targetMs
    const delta = enough ? cfg.sleepMoodBonus : -cfg.sleepMoodPenalty
    if (delta !== 0) {
      s.mood = clamp(Math.round(s.mood + delta), cfg.moodFloor, 100)
      s.lastReason = enough ? '睡够了，心里松快' : '没睡够就被叫起来，有点没精神'
      s.lastConfidence = 0
      s.updatedAt = Date.now()
      s.timeline.push({ at: Date.now(), mood: s.mood, delta, reason: s.lastReason, conf: 0, dims: { ...s.dims }, dimsDelta: {} })
    }
    if (enough) s.sleepCooldownUntil = Date.now() + cfg.sleepCooldownHours * 3600e3
    saveState(s)
    diag('睡眠联动：' + (enough ? '睡够' : '没睡够') + '，mood=' + s.mood)
  }
```

### 6. 触发：收到用户消息时

找到 `offs.push(agent.ctx.on('agent/inbox/inserted', (payload) => {` 那一段，在：

```js
        if (!txt || 注入上下文.has(src)) return
```

下面加一行：

```js
        applySleepMoodIfAny()
```

## 生效

改完重启 DSH。之后在 `~/.dsh/feiyu-mood/config.json` 里可以调：

| 字段 | 默认 | 含义 |
|---|---|---|
| `sleepLink` | `true` | 关掉就完全不按睡眠调心情 |
| `sleepTargetHours` | `8` | 目标深度睡眠小时数 |
| `sleepMoodPenalty` | `4` | 没睡够时心情减多少 |
| `sleepMoodBonus` | `4` | 睡够时心情加多少 |
| `sleepCooldownHours` | `24` | 睡够一次后的冷却小时数 |

## 没有这个补丁会怎样

`dsh-fatigue` 照常工作，只是 `lastWake` 没人读——不会报错，也不会影响心情插件本身。
