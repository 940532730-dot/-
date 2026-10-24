/**
 * Fatigue / sleep economy state machine.
 *
 * Pure time-based logic, no I/O and no Cordis dependency, so it can be unit
 * tested and reasoned about in isolation. The host plugin owns persistence,
 * event wiring and compute throttling.
 *
 * Model (as requested):
 * - After `restIdleMinutes` without any work, the model enters "rest".
 * - A rest that lasts `deepSleepMinutes` or longer counts, in full, as deep
 *   sleep (settled when work resumes, or live while still resting).
 * - A shorter rest counts as a nap; `napCreditRatio` of it (default half) is
 *   added to deep sleep.
 * - Deep sleep is summed over a sliding `windowHours` window.
 * - When that sum is below `targetSleepHours`, every missing `hoursPerStep`
 *   lowers the compute ratio by `reductionPerStep`, floored at `minRatio`.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const STATE_VERSION = 1

export function emptyState(now = Date.now()) {
  return {
    v: STATE_VERSION,
    lastActivityAt: null,
    restingSince: null,
    segments: [],
    lastWake: null,
    updatedAt: now,
  }
}

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Tolerant reader: an older or corrupted file must never brick the plugin. */
export function normalizeState(raw) {
  const out = emptyState()
  if (!raw || typeof raw !== 'object') return out
  if (isNum(raw.lastActivityAt)) out.lastActivityAt = raw.lastActivityAt
  if (isNum(raw.restingSince)) out.restingSince = raw.restingSince
  if (Array.isArray(raw.segments)) {
    out.segments = raw.segments.filter(
      (s) => s && isNum(s.start) && isNum(s.end) && isNum(s.creditedMs) && s.end > s.start,
    )
  }
  if (isNum(raw.updatedAt)) out.updatedAt = raw.updatedAt
  if (raw.lastWake && isNum(raw.lastWake.at) && isNum(raw.lastWake.deepSleepMs)) {
    out.lastWake = {
      at: raw.lastWake.at,
      restMs: isNum(raw.lastWake.restMs) ? raw.lastWake.restMs : 0,
      kind: raw.lastWake.kind === 'deep' ? 'deep' : 'nap',
      deepSleepMs: raw.lastWake.deepSleepMs,
    }
  }
  return out
}

export class FatigueEngine {
  constructor(config) {
    this.config = config
    this.state = emptyState()
    /** Session ids whose agent is currently running. */
    this.running = new Set()
  }

  setConfig(config) {
    this.config = config
  }

  load(raw) {
    this.state = normalizeState(raw)
  }

  windowMs() {
    return this.config.windowHours * HOUR
  }

  targetMs() {
    return this.config.targetSleepHours * HOUR
  }

  idleMs() {
    return this.config.restIdleMinutes * MINUTE
  }

  deepMs() {
    return this.config.deepSleepMinutes * MINUTE
  }

  /** Work happened: settle any open rest, then restart the idle clock. */
  touch(now = Date.now()) {
    this.settle(now)
    this.state.lastActivityAt = now
    this.state.updatedAt = now
  }

  /**
   * Close the open rest segment. A rest of at least `deepSleepMinutes`
   * counts in full; anything shorter counts as a nap at `napCreditRatio`.
   */
  settle(now = Date.now()) {
    const since = this.state.restingSince
    if (since == null) return null
    const restMs = Math.max(0, now - since)
    const deep = restMs >= this.deepMs()
    const creditedMs = deep ? restMs : restMs * this.config.napCreditRatio
    this.state.segments.push({
      start: since,
      end: now,
      kind: deep ? 'deep' : 'nap',
      creditedMs,
    })
    this.state.restingSince = null
    this.state.updatedAt = now
    // 唤醒事件：mood 联动 / 宠物联动都读这一条（谁醒来、这次睡了多久、醒来时 24h 累计多少）。
    this.state.lastWake = {
      at: now,
      restMs,
      kind: deep ? 'deep' : 'nap',
      deepSleepMs: this.deepSleepMs(now),
    }
    return { restMs, deep, creditedMs }
  }

  /** Enter rest once the idle time has passed the threshold. */
  maybeRest(now = Date.now()) {
    if (this.state.restingSince != null) return false
    const last = this.state.lastActivityAt
    if (last == null) {
      this.state.lastActivityAt = now
      this.state.updatedAt = now
      return false
    }
    if (now - last < this.idleMs()) return false
    // Rest starts when the idle threshold was crossed, not when this tick ran.
    this.state.restingSince = last + this.idleMs()
    this.state.updatedAt = now
    return true
  }

  /**
   * First run in a process: the gap since the previous activity is treated as
   * rest too, so closing DSH and going to sleep still counts as sleep.
   */
  bootstrap(now = Date.now()) {
    const st = this.state
    if (st.restingSince != null) {
      // The previous process was already resting; it kept resting while closed.
      this.settle(now)
    } else if (st.lastActivityAt != null && now - st.lastActivityAt >= this.idleMs()) {
      st.restingSince = st.lastActivityAt + this.idleMs()
      this.settle(now)
    }
    st.lastActivityAt = now
    st.updatedAt = now
    this.prune(now)
  }

  /** Drop segments that can no longer overlap the window (keep a little slack). */
  prune(now = Date.now()) {
    const keepFrom = now - Math.max(this.windowMs() * 2, 48 * HOUR)
    const kept = this.state.segments.filter((s) => s.end >= keepFrom)
    if (kept.length !== this.state.segments.length) {
      this.state.segments = kept
      this.state.updatedAt = now
    }
  }

  /** Deep sleep credited inside the sliding window, including an ongoing rest. */
  deepSleepMs(now = Date.now()) {
    const from = now - this.windowMs()
    let total = 0
    for (const seg of this.state.segments) {
      const duration = seg.end - seg.start
      if (duration <= 0) continue
      const start = Math.max(seg.start, from)
      const end = Math.min(seg.end, now)
      if (end <= start) continue
      total += seg.creditedMs * ((end - start) / duration)
    }
    const since = this.state.restingSince
    if (since != null && now - since >= this.deepMs()) {
      const start = Math.max(since, from)
      if (now > start) total += now - start
    }
    return Math.max(0, total)
  }

  computeThrottle(now = Date.now()) {
    const cfg = this.config
    const deep = this.deepSleepMs(now)
    const target = this.targetMs()
    if (!cfg.enabled || deep >= target) {
      return { ratio: 1, steps: 0, deficitMs: 0, deepMs: deep, targetMs: target }
    }
    const deficitMs = target - deep
    const stepMs = cfg.hoursPerStep * HOUR
    const steps = Math.max(1, Math.ceil(deficitMs / stepMs))
    const ratio = Math.min(1, Math.max(cfg.minRatio, 1 - steps * cfg.reductionPerStep))
    return { ratio, steps, deficitMs, deepMs: deep, targetMs: target }
  }

  ratio(now = Date.now()) {
    return this.computeThrottle(now).ratio
  }

  phase(now = Date.now()) {
    const since = this.state.restingSince
    if (since != null) {
      return now - since >= this.deepMs() ? 'deep-sleep' : 'resting'
    }
    const last = this.state.lastActivityAt
    if (last != null && now - last >= this.idleMs()) return 'resting'
    return 'awake'
  }

  snapshot(now = Date.now()) {
    const cfg = this.config
    const throttle = this.computeThrottle(now)
    const since = this.state.restingSince
    const last = this.state.lastActivityAt
    const round = (ms) => Math.round(ms / MINUTE)
    return {
      phase: this.phase(now),
      enabled: cfg.enabled,
      windowHours: cfg.windowHours,
      targetSleepMinutes: round(throttle.targetMs),
      deepSleepMinutes: round(throttle.deepMs),
      deficitMinutes: round(throttle.deficitMs),
      steps: throttle.steps,
      computeRatio: throttle.ratio,
      computePercent: Math.round(throttle.ratio * 100),
      restIdleMinutes: cfg.restIdleMinutes,
      deepSleepThresholdMinutes: cfg.deepSleepMinutes,
      napCreditRatio: cfg.napCreditRatio,
      throttleMode: cfg.throttleMode ?? 'speed',
      throttleMaxTokens: cfg.throttleMaxTokens,
      restingSince: since,
      restingMinutes: since == null ? 0 : round(Math.max(0, now - since)),
      lastActivityAt: last,
      idleMinutes: last == null ? 0 : round(Math.max(0, now - last)),
      runningSessions: this.running.size,
      lastWake: this.state.lastWake
        ? {
            at: this.state.lastWake.at,
            restMinutes: round(this.state.lastWake.restMs),
            kind: this.state.lastWake.kind,
            deepSleepMinutesAtWake: round(this.state.lastWake.deepSleepMs),
          }
        : null,
      updatedAt: this.state.updatedAt,
    }
  }

  /** System-prompt notice, empty when the model is unthrottled. */
  promptText(now = Date.now()) {
    if (!this.config.promptNotice) return ''
    const cfg = this.config
    const throttle = this.computeThrottle(now)
    if (throttle.ratio >= 0.999) return ''
    const slept = Math.round(throttle.deepMs / MINUTE)
    const pct = Math.round(throttle.ratio * 100)
    const mode = cfg.throttleMode ?? 'speed'
    const limitText =
      mode === 'speed'
        ? `流式输出速度降为正常的 ${pct}%（每个输出块之间插入延迟），内容不会被截断。`
        : mode === 'tokens'
          ? '输出 token 上限被按比例压缩。'
          : '算力限制已关闭，仅记录状态。'
    return [
      `[疲劳状态] 过去 ${cfg.windowHours} 小时深度睡眠约 ${slept} 分钟，低于目标 ${cfg.targetSleepHours} 小时（缺口 ${Math.round(throttle.deficitMs / MINUTE)} 分钟）。`,
      `当前算力被限制为正常的 ${pct}%：${limitText}`,
      '请据此工作：先给结论和必要步骤，省略冗长铺垫、重复验证与可选扩展；非必要不新增工具调用；若任务确实做不完，直接说明“算力不足”，并说清还能做哪几步。',
    ].join('')
  }
}
