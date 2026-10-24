/**
 * dsh-fatigue 设置页（浏览器半侧）。
 *
 * 注册到「设置 → 疲劳与睡眠」：展示当前状态，并提供数值调控。
 * 读写走宿主半侧的 /dsh-fatigue/config（GET / ?patch=）。
 */
;(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) {
    console.error('[dsh-fatigue] ModuleLoader missing; client half not registered')
    return
  }

  window.__ModuleLoader__.load({
    id: '@local/dsh-fatigue',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      const CSS = `
[data-fatigue] { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 18px; font-size: 13px; }
[data-fatigue-status] { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-surface-2, rgba(127,127,127,.08)); }
[data-fatigue-status] b { font-weight: 600; }
[data-fatigue-sec] { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
[data-fatigue-h] { font-weight: 600; font-size: 13px; opacity: .9; }
[data-fatigue-row] { display: grid; grid-template-columns: 150px 120px 1fr; align-items: center; gap: 10px; }
[data-fatigue-row] input[type=number] { width: 110px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.35)); background: transparent; color: inherit; }
[data-fatigue-row] input[type=checkbox] { width: 16px; height: 16px; }
[data-fatigue-row] input[type=text] { padding: 4px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.35)); background: transparent; color: inherit; }
[data-fatigue-label] { opacity: .92; }
[data-fatigue-hint] { opacity: .6; font-size: 12px; }
[data-fatigue-actions] { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
[data-fatigue-actions] button { padding: 5px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.35)); background: var(--dsw-alias-surface-2, rgba(127,127,127,.1)); color: inherit; cursor: pointer; }
[data-fatigue-msg] { opacity: .7; font-size: 12px; }
`

      function fmtMinutes(value) {
        const total = Math.max(0, Math.round(Number(value) || 0))
        const hours = Math.floor(total / 60)
        const minutes = total % 60
        return hours > 0 ? hours + ' 小时 ' + minutes + ' 分' : minutes + ' 分钟'
      }

      function Panel() {
        const [config, setConfig] = React.useState(null)
        const [snapshot, setSnapshot] = React.useState(null)
        const [message, setMessage] = React.useState('')

        const load = React.useCallback(function () {
          fetch('/dsh-fatigue/config', { cache: 'no-store' })
            .then(function (r) {
              return r.json()
            })
            .then(function (data) {
              setConfig(data.config || {})
              setSnapshot(data.snapshot || null)
              setMessage('')
            })
            .catch(function (e) {
              setMessage('读取失败：' + (e && e.message ? e.message : e))
            })
        }, [])

        React.useEffect(function () {
          load()
        }, [load])

        const set = function (key, value) {
          setConfig(function (prev) {
            const next = {}
            const src = prev || {}
            for (const k in src) next[k] = src[k]
            next[key] = value
            return next
          })
        }

        const save = function () {
          fetch('/dsh-fatigue/config?patch=' + encodeURIComponent(JSON.stringify(config || {})), {
            cache: 'no-store',
          })
            .then(function (r) {
              return r.json()
            })
            .then(function (data) {
              if (data && data.ok) {
                setConfig(data.config || config)
                setMessage('已保存，即时生效')
                load()
              } else {
                setMessage('保存失败：' + ((data && data.error) || '未知错误'))
              }
            })
            .catch(function (e) {
              setMessage('保存失败：' + (e && e.message ? e.message : e))
            })
        }

        if (!config) {
          return h('div', { 'data-fatigue': '' }, message || '加载中…')
        }

        const num = function (key, label, hint, min, max, step) {
          return h(
            'label',
            { 'data-fatigue-row': '', key: key },
            h('span', { 'data-fatigue-label': '' }, label),
            h('input', {
              type: 'number',
              value: config[key] == null ? '' : config[key],
              min: min,
              max: max,
              step: step || 1,
              onChange: function (e) {
                set(key, Number(e.target.value))
              },
            }),
            h('span', { 'data-fatigue-hint': '' }, hint),
          )
        }

        const text = function (key, label, hint, placeholder) {
          return h(
            'label',
            { 'data-fatigue-row': '', key: key },
            h('span', { 'data-fatigue-label': '' }, label),
            h('span'),
            h('input', {
              type: 'text',
              value: config[key] == null ? '' : config[key],
              placeholder: placeholder || '',
              onChange: function (e) {
                set(key, e.target.value)
              },
            }),
          )
        }

        const bool = function (key, label, hint) {
          return h(
            'label',
            { 'data-fatigue-row': '', key: key },
            h('span', { 'data-fatigue-label': '' }, label),
            h('input', {
              type: 'checkbox',
              checked: !!config[key],
              onChange: function (e) {
                set(key, e.target.checked)
              },
            }),
            h('span', { 'data-fatigue-hint': '' }, hint),
          )
        }

        const phaseText =
          { awake: '清醒', resting: '休息中', 'deep-sleep': '深度睡眠中' }[snapshot && snapshot.phase] ||
          (snapshot && snapshot.phase) ||
          '—'

        return h(
          'div',
          { 'data-fatigue': '' },
          h(
            'div',
            { 'data-fatigue-status': '' },
            h('span', {}, '状态：', h('b', {}, phaseText)),
            h('span', {}, '24h 深度睡眠：', h('b', {}, fmtMinutes(snapshot && snapshot.deepSleepMinutes))),
            h('span', {}, '目标：', h('b', {}, fmtMinutes(snapshot && snapshot.targetSleepMinutes))),
            h('span', {}, '当前算力：', h('b', {}, String((snapshot && snapshot.computePercent) == null ? '—' : snapshot.computePercent) + '%')),
          ),
          h(
            'div',
            { 'data-fatigue-sec': '' },
            h('div', { 'data-fatigue-h': '' }, '睡眠判定'),
            num('targetSleepHours', '目标睡眠（小时）', '24 小时窗口内的深度睡眠目标，默认 8', 1, 24, 0.5),
            num('windowHours', '统计窗口（小时）', '滚动窗口长度，默认 24', 1, 168, 1),
            num('restIdleMinutes', '多久没任务算休息（分钟）', '默认 5', 1, 120, 1),
            num('deepSleepMinutes', '休息多久算深度睡眠（分钟）', '默认 40；不足按小憩折算', 5, 600, 5),
            num('napCreditRatio', '小憩折算比例', '小憩时长按这个比例补进深度睡眠，默认 0.5', 0, 1, 0.05),
          ),
          h(
            'div',
            { 'data-fatigue-sec': '' },
            h('div', { 'data-fatigue-h': '' }, '算力限制'),
            num('hoursPerStep', '每缺几小时算一档', '不足一档按一档算，默认 1', 0.1, 12, 0.1),
            num('reductionPerStep', '每档削减比例', '默认 0.125（1/8）', 0, 1, 0.01),
            num('minRatio', '算力最低保留', '默认 0.25（1/4）', 0.05, 1, 0.05),
            num('baseChunkDelayMs', '降速：每块基础延迟（毫秒）', '默认 25；设 0 = 不限速', 0, 200, 1),
            num('maxChunkDelayMs', '降速：单块延迟上限（毫秒）', '默认 120；设 0 = 不封顶', 0, 1000, 5),
            bool('enabled', '启用疲劳限制', '关掉后只记录睡眠，不限制算力'),
          ),
          h(
            'div',
            { 'data-fatigue-actions': '' },
            h('button', { type: 'button', onClick: save }, '保存'),
            h('button', { type: 'button', onClick: load }, '重新读取'),
            h('span', { 'data-fatigue-msg': '' }, message),
          ),
        )
      }

      function Broken(props) {
        return h('div', { 'data-fatigue': '' }, '疲劳与睡眠面板加载失败：' + String(props && props.error))
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          try {
            const style = document.createElement('style')
            style.setAttribute('data-plugin-css', 'dsh-fatigue')
            style.textContent = CSS
            document.head.appendChild(style)
            ctx.effect(function () {
              return function () {
                style.remove()
              }
            }, 'dsh-fatigue: settings css')

            const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
            if (!slots) {
              console.error('[dsh-fatigue] slots service unavailable')
              return
            }
            slots.inject('settings.section', function () {
              return slots.register(
                { name: 'settings.section', id: 'fatigue', order: 55, label: '疲劳与睡眠' },
                function () {
                  return h(Panel)
                },
              )
            })
          } catch (error) {
            console.error('[dsh-fatigue] settings registration failed', error)
            try {
              const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
              if (slots) {
                slots.register(
                  { name: 'settings.section', id: 'fatigue', order: 55, label: '疲劳与睡眠' },
                  function () {
                    return h(Broken, { error: error && error.message ? error.message : error })
                  },
                )
              }
            } catch (e2) {
              console.error('[dsh-fatigue] fallback registration failed', e2)
            }
          }
        },
      }
    },
  })
})()
