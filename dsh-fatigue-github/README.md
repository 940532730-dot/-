# dsh-fatigue · 疲劳与睡眠

把「休息」变成一种会消耗、也会恢复的资源：睡不够时，模型会被自动限流。

## 规则

- **休息**：连续 `restIdleMinutes`（默认 5 分钟）没有任何工作任务后，进入休息状态。
- **深度睡眠**：一次休息持续 `deepSleepMinutes`（默认 40 分钟）及以上，整段计入深度睡眠。
- **小憩**：休息不足 40 分钟就被唤醒，按 `napCreditRatio`（默认一半）折算进深度睡眠。
- **离线时长**：关掉 DSH 再打开时，间隔同样按上面的规则结算——关机睡觉也算睡。
- **统计窗口**：过去 `windowHours`（默认 24 小时）滚动窗口内的深度睡眠总和。
- **算力限制**：窗口内深度睡眠不足 `targetSleepHours`（默认 8 小时）时，每缺 `hoursPerStep`（默认 1 小时，不足按 1 小时算）下调 `reductionPerStep`（默认 1/8）算力，最低保留 `minRatio`（默认 1/4）。

算力限制的落地方式（`throttleMode`）：

1. **`speed`（默认）**：按比例放慢流式输出，每个输出块之间插入延迟。只影响速度，**不截断内容、不改请求参数**；
2. `tokens`：额外按比例缩小 `maxTokens`（`throttleMaxTokens: true` 时）；
3. `off`：只记录睡眠状态，不做任何限制。

另外可选下调 `reasoningEffort` 档位（`degradeReasoning`，默认关闭），以及把疲劳状态写进系统提示（`promptNotice`）。

> 带 `speed` 模式时，如果 `baseChunkDelayMs` 太大，回答会很长很慢；`maxChunkDelayMs` 是单块延迟上限，用来防止卡死。

## 设置页

装好后在 **设置 → 疲劳与睡眠** 里可以看当前状态（休息/深睡/24h 累计/算力百分比），并直接改数值：目标睡眠、统计窗口、休息与深睡阈值、小憩折算、每档缺口与削减、最低保留、降速延迟。保存即时生效，写入 `$DSH_HOME/dsh-fatigue/config.json`（用户覆盖层，优先于 `cordis.patch.yml`）。

## 联动

- **dsh-feiyu-mood**（可选）：被叫醒时读本插件的 `state.json` 里的 `lastWake`：24h 深度睡眠 < 目标 → 心情减 `sleepMoodPenalty`；≥ 目标 → 心情加 `sleepMoodBonus`，并在随后 `sleepCooldownHours`（默认 24h）内不再按睡眠调整。

  这段逻辑在心情插件里，**不在本仓库的代码里**。要用的话给 `dsh-feiyu-mood` 打补丁：[`patches/dsh-feiyu-mood-sleep-link.md`](patches/dsh-feiyu-mood-sleep-link.md)。不打补丁也不影响本插件，只是心情不会被睡眠影响。

## 接口

- 工具 `fatigue_status`：只读快照，含 `phase`、`deepSleepMinutes`、`computePercent` 等。
- `GET /dsh-fatigue/state.json`：同一份快照，供其它插件 / UI 读取。
- `GET /dsh-fatigue/config`：当前可调配置；`GET /dsh-fatigue/config?patch=<json>` 保存（也接受 POST）。
- 状态文件：`$DSH_HOME/dsh-fatigue/state.json`（默认 `~/.dsh/dsh-fatigue/state.json`）。

## 配置

所有阈值都是 `cordis.patch.yml` 里的插件 `config`，例如：

```yaml
- insert:
    - id: fatigue
      name: '@local/dsh-fatigue'
      config:
        targetSleepHours: 8
        windowHours: 24
        restIdleMinutes: 5
        deepSleepMinutes: 40
        napCreditRatio: 0.5
        hoursPerStep: 1
        reductionPerStep: 0.125
        minRatio: 0.25
        throttleMode: speed
        baseChunkDelayMs: 25
        maxChunkDelayMs: 120
        throttleMaxTokens: false
        baselineMaxTokens: 8192
        degradeReasoning: false
        promptNotice: true
```

## 说明

- `phase` 取值：`awake`（有工作或刚结束）、`resting`（休息中，未满深度阈值）、`deep-sleep`（深度睡眠进行中）。
- 深度睡眠不足 40 分钟的休息段在唤醒时按小憩结算，进行中的小憩不计入可见数值。
- 插件不追加新的会话事件类型，全部状态都是派生数据，可随时删除 `state.json` 重来。

## 分享 / 安装

分享 **`dsh-fatigue-1.0.1.tgz`**（打包好的完整插件），对方在 DSH 里让 AI 执行：

> 用 `plugin_manager` 的 `install_bundle` 安装 `<tgz 的绝对路径>`，然后重启 DSH。

或者直接给本目录（含 `package.json` 的那一层），`install_bundle` 的 `target` 指向目录即可。
装完在 **设置 → 疲劳与睡眠** 里调参数；`~/.dsh/dsh-fatigue/` 是它的数据目录（`state.json` 睡眠记录、`config.json` 用户覆盖）。
