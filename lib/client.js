window.__ModuleLoader__.load({
	id: "dsh-session-handoff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
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
		const inject = [
			"slots",
			"sessions",
			"workspaces"
		];
		const READBACK = "D:\\deepseek-harness\\plugins\\dsh-session-handoff\\scripts\\readback.py";
		const SUCCESS_MARKER = "我已经成功接替了工作，请指示。";
		const FAIL_MARKER = "工作交接失败";
		const MANIFEST_TAG = "HANDOFF-MANIFEST:";
		const ITEM_FLAG = "data-dsh-handoff";
		const WATCHDOG_MS = 6e5;
		const MENU_POLL_MS = 400;
		/** 会话菜单语义锚（zh/en 双语；宿主升级改文案 → 菜单项缺席即 fail-soft 降级） */
		const SESSION_MENU_ANCHORS = [
			"归档会话",
			"分叉会话",
			"Archive session",
			"Fork session"
		];
		const TRIGGER_ARIA_RE = /^(会话“.+”的操作|Actions for “.+”)$/;
		function fiberSessionIdOf(el) {
			try {
				const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
				if (!key) return void 0;
				let fiber = el[key];
				for (let i = 0; i < 12 && fiber; i++) {
					const props = fiber.memoizedProps;
					const node = props?.node;
					const session = props?.session;
					if (typeof node?.id === "string") return node.id;
					if (typeof session?.id === "string") return session.id;
					fiber = fiber.return;
				}
			} catch {}
		}
		function titleFromAria(aria) {
			return (aria.match(/^会话“(.+)”的操作$/) ?? aria.match(/^Actions for “(.+)”$/))?.[1];
		}
		function sessionIdByTitle(ctx, title) {
			if (!title) return void 0;
			try {
				const byId = ctx.sessions?.list?.getSnapshot?.().byId;
				if (!byId) return void 0;
				const hits = Object.entries(byId).filter(([, info]) => info?.title === title);
				return hits.length === 1 ? hits[0][0] : void 0;
			} catch {
				return;
			}
		}
		function toast(text, ms = 15e3) {
			try {
				const div = document.createElement("div");
				div.setAttribute(ITEM_FLAG, "toast");
				div.textContent = text;
				Object.assign(div.style, {
					position: "fixed",
					right: "16px",
					bottom: "16px",
					zIndex: "9000",
					maxWidth: "420px",
					padding: "10px 14px",
					borderRadius: "8px",
					fontSize: "13px",
					background: "var(--dsw-alias-bg-layer-1,#161a22)",
					color: "var(--dsw-alias-label-primary,#e6e8eb)",
					border: "1px solid var(--dsw-alias-border-l1,#3a4150)",
					boxShadow: "0 4px 16px rgba(0,0,0,.4)",
					whiteSpace: "pre-wrap"
				});
				document.body.append(div);
				const heal = window.setInterval(() => {
					if (!div.isConnected) document.body.append(div);
				}, 1e3);
				window.setTimeout(() => {
					window.clearInterval(heal);
					div.remove();
				}, ms);
			} catch {}
		}
		function buildTakeoverPrompt(p) {
			const dir = `${p.cwd}\\.handoff\\${p.handoffDir}`;
			const presetNote = p.presetName !== void 0 && p.presetName !== "" ? `本会话已由用户指定预设「${p.presetName}」。` : "";
			return [
				"【会话接手协议 v1】你是接手会话。前一会话（" + p.oldId + "，标题「" + p.oldTitle + "」，工作区 " + p.cwd + "）已将其工作移交给你。" + presetNote + "按序执行，禁止跳步；除写交接包外不得改动仓库文件。",
				"",
				"1. 建立记忆索引（命令原样复制执行，直接用 python，不要用 PowerShell 改写/重构路径）：",
				"   python \"" + READBACK + "\" index " + p.oldId,
				"",
				"2. 用 read/search 模式读取全部关键内容（超长会话先 index 后定向读，控制读取量）：所有任务及状态（含最后 todo 与待用户确认项）；关键决策与理由、已证伪假设、证据指针（路径/SHA/测试数）；AGENTS.md 之外对话中积累的临时纪律；未闭环动作。",
				"",
				"3. 在 " + dir + " 下写八节交接包（每节一个 md 文件，内容具体）：",
				"   01-identity.md 身份与使命；02-rules.md 铁律与习惯（文件指针+临时纪律逐条）；",
				"   03-tasks.md 任务清单及状态；04-facts.md 事实与决策台账（已证伪假设必须保留）；",
				"   05-baseline.md 工作区基线（git branch + status --porcelain 摘要 + git stash create 零副作用回退点 hash）；",
				"   06-open.md 未闭环动作；07-next.md 下一步前3步；08-loss.md 信息丢失声明（含预设偏差，若适用）。",
				"",
				"4. 运行校验（同样原样执行）：",
				"   python \"" + READBACK + "\" verify " + dir,
				"",
				"5. 复刻度自检（写进最终回复）：逐字复述 02 铁律、逐项复述 03 任务状态、点名 04 至少 3 个证据指针。",
				"",
				"6. 最终回复（严格格式，其后不得有任何内容）：",
				"   成功 → 第一行：" + SUCCESS_MARKER,
				"          第二行：" + MANIFEST_TAG + " <verify 输出的目录>|01..08 齐备|sha256=<16位>",
				"   任一步失败 → 仅一行：" + FAIL_MARKER + "（附一行原因）",
				"",
				"之后静默，等待用户指令。"
			].join("\n");
		}
		var Orchestrator = class {
			ctx;
			timers = [];
			running = false;
			constructor(ctx) {
				this.ctx = ctx;
			}
			dispose() {
				for (const t of this.timers) window.clearInterval(t);
				this.timers = [];
				this.running = false;
			}
			run(trigger) {
				if (this.running) {
					toast("移交会话：已有一次移交在进行中，请等待其完成");
					return;
				}
				const c = this.ctx;
				const oldId = (trigger.el ? fiberSessionIdOf(trigger.el) : void 0) ?? sessionIdByTitle(c, titleFromAria(trigger.aria ?? "")) ?? c.sessions?.list?.getSnapshot?.().current;
				console.info("[session-handoff] run: click → oldId=" + (oldId ?? "null") + " via=" + (trigger.el && fiberSessionIdOf(trigger.el) ? "fiber" : trigger.aria ? "aria" : "current"));
				if (!oldId) {
					toast("移交会话：无法确定要移交的会话（结构探测失败）");
					return;
				}
				const info = c.sessions?.list?.getSnapshot?.().byId?.[oldId];
				if (!info?.cwd) {
					toast(`移交会话：会话 ${oldId} 无工作区信息`);
					return;
				}
				this.running = true;
				try {
					this.selectPresetThenInject(oldId, info);
				} catch (e) {
					this.running = false;
					toast(`移交会话：编排失败 ${String(e).slice(0, 120)}`);
				}
			}
			/**
			* v0.2.0 预设选择流程（方案 B：原生下拉即选择器）。
			* 状态机：find-chip（找芯片→点开 roster）→ choosing（侦测芯片文本变化=官方 applier 已应用）
			* → ready（下拉被收起未选：横幅二段，可重点芯片或直接开始）。
			* 纯增益兜底：芯片 45s 未现 → 按默认预设直接注入；全程 5 分钟超时取消。
			*/
			selectPresetThenInject(oldId, info) {
				const c = this.ctx;
				const started = Date.now();
				let phase = "resolve-ws";
				let chipBtn = null;
				let chipBaseText = null;
				let banner = null;
				let done = false;
				/** 工作区解析（三级回退）：sessionIds 精确归属 → path/cwd 与老会话 cwd 匹配（防御式探测）→ 失败明确报错。 */
				const resolveWsId = () => {
					const items = c.workspaces?.list?.getSnapshot?.().items ?? [];
					const hit = items.find((i) => i.sessionIds?.includes(oldId))?.workspaceId;
					if (hit !== void 0) return hit;
					const cwd = (info.cwd ?? "").toLowerCase();
					if (cwd !== "") {
						const byPath = items.find((i) => {
							const cand = i;
							const p = (cand.path ?? cand.cwd ?? cand.rootPath ?? "").toLowerCase();
							return p !== "" && (p === cwd || cwd.startsWith(p));
						})?.workspaceId;
						if (byPath !== void 0) return byPath;
					}
				};
				const buildPrompt = (presetName) => {
					const iso = (/* @__PURE__ */ new Date()).toISOString();
					const dirName = `handoff-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
					return buildTakeoverPrompt({
						oldId,
						oldTitle: info.title ?? "(无标题)",
						cwd: info.cwd ?? "",
						handoffDir: dirName,
						presetName
					});
				};
				const finishWith = (presetName, note) => {
					if (done) return;
					done = true;
					banner?.remove();
					banner = null;
					if (note) toast(note);
					this.watchNewSessionAndInject(oldId, void 0, buildPrompt(presetName));
				};
				const cancel = (reason) => {
					if (done) return;
					done = true;
					banner?.remove();
					banner = null;
					this.dispose();
					toast(`移交会话已取消：${reason}（空白会话闲置无害，可忽略）`);
				};
				const tick = window.setInterval(() => {
					if (done) return;
					try {
						if (Date.now() - started > 3e5) {
							console.info("[session-handoff] select: 5min 超时");
							cancel("选择超时（5 分钟）");
							return;
						}
						if (phase === "resolve-ws") {
							const wsId = resolveWsId();
							if (wsId !== void 0) {
								console.info("[session-handoff] select: wsId=" + wsId + " → startSession");
								c.workspaces?.startSession?.(wsId);
								phase = "find-chip";
							} else {
								const items = c.workspaces?.list?.getSnapshot?.().items ?? [];
								if (Math.round((Date.now() - started) / 5e3) % 3 === 0) console.debug("[session-handoff] select: 工作区解析中（items=" + items.length + "）");
								if (Date.now() - started > 45e3) cancel("无法定位该会话所属工作区（列表未含其归属）——请先打开该会话所在工作区后重试");
							}
							return;
						}
						const newId = c.sessions?.list?.getSnapshot?.().current;
						if (!newId || newId === oldId) {
							if (Math.round((Date.now() - started) / 5e3) % 6 === 0) console.debug("[session-handoff] select: 等待新会话落位（current=" + (newId ?? "null").slice(0, 20) + "）");
							if (Date.now() - started > 6e4) {
								console.info("[session-handoff] select: 60s 无新会话 → 取消");
								cancel("60 秒内新会话未落位");
								return;
							}
							return;
						}
						if (phase === "find-chip") {
							if (chipBtn === null) chipBtn = findPresetChip();
							if (chipBtn !== null) {
								chipBaseText = (chipBtn.textContent ?? "").trim();
								console.info("[session-handoff] select: 芯片命中「" + chipBaseText + "」→ 点击弹 roster");
								chipBtn.click();
								phase = "choosing";
								banner = new Banner(chipBaseText, () => {
									finishWith(void 0, "按当前预设直接移交");
								}, () => {
									cancel("用户取消");
								});
								console.info("[session-handoff] select: 横幅已创建，等待用户选择");
							} else {
								if (Math.round((Date.now() - started) / 5e3) % 3 === 0) console.debug("[session-handoff] select: 未找到预设芯片（继续探测，45s 后降级）");
								if (Date.now() - started > 45e3) {
									console.info("[session-handoff] select: 45s 无芯片 → 按默认预设直注");
									finishWith(void 0, "未找到预设芯片（宿主结构变化？），按默认预设移交");
								}
							}
							return;
						}
						const text = (chipBtn?.textContent ?? "").trim();
						if (chipBaseText !== null && text !== "" && text !== chipBaseText) {
							console.info("[session-handoff] select: 芯片文本变化 →「" + text + "」（官方 applier 已应用）");
							try {
								document.dispatchEvent(new KeyboardEvent("keydown", {
									key: "Escape",
									code: "Escape",
									bubbles: true
								}));
							} catch {}
							finishWith(text, `预设已切换：${text}`);
							return;
						}
						const menuOpen = document.querySelector("[role=menu]") !== null;
						if (phase === "choosing" && !menuOpen) {
							phase = "ready";
							banner?.phaseDismissed();
						} else if (phase === "ready" && menuOpen) {
							phase = "choosing";
							banner?.phaseChoosing();
						}
					} catch (e) {
						console.warn("[session-handoff] preset select error", e);
					}
				}, 1200);
				this.timers.push(tick);
			}
			watchNewSessionAndInject(oldId, oldPreset, prompt) {
				const c = this.ctx;
				const started = Date.now();
				let phase = "draft";
				let presetNoted = false;
				let clickTries = 0;
				let lastText = "";
				let lastTextAt = 0;
				const stop = (ok, reason) => {
					this.dispose();
					if (!ok) toast(`工作交接失败：${reason}`);
					else console.info("[session-handoff] 移交完成");
				};
				const tick = window.setInterval(() => {
					try {
						const newId = (c.sessions?.list?.getSnapshot?.())?.current;
						if (!presetNoted && newId && newId !== oldId) {
							presetNoted = true;
							if (oldPreset) try {
								c.sessions?.noteAgentPreset?.(newId, oldPreset);
							} catch {}
						}
						if (phase !== "done" && newId && newId !== oldId) {
							const ta = this.findComposer();
							if (!ta) {
								if (Date.now() - started > 6e4) {
									stop(false, "60 秒内未找到新会话输入框");
									return;
								}
							} else if (phase === "draft") {
								if (ta.value !== prompt) {
									(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set)?.call(ta, prompt);
									ta.dispatchEvent(new Event("input", { bubbles: true }));
								} else {
									const btn = this.findSendButton();
									if (btn && !btn.disabled && clickTries < 5) {
										clickTries += 1;
										btn.click();
										phase = "sent";
									} else if (btn && !btn.disabled && clickTries >= 5) {
										stop(false, "发送钮多次点击未生效");
										return;
									}
								}
							} else if (phase === "sent") {
								if (ta.value === "") phase = "done";
								else if (Date.now() - started > 9e4) {
									stop(false, "消息未能发出（草稿未清空）");
									return;
								}
							}
						}
						if (phase === "done") {
							if (Date.now() - started > WATCHDOG_MS) {
								this.tryCancelInflight();
								stop(false, `超时（${Math.round(WATCHDOG_MS / 6e4)} 分钟）`);
								return;
							}
							const text = this.lastAssistantText();
							if (text) {
								const norm = normalize(text);
								if (norm.includes(normalize(SUCCESS_MARKER)) && text.includes(MANIFEST_TAG)) {
									stop(true, "");
									return;
								}
								if (norm.includes(normalize(FAIL_MARKER))) {
									stop(false, "接手 agent 自报失败");
									return;
								}
								if (text === lastText) {
									if (Date.now() - lastTextAt > 15e3 && this.composerIdle()) {
										stop(false, "回合结束但最终回复缺少规定话术（协议违规）");
										return;
									}
								} else {
									lastText = text;
									lastTextAt = Date.now();
								}
							}
						}
					} catch (e) {
						console.warn("[session-handoff] watchdog error", e);
					}
				}, 1500);
				this.timers.push(tick);
			}
			/** composer 定位：发送钮同容器内的 textarea（无发送钮时回退全页唯一 textarea）。 */
			findComposer() {
				try {
					const ta = (this.findSendButton()?.closest("form, div"))?.querySelector("textarea") ?? document.querySelector("textarea");
					return ta && !ta.disabled ? ta : null;
				} catch {
					return null;
				}
			}
			findSendButton() {
				try {
					return document.querySelector("button[aria-label=\"发送消息\"], button[aria-label=\"Send message\"]");
				} catch {
					return null;
				}
			}
			/** 末条 assistant 消息文本（[data-chat-anchor-key]，非 user 即 assistant）。 */
			lastAssistantText() {
				try {
					const anchors = document.querySelectorAll("[data-chat-anchor-key]");
					for (let i = anchors.length - 1; i >= 0; i--) {
						const el = anchors[i];
						if (el.dataset.chatFlowKind !== "user") return el.textContent ?? "";
					}
				} catch {}
				return "";
			}
			composerIdle() {
				try {
					const btn = document.querySelector("button[aria-label=\"发送消息\"], button[aria-label=\"Send message\"]");
					return !!btn && !btn.disabled;
				} catch {
					return false;
				}
			}
			tryCancelInflight() {
				try {
					document.querySelector("button[aria-label*=\"停止\"], button[aria-label*=\"Stop\" i]")?.click();
				} catch {}
			}
		};
		function normalize(s) {
			return s.replaceAll(/[*#>`_~\s]/g, "");
		}
		const KNOWN_ARIA_EXCLUDE = /^(打开侧边栏|新建会话|添加工作区|搜索会话|导入会话|DevQuest 进度|选择工作区|重启当前会话|命令|访问模式|优化|发送消息|Send message|新建标签页|刷新|关闭|展开|停止|New tab|Reload|Close|Stop)/;
		function findPresetChip() {
			try {
				return Array.from(document.querySelectorAll("button")).filter((b) => b.getBoundingClientRect().width > 0).filter((b) => b.closest("aside, [class*=sidebar i]") === null).filter((b) => b.closest(`[${ITEM_FLAG}]`) === null).filter((b) => {
					const aria = b.getAttribute("aria-label") ?? "";
					return aria === "" || !KNOWN_ARIA_EXCLUDE.test(aria);
				}).filter((b) => (b.textContent ?? "").trim().length >= 4)[0] ?? null;
			} catch {
				return null;
			}
		}
		var Banner = class {
			div;
			label;
			heal;
			constructor(currentPreset, onStart, onCancel) {
				this.div = document.createElement("div");
				this.div.setAttribute(ITEM_FLAG, "banner");
				Object.assign(this.div.style, {
					position: "fixed",
					left: "50%",
					transform: "translateX(-50%)",
					bottom: "18px",
					zIndex: "9000",
					display: "flex",
					alignItems: "center",
					gap: "10px",
					padding: "10px 14px",
					borderRadius: "10px",
					maxWidth: "640px",
					fontSize: "13px",
					background: "var(--dsw-alias-bg-layer-1,#161a22)",
					color: "var(--dsw-alias-label-primary,#e6e8eb)",
					border: "1px solid var(--dsw-alias-border-l1,#3a4150)",
					boxShadow: "0 4px 16px rgba(0,0,0,.4)"
				});
				this.label = document.createElement("span");
				this.div.append(this.label);
				for (const [text, fn, primary] of [[
					"直接开始",
					onStart,
					true
				], [
					"取消",
					onCancel,
					false
				]]) {
					const btn = document.createElement("button");
					btn.type = "button";
					btn.textContent = text;
					Object.assign(btn.style, {
						flex: "none",
						padding: "4px 12px",
						borderRadius: "6px",
						cursor: "pointer",
						fontSize: "13px",
						border: "1px solid var(--dsw-alias-border-l1,#3a4150)",
						background: primary ? "var(--dsw-alias-state-accent-primary,#4f8ef7)" : "transparent",
						color: primary ? "#fff" : "inherit"
					});
					btn.addEventListener("click", fn);
					this.div.append(btn);
				}
				document.body.append(this.div);
				this.heal = window.setInterval(() => {
					if (!this.div.isConnected) document.body.append(this.div);
				}, 1e3);
				this.phaseChoosing(currentPreset);
			}
			phaseChoosing(currentPreset) {
				this.label.textContent = `移交会话：请在弹出的预设列表中选择接手模式（当前：${currentPreset}）——选中后自动开始移交`;
			}
			phaseDismissed() {
				this.label.textContent = "移交会话：未选择预设——点击页面上的预设芯片可重新选择，或直接开始";
			}
			remove() {
				if (this.heal !== void 0) window.clearInterval(this.heal);
				this.heal = void 0;
				this.div.remove();
			}
		};
		var MenuInjector = class {
			orchestrator;
			lastTrigger = { at: 0 };
			timer;
			onClickCapture;
			constructor(orchestrator) {
				this.orchestrator = orchestrator;
			}
			start() {
				if (this.timer !== void 0) return;
				this.onClickCapture = (e) => {
					try {
						const btn = e.target?.closest?.("button[aria-label]");
						const aria = btn?.getAttribute("aria-label") ?? "";
						if (TRIGGER_ARIA_RE.test(aria)) this.lastTrigger = {
							el: btn,
							aria,
							at: Date.now()
						};
					} catch {}
				};
				document.addEventListener("click", this.onClickCapture, true);
				this.timer = window.setInterval(() => this.scan(), MENU_POLL_MS);
			}
			/** 幂等保活：未运行则重启（v0.2.4：槽位壳每次挂载调用）。 */
			ensureRunning() {
				if (this.timer === void 0) this.start();
			}
			stop() {
				if (this.timer !== void 0) window.clearInterval(this.timer);
				this.timer = void 0;
				if (this.onClickCapture) document.removeEventListener("click", this.onClickCapture, true);
				this.onClickCapture = void 0;
			}
			scan() {
				try {
					const menu = document.querySelector("[role=menu]");
					if (!menu || menu.querySelector(`[${ITEM_FLAG}]`)) return;
					const items = Array.from(menu.querySelectorAll("[role=menuitem]"));
					if (!items.map((i) => i.textContent?.trim() ?? "").some((l) => SESSION_MENU_ANCHORS.includes(l)) || items.length === 0) return;
					const last = items[items.length - 1];
					const wrap = last.parentElement;
					if (!wrap || !wrap.parentElement) return;
					const cloneWrap = wrap.cloneNode(false);
					const btn = document.createElement("button");
					btn.type = "button";
					btn.setAttribute("role", "menuitem");
					btn.setAttribute(ITEM_FLAG, "item");
					btn.className = last.className;
					btn.textContent = "移交会话";
					btn.addEventListener("click", () => {
						this.closeMenu();
						const trig = Date.now() - this.lastTrigger.at < 3e3 ? this.lastTrigger : { at: 0 };
						this.orchestrator.run({
							el: trig.el,
							aria: trig.aria
						});
					});
					cloneWrap.append(btn);
					wrap.parentElement.append(cloneWrap);
					console.info("[session-handoff] menu: 已注入「移交会话」菜单项");
				} catch (e) {
					console.warn("[session-handoff] menu scan error", e);
				}
			}
			closeMenu() {
				try {
					document.dispatchEvent(new KeyboardEvent("keydown", {
						key: "Escape",
						code: "Escape",
						bubbles: true
					}));
				} catch {}
			}
		};
		function apply(ctx) {
			console.info("[session-handoff] client v0.2.5 loaded; ctx: slots=" + (ctx.slots !== void 0) + " sessions=" + (ctx.sessions !== void 0) + " workspaces=" + (ctx.workspaces !== void 0));
			const injector = new MenuInjector(new Orchestrator(ctx));
			injector.start();
			const HandoffSeat = () => {
				(0, react.useEffect)(() => {
					injector.ensureRunning();
					return () => {};
				}, []);
				return null;
			};
			ctx.slots?.inject("conversation.input.dock", () => ctx.slots?.register({
				name: "conversation.input.dock",
				id: "session-handoff",
				order: 40
			}, HandoffSeat));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map