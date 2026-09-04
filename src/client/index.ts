/**
 * dsh-session-handoff — client 半：会话工作移交。
 *
 * 组成（v0.1.1：注入器骨架校验合规化——client 必须走 slot 注册）：
 *  1. HandoffSeat   — conversation.input.dock 槽位组件（不可视壳），effect 内启停
 *                     MenuInjector/Orchestrator（React 托管生命周期，卸载即清理）。
 *  2. MenuInjector  — 轮询探测会话行 "..." 菜单（[role=menu] 含 归档会话/分叉会话 语义锚），
 *                     克隆注入第 4 项「移交会话」（临时节点随菜单关闭自然消亡，无需清扫）。
 *  3. Orchestrator  — startSession 建会话（同工作区，预设尽力继承）→ composer DOM 注入接手
 *                     首条消息（真实输入管线）→ 看门狗（话术归一化匹配 + manifest 行 + 超时）。
 *  4. toast         — 失败/编排错误提示（body 级 fixed，自愈重挂防清扫器）。
 *
 * 设计依据（2026-09-04 合同发现，dsh 0.1.1-rc.2 实证）：
 *  - 会话行触发钮 aria-label：会话“{name}”的操作（ui-workspace locales.ts:51）
 *  - 菜单容器 [role=menu]，条目 div.itemWrap > button[role=menuitem]（Menu.tsx:221,270）
 *  - startSession(workspaceId?)（client/runtime workspaces/service.ts:177）
 *  - 消息锚 [data-chat-anchor-key]，dataset.chatFlowKind==='user' 区分角色（turn-nav 同源）
 *  - 发送钮 button[aria-label="发送消息"]（实测 DOM dump）
 *  - DOM 注入活体实测 GO（锚点→菜单→注入→点击路由全链，%TEMP%\handoff-probe 存证）
 *  - 注入器骨架校验：inject 必含 'slots' + slots.register 白名单名（self-heal.log 定谳）
 *
 * 纪律：
 *  - fail-soft：所有宿主结构探测 try/catch，失败只 console.warn + 菜单项缺席，绝不 throw
 *  - 不监听 body subtree（turn-nav 2026-09-02 教训）；一律轻量轮询
 *  - 老会话零侵入（只读 transcript 路径引用），失败新会话保留
 */

import { useEffect } from 'react'

export const inject = ['slots', 'sessions', 'workspaces']

const READBACK = 'D:\\deepseek-harness\\plugins\\dsh-session-handoff\\scripts\\readback.py'
const SUCCESS_MARKER = '我已经成功接替了工作，请指示。'
const FAIL_MARKER = '工作交接失败'
const MANIFEST_TAG = 'HANDOFF-MANIFEST:'
const ITEM_FLAG = 'data-dsh-handoff'
const WATCHDOG_MS = 10 * 60 * 1000
const MENU_POLL_MS = 400
/** 会话菜单语义锚（zh/en 双语；宿主升级改文案 → 菜单项缺席即 fail-soft 降级） */
const SESSION_MENU_ANCHORS = ['归档会话', '分叉会话', 'Archive session', 'Fork session']
const TRIGGER_ARIA_RE = /^(会话“.+”的操作|Actions for “.+”)$/

// ---- 窄结构类型（只声明用到的面，全部 fail-soft 访问） ----
interface SessionInfo {
  title?: string
  cwd?: string
  agentPreset?: string
}
interface SessionsPort {
  list?: { getSnapshot?: () => { byId?: Record<string, SessionInfo>; current?: string } }
  noteAgentPreset?: (id: string, preset: string) => void
}
interface WorkspacesPort {
  startSession?: (workspaceId?: string) => void
  list?: { getSnapshot?: () => { items?: Array<{ workspaceId: string; sessionIds?: string[] }> } }
}
interface SlotsPort {
  inject: (name: string, factory: () => unknown) => unknown
  register: (config: { name: string; id?: string; order?: number }, component: unknown) => unknown
}
interface ClientCtx {
  sessions?: SessionsPort
  workspaces?: WorkspacesPort
  slots?: SlotsPort
}

// ---------------------------------------------------------------------------
// 会话身份解析：React fiber 精确路径优先，aria 标题 → 会话清单匹配兜底
// ---------------------------------------------------------------------------
function fiberSessionIdOf(el: HTMLElement): string | undefined {
  try {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    if (!key) return undefined
    type Fiber = { memoizedProps?: Record<string, unknown>; return?: Fiber }
    let fiber = (el as unknown as Record<string, Fiber>)[key]
    for (let i = 0; i < 12 && fiber; i++) {
      const props = fiber.memoizedProps
      const node = props?.node as { id?: unknown } | undefined
      const session = props?.session as { id?: unknown } | undefined
      if (typeof node?.id === 'string') return node.id
      if (typeof session?.id === 'string') return session.id
      fiber = fiber.return
    }
  } catch { /* fail-soft：结构变化即放弃精确路径 */ }
  return undefined
}

function titleFromAria(aria: string): string | undefined {
  const m = aria.match(/^会话“(.+)”的操作$/) ?? aria.match(/^Actions for “(.+)”$/)
  return m?.[1]
}

function sessionIdByTitle(ctx: ClientCtx, title: string | undefined): string | undefined {
  if (!title) return undefined
  try {
    const byId = ctx.sessions?.list?.getSnapshot?.().byId
    if (!byId) return undefined
    const hits = Object.entries(byId).filter(([, info]) => info?.title === title)
    return hits.length === 1 ? hits[0]![0] : undefined // 标题重复 → 放弃（防错人）
  } catch { return undefined }
}

// ---------------------------------------------------------------------------
// toast（body 级 fixed + 自愈重挂——清扫器防御，turn-nav 同款经验）
// ---------------------------------------------------------------------------
function toast(text: string, ms = 15000): void {
  try {
    const div = document.createElement('div')
    div.setAttribute(ITEM_FLAG, 'toast')
    div.textContent = text
    Object.assign(div.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '9000',
      maxWidth: '420px', padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
      background: 'var(--dsw-alias-bg-layer-1,#161a22)',
      color: 'var(--dsw-alias-label-primary,#e6e8eb)',
      border: '1px solid var(--dsw-alias-border-l1,#3a4150)',
      boxShadow: '0 4px 16px rgba(0,0,0,.4)', whiteSpace: 'pre-wrap',
    } satisfies Partial<CSSStyleDeclaration>)
    document.body.append(div)
    const heal = window.setInterval(() => {
      if (!div.isConnected) document.body.append(div)
    }, 1000)
    window.setTimeout(() => {
      window.clearInterval(heal)
      div.remove()
    }, ms)
  } catch { /* 最后一道防线：绝不让 toast 自身抛错 */ }
}

// ---------------------------------------------------------------------------
// 接手协议模板（与 protocols/takeover-v1.md 同构；v1, 2026-09-04）
// ---------------------------------------------------------------------------
function buildTakeoverPrompt(p: {
  oldId: string; oldTitle: string; cwd: string; handoffDir: string; presetName?: string
}): string {
  const dir = `${p.cwd}\\.handoff\\${p.handoffDir}`
  const presetNote = p.presetName !== undefined && p.presetName !== ''
    ? `本会话已由用户指定预设「${p.presetName}」。`
    : ''
  return [
    '【会话接手协议 v1】你是接手会话。前一会话（' + p.oldId + '，标题「' + p.oldTitle + '」，工作区 ' + p.cwd + '）已将其工作移交给你。' + presetNote + '按序执行，禁止跳步；除写交接包外不得改动仓库文件。',
    '',
    '1. 建立记忆索引（命令原样复制执行，直接用 python，不要用 PowerShell 改写/重构路径）：',
    '   python "' + READBACK + '" index ' + p.oldId,
    '',
    '2. 用 read/search 模式读取全部关键内容（超长会话先 index 后定向读，控制读取量）：所有任务及状态（含最后 todo 与待用户确认项）；关键决策与理由、已证伪假设、证据指针（路径/SHA/测试数）；AGENTS.md 之外对话中积累的临时纪律；未闭环动作。',
    '',
    '3. 在 ' + dir + ' 下写八节交接包（每节一个 md 文件，内容具体）：',
    '   01-identity.md 身份与使命；02-rules.md 铁律与习惯（文件指针+临时纪律逐条）；',
    '   03-tasks.md 任务清单及状态；04-facts.md 事实与决策台账（已证伪假设必须保留）；',
    '   05-baseline.md 工作区基线（git branch + status --porcelain 摘要 + git stash create 零副作用回退点 hash）；',
    '   06-open.md 未闭环动作；07-next.md 下一步前3步；08-loss.md 信息丢失声明（含预设偏差，若适用）。',
    '',
    '4. 运行校验（同样原样执行）：',
    '   python "' + READBACK + '" verify ' + dir,
    '',
    '5. 复刻度自检（写进最终回复）：逐字复述 02 铁律、逐项复述 03 任务状态、点名 04 至少 3 个证据指针。',
    '',
    '6. 最终回复（严格格式，其后不得有任何内容）：',
    '   成功 → 第一行：' + SUCCESS_MARKER,
    '          第二行：' + MANIFEST_TAG + ' <verify 输出的目录>|01..08 齐备|sha256=<16位>',
    '   任一步失败 → 仅一行：' + FAIL_MARKER + '（附一行原因）',
    '',
    '之后静默，等待用户指令。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
class Orchestrator {
  private timers: number[] = []
  private running = false

  constructor(private readonly ctx: ClientCtx) {}

  dispose(): void {
    for (const t of this.timers) window.clearInterval(t)
    this.timers = []
    this.running = false
  }

  run(trigger: { el?: HTMLElement; aria?: string }): void {
    if (this.running) { toast('移交会话：已有一次移交在进行中，请等待其完成'); return }
    const c = this.ctx
    const oldId = (trigger.el ? fiberSessionIdOf(trigger.el) : undefined)
      ?? sessionIdByTitle(c, titleFromAria(trigger.aria ?? ''))
      ?? c.sessions?.list?.getSnapshot?.().current
    console.info('[session-handoff] run: click → oldId=' + (oldId ?? 'null')
      + ' via=' + (trigger.el && fiberSessionIdOf(trigger.el) ? 'fiber' : trigger.aria ? 'aria' : 'current'))
    if (!oldId) { toast('移交会话：无法确定要移交的会话（结构探测失败）'); return }
    const info = c.sessions?.list?.getSnapshot?.().byId?.[oldId]
    const cwd = info?.cwd
    if (!cwd) { toast(`移交会话：会话 ${oldId} 无工作区信息`); return }

    this.running = true
    try {
      // v0.2.3：wsId 解析移入选择状态机（resolve-ws 相位）——修复"工作区列表未加载/归属缺失
      // 时 startSession(undefined)=sessions.clear() 空操作"的断链（60s 取消之根因）
      this.selectPresetThenInject(oldId, info)
    } catch (e) {
      this.running = false
      toast(`移交会话：编排失败 ${String(e).slice(0, 120)}`)
    }
  }

  /**
   * v0.2.0 预设选择流程（方案 B：原生下拉即选择器）。
   * 状态机：find-chip（找芯片→点开 roster）→ choosing（侦测芯片文本变化=官方 applier 已应用）
   * → ready（下拉被收起未选：横幅二段，可重点芯片或直接开始）。
   * 纯增益兜底：芯片 45s 未现 → 按默认预设直接注入；全程 5 分钟超时取消。
   */
  private selectPresetThenInject(oldId: string, info: SessionInfo): void {
    const c = this.ctx
    const started = Date.now()
    let phase: 'resolve-ws' | 'find-chip' | 'choosing' | 'ready' = 'resolve-ws'
    let chipBtn: HTMLButtonElement | null = null
    let chipBaseText: string | null = null
    let banner: Banner | null = null
    let done = false

    /** 工作区解析（三级回退）：sessionIds 精确归属 → path/cwd 与老会话 cwd 匹配（防御式探测）→ 失败明确报错。 */
    const resolveWsId = (): string | undefined => {
      const items = c.workspaces?.list?.getSnapshot?.().items ?? []
      const hit = items.find((i) => i.sessionIds?.includes(oldId))?.workspaceId
      if (hit !== undefined) return hit
      const cwd = (info.cwd ?? '').toLowerCase()
      if (cwd !== '') {
        const byPath = items.find((i) => {
          const cand = i as unknown as { path?: string; cwd?: string; rootPath?: string }
          const p = (cand.path ?? cand.cwd ?? cand.rootPath ?? '').toLowerCase()
          return p !== '' && (p === cwd || cwd.startsWith(p))
        })?.workspaceId
        if (byPath !== undefined) return byPath
      }
      return undefined
    }

    const buildPrompt = (presetName?: string): string => {
      const iso = new Date().toISOString()
      const dirName = `handoff-${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
      return buildTakeoverPrompt({
        oldId,
        oldTitle: info.title ?? '(无标题)',
        cwd: info.cwd ?? '',
        handoffDir: dirName,
        presetName,
      })
    }
    const finishWith = (presetName: string | undefined, note?: string): void => {
      if (done) return
      done = true
      banner?.remove()
      banner = null
      if (note) toast(note)
      // oldPreset 传 undefined：预设已由用户显式选定或为默认，无需旧值标注
      this.watchNewSessionAndInject(oldId, undefined, buildPrompt(presetName))
    }
    const cancel = (reason: string): void => {
      if (done) return
      done = true
      banner?.remove()
      banner = null
      this.dispose()
      toast(`移交会话已取消：${reason}（空白会话闲置无害，可忽略）`)
    }

    const tick = window.setInterval(() => {
      if (done) return
      try {
        if (Date.now() - started > 5 * 60 * 1000) { console.info('[session-handoff] select: 5min 超时'); cancel('选择超时（5 分钟）'); return }
        if (phase === 'resolve-ws') {
          const wsId = resolveWsId()
          if (wsId !== undefined) {
            console.info('[session-handoff] select: wsId=' + wsId + ' → startSession')
            c.workspaces?.startSession?.(wsId)
            phase = 'find-chip'
          } else {
            const items = c.workspaces?.list?.getSnapshot?.().items ?? []
            if (Math.round((Date.now() - started) / 5000) % 3 === 0) {
              console.debug('[session-handoff] select: 工作区解析中（items=' + items.length + '）')
            }
            if (Date.now() - started > 45000) {
              cancel('无法定位该会话所属工作区（列表未含其归属）——请先打开该会话所在工作区后重试')
            }
          }
          return
        }
        const newId = c.sessions?.list?.getSnapshot?.().current
        if (!newId || newId === oldId) {
          if (Math.round((Date.now() - started) / 5000) % 6 === 0) {
            console.debug('[session-handoff] select: 等待新会话落位（current=' + (newId ?? 'null').slice(0, 20) + '）')
          }
          if (Date.now() - started > 60000) { console.info('[session-handoff] select: 60s 无新会话 → 取消'); cancel('60 秒内新会话未落位'); return }
          return
        }
        if (phase === 'find-chip') {
          if (chipBtn === null) chipBtn = findPresetChip()
          if (chipBtn !== null) {
            chipBaseText = (chipBtn.textContent ?? '').trim()
            console.info('[session-handoff] select: 芯片命中「' + chipBaseText + '」→ 点击弹 roster')
            chipBtn.click()
            phase = 'choosing'
            banner = new Banner(chipBaseText,
              () => { finishWith(undefined, '按当前预设直接移交') },
              () => { cancel('用户取消') })
            console.info('[session-handoff] select: 横幅已创建，等待用户选择')
          } else {
            if (Math.round((Date.now() - started) / 5000) % 3 === 0) {
              console.debug('[session-handoff] select: 未找到预设芯片（继续探测，45s 后降级）')
            }
            if (Date.now() - started > 45000) {
              console.info('[session-handoff] select: 45s 无芯片 → 按默认预设直注')
              finishWith(undefined, '未找到预设芯片（宿主结构变化？），按默认预设移交')
            }
          }
          return
        }
        // choosing / ready：芯片文本变化 = 官方 applier 已应用所选预设
        const text = (chipBtn?.textContent ?? '').trim()
        if (chipBaseText !== null && text !== '' && text !== chipBaseText) {
          console.info('[session-handoff] select: 芯片文本变化 →「' + text + '」（官方 applier 已应用）')
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })) } catch { /* 下拉选中后本就自关 */ }
          finishWith(text, `预设已切换：${text}`)
          return
        }
        const menuOpen = document.querySelector('[role=menu]') !== null
        if (phase === 'choosing' && !menuOpen) {
          phase = 'ready'
          banner?.phaseDismissed()
        } else if (phase === 'ready' && menuOpen) {
          phase = 'choosing' // 用户重新点开了芯片
          banner?.phaseChoosing()
        }
      } catch (e) {
        console.warn('[session-handoff] preset select error', e)
      }
    }, 1200)
    this.timers.push(tick)
  }

  private watchNewSessionAndInject(oldId: string, oldPreset: string | undefined, prompt: string): void {
    const c = this.ctx
    const started = Date.now()
    let phase: 'draft' | 'sent' | 'done' = 'draft'
    let presetNoted = false
    let clickTries = 0
    let lastText = ''
    let lastTextAt = 0

    const stop = (ok: boolean, reason: string): void => {
      this.dispose()
      if (!ok) toast(`工作交接失败：${reason}`)
      else console.info('[session-handoff] 移交完成')
    }

    const tick = window.setInterval(() => {
      try {
        const snap = c.sessions?.list?.getSnapshot?.()
        const newId = snap?.current
        // ① 新会话就位：尽力 note 预设（B 尽力语义）
        if (!presetNoted && newId && newId !== oldId) {
          presetNoted = true
          if (oldPreset) {
            try { c.sessions?.noteAgentPreset?.(newId, oldPreset) } catch { /* 尽力而为 */ }
          }
        }
        // ② 消息注入状态机：draft（写草稿→点发送）→ sent（草稿被清空=已发出）
        if (phase !== 'done' && newId && newId !== oldId) {
          const ta = this.findComposer()
          if (!ta) {
            if (Date.now() - started > 60000) { stop(false, '60 秒内未找到新会话输入框'); return }
          } else if (phase === 'draft') {
            if (ta.value !== prompt) {
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
              setter?.call(ta, prompt)
              ta.dispatchEvent(new Event('input', { bubbles: true }))
            } else {
              // 草稿已写入且发送钮已激活 → 点击
              const btn = this.findSendButton()
              if (btn && !btn.disabled && clickTries < 5) {
                clickTries += 1
                btn.click()
                phase = 'sent'
              } else if (btn && !btn.disabled && clickTries >= 5) {
                stop(false, '发送钮多次点击未生效'); return
              }
            }
          } else if (phase === 'sent') {
            if (ta.value === '') { phase = 'done' } // 草稿被清空 = 消息已进入管线
            else if (Date.now() - started > 90000) { stop(false, '消息未能发出（草稿未清空）'); return }
          }
        }
        // ③ 看门狗：末条 assistant 消息判定（注入完成后启动）
        if (phase === 'done') {
          if (Date.now() - started > WATCHDOG_MS) {
            this.tryCancelInflight()
            stop(false, `超时（${Math.round(WATCHDOG_MS / 60000)} 分钟）`)
            return
          }
          const text = this.lastAssistantText()
          if (text) {
            const norm = normalize(text)
            if (norm.includes(normalize(SUCCESS_MARKER)) && text.includes(MANIFEST_TAG)) {
              stop(true, '')
              return
            }
            if (norm.includes(normalize(FAIL_MARKER))) {
              stop(false, '接手 agent 自报失败')
              return
            }
            // 协议违规：文本已稳定 15s 且回合结束（发送钮可用）却无话术
            if (text === lastText) {
              if (Date.now() - lastTextAt > 15000 && this.composerIdle()) {
                stop(false, '回合结束但最终回复缺少规定话术（协议违规）')
                return
              }
            } else {
              lastText = text
              lastTextAt = Date.now()
            }
          }
        }
      } catch (e) {
        console.warn('[session-handoff] watchdog error', e)
      }
    }, 1500)
    this.timers.push(tick)
  }

  /** composer 定位：发送钮同容器内的 textarea（无发送钮时回退全页唯一 textarea）。 */
  private findComposer(): HTMLTextAreaElement | null {
    try {
      const btn = this.findSendButton()
      const holder = btn?.closest('form, div')
      const ta = (holder?.querySelector('textarea') ?? document.querySelector('textarea')) as HTMLTextAreaElement | null
      return ta && !ta.disabled ? ta : null
    } catch { return null }
  }

  private findSendButton(): HTMLButtonElement | null {
    try {
      return document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"], button[aria-label="Send message"]')
    } catch { return null }
  }

  /** 末条 assistant 消息文本（[data-chat-anchor-key]，非 user 即 assistant）。 */
  private lastAssistantText(): string {
    try {
      const anchors = document.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
      for (let i = anchors.length - 1; i >= 0; i--) {
        const el = anchors[i]!
        if (el.dataset.chatFlowKind !== 'user') return el.textContent ?? ''
      }
    } catch { /* fail-soft */ }
    return ''
  }

  private composerIdle(): boolean {
    try {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"], button[aria-label="Send message"]')
      return !!btn && !btn.disabled
    } catch { return false }
  }

  private tryCancelInflight(): void {
    try {
      const stopBtn = document.querySelector<HTMLButtonElement>(
        'button[aria-label*="停止"], button[aria-label*="Stop" i]')
      stopBtn?.click()
    } catch { /* 尽力而为 */ }
  }
}

function normalize(s: string): string {
  return s.replaceAll(/[*#>`_~\s]/g, '')
}

// ---------------------------------------------------------------------------
// 预设芯片探测（v0.2.0 方案 B）：新会话 hero 区、非侧栏、排除已知功能钮后
// 剩余的带文本按钮即预设芯片（实测形态：文本=预设显示名，如 "Router Standard (experimental)"）。
// fail-soft：探测不到 → 45s 后按默认预设直接移交（v0.1.2 原行为）。
// ---------------------------------------------------------------------------
const KNOWN_ARIA_EXCLUDE = /^(打开侧边栏|新建会话|添加工作区|搜索会话|导入会话|DevQuest 进度|选择工作区|重启当前会话|命令|访问模式|优化|发送消息|Send message|新建标签页|刷新|关闭|展开|停止|New tab|Reload|Close|Stop)/

function findPresetChip(): HTMLButtonElement | null {
  try {
    const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter((b) => b.getBoundingClientRect().width > 0)
      .filter((b) => b.closest('aside, [class*=sidebar i]') === null)
      .filter((b) => b.closest(`[${ITEM_FLAG}]`) === null)
      .filter((b) => {
        const aria = b.getAttribute('aria-label') ?? ''
        return aria === '' || !KNOWN_ARIA_EXCLUDE.test(aria)
      })
      .filter((b) => (b.textContent ?? '').trim().length >= 4)
    return candidates[0] ?? null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// 选择横幅（v0.2.0）：底部居中 fixed，自愈重挂（清扫器防御）；两段文案 + 两钮。
// ---------------------------------------------------------------------------
class Banner {
  private readonly div: HTMLDivElement
  private readonly label: HTMLSpanElement
  private heal: number | undefined

  constructor(currentPreset: string, onStart: () => void, onCancel: () => void) {
    this.div = document.createElement('div')
    this.div.setAttribute(ITEM_FLAG, 'banner')
    Object.assign(this.div.style, {
      position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: '18px', zIndex: '9000',
      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderRadius: '10px',
      maxWidth: '640px', fontSize: '13px',
      background: 'var(--dsw-alias-bg-layer-1,#161a22)',
      color: 'var(--dsw-alias-label-primary,#e6e8eb)',
      border: '1px solid var(--dsw-alias-border-l1,#3a4150)',
      boxShadow: '0 4px 16px rgba(0,0,0,.4)',
    } satisfies Partial<CSSStyleDeclaration>)
    this.label = document.createElement('span')
    this.div.append(this.label)
    for (const [text, fn, primary] of [['直接开始', onStart, true], ['取消', onCancel, false]] as const) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = text
      Object.assign(btn.style, {
        flex: 'none', padding: '4px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l1,#3a4150)',
        background: primary ? 'var(--dsw-alias-state-accent-primary,#4f8ef7)' : 'transparent',
        color: primary ? '#fff' : 'inherit',
      } satisfies Partial<CSSStyleDeclaration>)
      btn.addEventListener('click', fn)
      this.div.append(btn)
    }
    document.body.append(this.div)
    this.heal = window.setInterval(() => {
      if (!this.div.isConnected) document.body.append(this.div)
    }, 1000)
    this.phaseChoosing(currentPreset)
  }

  phaseChoosing(currentPreset: string): void {
    this.label.textContent = `移交会话：请在弹出的预设列表中选择接手模式（当前：${currentPreset}）——选中后自动开始移交`
  }

  phaseDismissed(): void {
    this.label.textContent = '移交会话：未选择预设——点击页面上的预设芯片可重新选择，或直接开始'
  }

  remove(): void {
    if (this.heal !== undefined) window.clearInterval(this.heal)
    this.heal = undefined
    this.div.remove()
  }
}

// ---------------------------------------------------------------------------
// MenuInjector：轻量轮询（不监听 body subtree——2026-09-02 turn-nav 教训）
// ---------------------------------------------------------------------------
class MenuInjector {
  private lastTrigger: { el?: HTMLElement; aria?: string; at: number } = { at: 0 }
  private timer: number | undefined
  private onClickCapture: ((e: MouseEvent) => void) | undefined

  constructor(private readonly orchestrator: Orchestrator) {}

  start(): void {
    if (this.timer !== undefined) return // 幂等：已运行则不重复启动
    // 捕获最近一次点击的会话触发钮（capture 阶段，菜单打开前记录身份线索）
    this.onClickCapture = (e: MouseEvent): void => {
      try {
        const btn = (e.target as HTMLElement | null)?.closest?.('button[aria-label]')
        const aria = btn?.getAttribute('aria-label') ?? ''
        if (TRIGGER_ARIA_RE.test(aria)) {
          this.lastTrigger = { el: btn as HTMLElement, aria, at: Date.now() }
        }
      } catch { /* fail-soft */ }
    }
    document.addEventListener('click', this.onClickCapture, true)
    this.timer = window.setInterval(() => this.scan(), MENU_POLL_MS)
  }

  /** 幂等保活：未运行则重启（v0.2.4：槽位壳每次挂载调用）。 */
  ensureRunning(): void {
    if (this.timer === undefined) this.start()
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
    if (this.onClickCapture) document.removeEventListener('click', this.onClickCapture, true)
    this.onClickCapture = undefined
  }

  private scan(): void {
    try {
      const menu = document.querySelector('[role=menu]')
      if (!menu || menu.querySelector(`[${ITEM_FLAG}]`)) return
      const items = Array.from(menu.querySelectorAll('[role=menuitem]'))
      const labels = items.map((i) => i.textContent?.trim() ?? '')
      const isSessionMenu = labels.some((l) => SESSION_MENU_ANCHORS.includes(l))
      if (!isSessionMenu || items.length === 0) return
      const last = items[items.length - 1]!
      const wrap = last.parentElement
      if (!wrap || !wrap.parentElement) return
      const cloneWrap = wrap.cloneNode(false) as HTMLElement
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('role', 'menuitem')
      btn.setAttribute(ITEM_FLAG, 'item')
      btn.className = last.className
      btn.textContent = '移交会话'
      btn.addEventListener('click', () => {
        this.closeMenu()
        // 仅认 3 秒内的触发记录（防误配到上一次开菜单）
        const trig = Date.now() - this.lastTrigger.at < 3000 ? this.lastTrigger : { at: 0 }
        this.orchestrator.run({ el: trig.el, aria: trig.aria })
      })
      cloneWrap.append(btn)
      wrap.parentElement.append(cloneWrap)
      console.info('[session-handoff] menu: 已注入「移交会话」菜单项')
    } catch (e) {
      console.warn('[session-handoff] menu scan error', e)
    }
  }

  private closeMenu(): void {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true,
      }))
    } catch { /* 菜单本就 transient，关闭失败无碍 */ }
  }
}

// ---------------------------------------------------------------------------
// 槽位壳：不可视组件，effect 内启停注入器与编排器（React 托管生命周期）
// ---------------------------------------------------------------------------
export function apply(ctx: ClientCtx): void {
  // 版本自报 + ctx 服务面自检（排查 sessions/workspaces 未注入类问题）
  console.info('[session-handoff] client v0.2.5 loaded; ctx: slots=' + (ctx.slots !== undefined)
    + ' sessions=' + (ctx.sessions !== undefined) + ' workspaces=' + (ctx.workspaces !== undefined))
  // v0.2.4：编排器/注入器为页面级单例——移交会触发"对话视图→新会话 hero"的组件卸载，
  // 若状态活在槽位 useEffect 内，startSession 后即被 cleanup 杀死（面包屑实证：
  // 末条日志=startSession 后静默）。页面级生命周期与 turn-nav apply 层先例一致。
  const orchestrator = new Orchestrator(ctx)
  const injector = new MenuInjector(orchestrator)
  injector.start()
  const HandoffSeat = (): null => {
    useEffect(() => {
      injector.ensureRunning() // 幂等保活（防异常卸载后失活）
      // 刻意不在 cleanup 停编排器：移交流程必须活过它自己触发的视图切换
      return () => { }
    }, [])
    return null
  }
  ctx.slots?.inject('conversation.input.dock', () =>
    ctx.slots?.register({ name: 'conversation.input.dock', id: 'session-handoff', order: 40 }, HandoffSeat))
}
