# dsh-session-handoff

会话工作移交：dsh Web 会话列表 "..." 菜单新增**「移交会话」**，一键在同工作区创建新会话
（默认预设，尽力继承老会话预设）并自动完成**八节交接包**接手——新会话复刻老会话的记忆、
习惯、任务、铁律（结构化保真），上下文保持轻量（不携带原始对话，经 readback 脚本按需回溯）。


## 安装 / Install

```sh
dsh plugin --profile web add dsh-session-handoff
```

Web profile 重启（或在 dshmarket 中启用）后生效；浏览器 Console 出现
`[session-handoff] client v0.2.6 loaded; ctx: slots=true sessions=true workspaces=true`
版本行即加载成功（菜单注入成功时还会打印一条 `menu: 已注入「移交会话」`）。

> Session handoff for DeepSeek Harness: the session row "..." menu gains
> *Hand off session* - one click creates a successor session that rebuilds
> the old session's memory, tasks and rules through an eight-section
> takeover packet, while context stays light (original transcript is read
> back on demand).

## 交互契约（v0.2.x：预设选择 + 全自动移交）

1. 会话行 "..." → **移交会话**（第 4 项，位于 归档会话 之后）；
2. 同工作区自动建新会话 → **自动弹开原生预设 roster（方案 B）**：底部横幅引导，
   用户点选任一预设（如标准→创造模式接手）→ 官方 applier 应用 → 自动继续；
   「直接开始」= 用当前预设；「取消」= 中止；5 分钟超时自动取消；
3. 预设应用后自动注入接手首条消息（真实输入管线）→ agent 执行接手协议 v1；
4. 成功 → 新会话回复「我已经成功接替了工作，请指示。」+ HANDOFF-MANIFEST 行；
   失败 → 「工作交接失败」（附原因；插件看门狗兜底补发 toast）；
5. 老会话**零侵入**（不归档、不注入消息）；失败的新会话**保留**供排查；全程静默。

## 组成

| 件 | 位置 | 职责 |
| --- | --- | --- |
| client 半 | `src/client/index.ts` | 菜单注入（[role=menu] 语义锚 + 克隆注入）、**页面级单例编排器**（v0.2.4：不随视图切换销毁——移交自身触发的"对话→hero"卸载不再杀死流程）、预设选择状态机（resolve-ws 三级回退→find-chip→choosing→ready）、看门狗（话术归一化 + manifest 双证据 + 超时取消）、toast/横幅 |
| host 半 | `src/index.ts` | 空 apply（turn-nav 同款，仅占 Loader 位） |
| readback | `scripts/readback.py` | 老会话 transcript（zstd）读取：index 提纲 / read 区间 / search 检索 / verify 八节校验；uuid 白名单 + realpath 边界 |
| 协议 | `protocols/takeover-v1.md` | 接手协议 v1（人类可读版 + 降级通道说明） |

## 降级通道（显式契约）

菜单项失效（宿主结构变化/文案变更）时**不致命**：手动新建会话，粘贴
`protocols/takeover-v1.md` 的模板，填实 4 个占位符（OLD_ID/CWD/HANDOFF_DIR/READBACK）
即可人工触发同一流程。

## 看门狗（事件驱动 + 超时兜底，默认 10 分钟）

成功判定 = 归一化话术匹配 **且** HANDOFF-MANIFEST 行存在（双证据）；
协议违规/回合异常结束 = 秒级判失败；超时 = 取消在飞回合 + toast 补发。

## 构建

```bash
DSH_CHECKOUT=D:/deepseek-harness npm run build   # tsc（host 半）+ tsdown（client bundle）
```

## 准入纪律

开发期仅 super-injector registry 挂载；验收通过 → `check-plugin-ready` 0 FAIL →
单向迁移（registry 移除 → profile bundles 加入）。宿主版本 pin 0.1.1-rc.2。


## 本机适配（readback 路径）

接手提示里带一条 readback 命令，路径取自 `src/client/index.ts` 顶部的 `READBACK` 常量
（默认是作者本机的绝对路径）。装到别的机器时请改成自己插件目录下的
`.../plugins/dsh-session-handoff/scripts/readback.py`，否则新会话回溯旧会话时会报路径不存在；
也可以只改构建产物 `lib/client.js` 里的同一个常量，不必重新构建。


## 已知边界（实测沉淀）

- **看门狗随发起页存活**：关闭发起移交的浏览器页会停掉看门狗（agent 本身继续跑完，但无自动判定/超时取消）——移交发起后别关该页；
- **浏览器模块缓存**：插件升级后老标签页可能仍跑旧代码，表现为行为异常——关标签重开即可（Console 版本行可判别）；
- **工作区解析**：快照未含会话归属时轮询 45 秒后明确报错（绝不空跑 startSession）；
- **日志**：加载/菜单注入/点击/芯片命中/横幅为 info 级；周期等待为 debug 级（默认隐藏）。

## 版本履历

- 0.2.6 会话行定位改按触发钮归属判定（工作区菜单同样含「归档会话」文案）→ 会话 id 走
  data-row-key，建会话改用 sessions.create + uiWorkspace.openSession（宿主 startSession 会
  复用空白会话，等于不新建）→ 落位判定改 mainReference（sessions.list.current 恒为 null）
  → 输入框兼容 Lexical contenteditable + 草稿按长度判定 → 菜单项加绿色图标（不再继承
  「删除会话」的 danger 红）
- 0.1.0 首版（纯 DOM，被注入器骨架校验拒收）→ 0.1.1 slot 壳合规 → 0.1.2 两阶段提交修复（空草稿发送钮 disabled）→ 0.2.0 预设选择（方案 B）→ 0.2.1 版本自报日志 → 0.2.2 面包屑诊断 → 0.2.3 工作区解析三级回退 → 0.2.4 页面级单例（视图切换死亡修复）→ 0.2.5 安静日志 + 协议命令加固
