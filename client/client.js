window.__ModuleLoader__.load({
	id: "dsh-film",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region src/client/artwork.tsx
		/**
		* The workbench: a clapperboard over a frame.
		* @param props - icon size and layout class from the Host.
		* @returns the artwork.
		*/
		function ArtworkStudio({ size = 36, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				className,
				"aria-hidden": "true",
				viewBox: "0 0 36 36",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "6.5",
						y: "13",
						width: "23",
						height: "15",
						rx: "2.5",
						stroke: "#F28B5B",
						strokeWidth: "2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M6.5 18.5H29.5",
						stroke: "#F8B48F",
						strokeWidth: "2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M9 13L11.5 7.5H15.5L13 13M16.5 13L19 7.5H23L20.5 13",
						stroke: "#F28B5B",
						strokeWidth: "2",
						strokeLinejoin: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M13 23.5L18.5 26.5L13 29.5V23.5Z",
						fill: "#F8B48F"
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** The two languages the Host can ask for; anything else falls back to English. */
		const zh = {
			"tab.title": "影视工作台",
			"tab.guide.description": "小说拆解、剧本、画布、导演台与剪辑，模型使用已登录的 VibeDev 账号",
			"app.loading": "影视工作台加载中",
			"app.failed": "影视工作台没有启动成功。",
			"app.retry": "重试",
			"app.hint": "若一直失败，请在插件设置里确认已启用 VibeDev 账号插件。",
			"app.lost": "工作台服务在两分钟内多次断开，已停止自动重连。点\"重试\"再开一次；若仍断开，请把数据目录 logs 里最新的日志发给我们。"
		};
		const en = {
			"tab.title": "Film Studio",
			"tab.guide.description": "Novel breakdown, screenplay, storyboard, director desk and editing, on the signed-in VibeDev account",
			"app.loading": "Loading Film Studio",
			"app.failed": "Film Studio did not start.",
			"app.retry": "Retry",
			"app.hint": "If it keeps failing, check that the VibeDev account plugin is enabled.",
			"app.lost": "The workbench service dropped several times in two minutes, so automatic reconnection stopped. Press Retry to open it again; if it keeps dropping, send us the newest log from the data directory."
		};
		//#endregion
		//#region src/client/TabBody.tsx
		/**
		* The tab body: the whole workbench in a frame, kept alive for as long as the tab.
		*
		* Lifecycle, as the user sees it:
		* - Opening plays a render animation; the frame loads behind it and appears
		*   only when the workbench says its canvas is on screen (`ready`), so there is
		*   no "starting…" text, no white flash and no second loading state.
		* - The tab type is `keepMounted`: hiding the tab, switching sessions or moving
		*   it between panes keeps the frame as it is — nothing reloads.
		* - Closing the tab (×) first asks the page to save everything, then removes
		*   the frame and releases this tab's hold on the workbench process; the plugin
		*   stops the process shortly after the last tab let go. The frame is moved
		*   (`moveBefore`, which keeps it alive) into a hidden holder for that final
		*   save, so closing can never cut a save short.
		*
		* The workbench is a separate local process on its own loopback origin; its
		* session link comes from this plugin's own route, never guessed.
		*/
		const CHANNEL = "vibedev-film";
		/** Longest a closing tab waits for the page's final save. */
		const FLUSH_TIMEOUT_MS = 4e3;
		/** A body unmounted and mounted again this quickly (renderer, strict mode) keeps its frame. */
		const REMOUNT_GRACE_MS = 600;
		/** A page that never says `ready` (an older build, an error page) is shown after this long. */
		const SHOW_FALLBACK_MS = 6e3;
		/** How long to wait for the session's workspace before opening the project center instead. */
		const WORKSPACE_WAIT_MS = 1500;
		/**
		* The address to put in the frame.
		*
		* A cookie set inside a cross-origin frame may not be kept, so the session token
		* travels in the path (`/s/<token>/…`) and the app's relative requests carry it.
		* Other query parameters (the workspace to open) are kept, and `filmHost` names
		* this page's origin: the only origin the workbench talks to over postMessage.
		* `filmSession` names the VibeDev conversation the tab belongs to: "帮写" and the
		* workbench's other one-shot writing use that conversation's current model.
		* @param url - the entry link the host handed out.
		* @param host - this page's origin, when the frame should talk to it.
		* @param sessionId - the conversation the tab belongs to.
		* @returns the frame address, or the link itself when it carries no token.
		*/
		function frameAddress(url, host, sessionId) {
			try {
				const parsed = new URL(url);
				const token = parsed.searchParams.get("filmAccess");
				if (token === null || !/^[a-f0-9]{64}$/.test(token)) return url;
				const query = new URLSearchParams(parsed.searchParams);
				query.delete("filmAccess");
				if (host !== void 0) query.set("filmHost", host);
				if (sessionId !== void 0 && sessionId !== "") query.set("filmSession", sessionId);
				const suffix = query.size === 0 ? "" : `?${query.toString()}`;
				return `${parsed.origin}/s/${token}/${suffix}${parsed.hash}`;
			} catch {
				return url;
			}
		}
		/** `dsh-resource://file/session/<id>/<path>`: how the Host's own preview names a file of this session. */
		function fileAddressFor(sessionId, workspace, path) {
			const encode = (value) => value.split("/").map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":")).join("/");
			const normalized = path.replace(/\\/g, "/");
			const root = workspace?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
			const relative = root !== "" && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
			return `dsh-resource://file/session/${encode(sessionId)}/${encode(relative)}`;
		}
		/** The workbench frame to send "add these media" to: this session's first, then any. */
		function frameFor(sessionId) {
			const live = [...frames.values()].filter((frame) => frame.ready && !frame.parked && frame.element.isConnected);
			return live.find((frame) => frame.sessionId === sessionId) ?? live[0];
		}
		/**
		* Media gallery "add to canvas": hand absolute paths to the open workbench,
		* opening it in this session first when none is open.
		* @param paths - absolute media file paths.
		* @param sessionId - the session the request came from, if known.
		* @param openTab - opens the workbench tab in that session.
		* @returns what the canvas reported.
		*/
		async function addMediaToCanvas(paths, sessionId, openTab) {
			let frame = frameFor(sessionId);
			if (frame === void 0 && sessionId !== void 0) {
				openTab(sessionId);
				const deadline = Date.now() + 45e3;
				while (frame === void 0 && Date.now() < deadline) {
					await new Promise((resume) => setTimeout(resume, 300));
					frame = frameFor(sessionId);
				}
			}
			if (frame === void 0) return {
				ok: false,
				message: "请先在侧栏打开影视工作台，并进入一个项目的画布"
			};
			const target = frame;
			const id = `${Date.now()}-${Math.random()}`;
			return new Promise((resolve) => {
				const done = (result) => {
					clearTimeout(timer);
					window.removeEventListener("message", onMessage);
					resolve(result);
				};
				const onMessage = (event) => {
					const data = event.data;
					if (event.source !== target.element.contentWindow || data?.channel !== CHANNEL || data.type !== "addMediaResult" || data.id !== id) return;
					done({
						ok: data.ok === true,
						...typeof data.added === "number" ? { added: data.added } : {},
						...Array.isArray(data.failed) ? { failed: data.failed } : {},
						...typeof data.message === "string" ? { message: data.message } : {}
					});
				};
				const timer = setTimeout(() => {
					done({
						ok: false,
						message: "影视工作台没有回应，请稍后重试"
					});
				}, 6e5);
				window.addEventListener("message", onMessage);
				post(target, {
					type: "addMedia",
					id,
					paths: [...paths]
				});
			});
		}
		const frames = /* @__PURE__ */ new Map();
		const canMove = typeof Element !== "undefined" && typeof Element.prototype.moveBefore === "function";
		/** Put a frame into a parent without reloading it when the browser can (`moveBefore`). */
		function place(parent, element) {
			if (element.parentElement === parent) return;
			if (canMove && element.isConnected) try {
				parent.moveBefore(element, null);
				return;
			} catch {}
			parent.appendChild(element);
		}
		let holderElement;
		/** Off-screen home of frames finishing their last save. */
		function holder() {
			if (holderElement?.isConnected === true) return holderElement;
			holderElement = document.createElement("div");
			holderElement.setAttribute("aria-hidden", "true");
			Object.assign(holderElement.style, {
				position: "fixed",
				left: "-10000px",
				top: "0",
				width: "800px",
				height: "600px",
				overflow: "hidden",
				pointerEvents: "none",
				visibility: "hidden"
			});
			document.body.appendChild(holderElement);
			return holderElement;
		}
		function post(frame, message) {
			frame.element.contentWindow?.postMessage({
				channel: CHANNEL,
				...message
			}, frame.origin);
		}
		/** Ask the page to write everything to disk; resolves when it answered or after the timeout. */
		function flush(frame) {
			const target = frame.element.contentWindow;
			if (target === null) return Promise.resolve();
			const id = `${Date.now()}-${Math.random()}`;
			return new Promise((resolve) => {
				const done = () => {
					clearTimeout(timer);
					window.removeEventListener("message", onMessage);
					resolve();
				};
				const onMessage = (event) => {
					const data = event.data;
					if (event.source === target && data?.channel === CHANNEL && data.type === "flushed" && data.id === id) done();
				};
				const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
				window.addEventListener("message", onMessage);
				post(frame, {
					type: "flush",
					id
				});
			});
		}
		/** This tab no longer holds the workbench process. */
		function release(lease) {
			fetch("api/dsh-film-studio/close", {
				method: "POST",
				credentials: "same-origin",
				keepalive: true,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ lease })
			}).catch(() => void 0);
		}
		/** The body went away: save, then close — unless it comes straight back. */
		function park(lease) {
			const frame = frames.get(lease);
			if (frame === void 0) return;
			frame.parked = true;
			if (canMove && frame.element.isConnected) place(holder(), frame.element);
			const saved = frame.element.isConnected ? flush(frame) : Promise.resolve();
			const graced = new Promise((resume) => setTimeout(resume, REMOUNT_GRACE_MS));
			Promise.all([saved, graced]).then(() => {
				if (!frame.parked || frames.get(lease) !== frame) return;
				frame.element.remove();
				frames.delete(lease);
				release(lease);
			});
		}
		if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
			for (const lease of frames.keys()) release(lease);
		});
		/** Automatic reopens after the page reported the workbench gone: at most this many per window. */
		const RECONNECT_LIMIT = 3;
		const RECONNECT_WINDOW_MS = 12e4;
		const reconnects = /* @__PURE__ */ new Map();
		function TabBody({ translate, host, sessionId, useSessions, useTabInfo }) {
			const { tab } = useTabInfo();
			const lease = tab.id;
			const workspace = useSessions((state) => state.byId[sessionId]?.cwd);
			const container = (0, react.useRef)(null);
			const [phase, setPhase] = (0, react.useState)(() => frames.get(lease)?.ready === true ? "shown" : "loading");
			const [reason, setReason] = (0, react.useState)("");
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [gaveUpWaiting, setGaveUpWaiting] = (0, react.useState)(false);
			const live = (0, react.useRef)({
				actions: tab.actions,
				workspace,
				host
			});
			live.current = {
				actions: tab.actions,
				workspace,
				host
			};
			(0, react.useLayoutEffect)(() => {
				const frame = frames.get(lease);
				if (frame !== void 0 && container.current !== null) {
					frame.parked = false;
					place(container.current, frame.element);
				}
				return () => {
					park(lease);
				};
			}, [lease]);
			(0, react.useEffect)(() => {
				if (workspace !== void 0) return;
				const timer = setTimeout(() => {
					setGaveUpWaiting(true);
				}, WORKSPACE_WAIT_MS);
				return () => {
					clearTimeout(timer);
				};
			}, [workspace]);
			(0, react.useEffect)(() => {
				const existing = frames.get(lease);
				if (existing !== void 0 && !(existing.workspace === void 0 && workspace !== void 0)) return;
				if (workspace === void 0 && !gaveUpWaiting) return;
				const controller = new AbortController();
				if (existing === void 0) setPhase("loading");
				(async () => {
					try {
						const response = await fetch("api/dsh-film-studio/open", {
							method: "POST",
							credentials: "same-origin",
							signal: controller.signal,
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								lease,
								...workspace === void 0 ? {} : { workspace }
							})
						});
						const body = await response.json();
						if (!response.ok || typeof body.url !== "string") throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
						const parent = container.current;
						if (controller.signal.aborted || parent === null) return;
						frames.get(lease)?.element.remove();
						const element = document.createElement("iframe");
						element.title = translate("tab.title");
						element.allow = "fullscreen; clipboard-read; clipboard-write; autoplay";
						Object.assign(element.style, {
							width: "100%",
							height: "100%",
							border: "0",
							display: "block",
							background: "transparent"
						});
						const frame = {
							element,
							origin: new URL(body.url).origin,
							workspace,
							sessionId,
							ready: false,
							parked: false
						};
						element.addEventListener("load", () => {
							setTimeout(() => {
								if (frames.get(lease) === frame && !frame.ready) {
									frame.ready = true;
									setPhase("shown");
								}
							}, SHOW_FALLBACK_MS);
						}, { once: true });
						element.src = frameAddress(body.url, window.location.origin, sessionId);
						frames.set(lease, frame);
						parent.appendChild(element);
					} catch (error) {
						if (controller.signal.aborted) return;
						setReason(error instanceof Error ? error.message : String(error));
						setPhase("failed");
					}
				})();
				return () => {
					controller.abort();
				};
			}, [
				lease,
				workspace,
				gaveUpWaiting,
				attempt,
				translate,
				sessionId
			]);
			(0, react.useEffect)(() => {
				const onMessage = (event) => {
					const frame = frames.get(lease);
					if (frame === void 0 || event.source !== frame.element.contentWindow || event.origin !== frame.origin) return;
					const data = event.data;
					if (data?.channel !== CHANNEL) return;
					const reply = (ok) => {
						post(frame, {
							type: "result",
							id: data.id,
							ok
						});
					};
					if (data.type === "ready") {
						frame.ready = true;
						setPhase("shown");
					} else if (data.type === "reveal" && typeof data.path === "string") live.current.host.reveal(data.path).then(reply, () => {
						reply(false);
					});
					else if (data.type === "preview" && typeof data.path === "string") try {
						live.current.actions.openResource(fileAddressFor(sessionId, live.current.workspace, data.path));
						reply(true);
					} catch {
						reply(false);
					}
					else if (data.type === "lost") {
						const now = Date.now();
						const recent = (reconnects.get(lease) ?? []).filter((at) => now - at < RECONNECT_WINDOW_MS);
						if (recent.length >= RECONNECT_LIMIT) {
							setReason(translate("app.lost"));
							setPhase("failed");
							return;
						}
						reconnects.set(lease, [...recent, now]);
						reopen.current();
					}
				};
				window.addEventListener("message", onMessage);
				return () => {
					window.removeEventListener("message", onMessage);
				};
			}, [
				lease,
				sessionId,
				translate
			]);
			const retry = (0, react.useCallback)(() => {
				frames.get(lease)?.element.remove();
				frames.delete(lease);
				setPhase("loading");
				setAttempt((value) => value + 1);
			}, [lease]);
			const reopen = (0, react.useRef)(retry);
			reopen.current = retry;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					position: "relative",
					width: "100%",
					height: "100%",
					overflow: "hidden"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: container,
						style: {
							position: "absolute",
							inset: 0,
							opacity: phase === "shown" ? 1 : 0,
							transition: "opacity 200ms ease"
						}
					}),
					phase === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RenderAnimation, { label: translate("app.loading") }),
					phase === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						style: {
							position: "absolute",
							inset: 0,
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							gap: "8px",
							padding: "24px",
							textAlign: "center",
							color: "var(--dsw-alias-label-secondary)"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									margin: 0,
									color: "var(--dsw-alias-label-primary)"
								},
								children: translate("app.failed")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: { margin: 0 },
								children: reason
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									margin: 0,
									fontSize: "12px"
								},
								children: translate("app.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: retry,
								children: translate("app.retry")
							})
						]
					})
				]
			});
		}
		const STYLE_ID = "dsh-film-studio-render-animation";
		const STYLE = `
.dfs-render{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);pointer-events:none}
.dfs-strip{position:relative;display:flex;gap:6px;padding:12px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));overflow:hidden}
.dfs-strip::before,.dfs-strip::after{content:"";position:absolute;left:8px;right:8px;height:4px;background:repeating-linear-gradient(90deg,var(--dsw-alias-border-l2,rgba(127,127,127,.35)) 0 6px,transparent 6px 12px)}
.dfs-strip::before{top:4px}.dfs-strip::after{bottom:4px}
.dfs-frame{position:relative;width:38px;height:26px;border-radius:4px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.18));overflow:hidden}
.dfs-frame::after{content:"";position:absolute;inset:0;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,var(--dsw-alias-state-business-primary,#3b82f6),color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 45%,transparent));animation:dfs-fill 1.8s cubic-bezier(.65,0,.35,1) infinite}
.dfs-frame:nth-child(2)::after{animation-delay:.3s}.dfs-frame:nth-child(3)::after{animation-delay:.6s}.dfs-frame:nth-child(4)::after{animation-delay:.9s}
.dfs-sweep{position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.35) 50%,transparent 70%);transform:translateX(-100%);animation:dfs-sweep 1.8s ease-in-out infinite}
.dfs-brand{font-size:13px;letter-spacing:.08em}
@keyframes dfs-fill{0%{transform:scaleX(0);opacity:1}45%{transform:scaleX(1);opacity:1}80%{transform:scaleX(1);opacity:0}100%{transform:scaleX(0);opacity:0}}
@keyframes dfs-sweep{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.dfs-frame::after{animation:none;transform:scaleX(1);opacity:.6}.dfs-sweep{display:none}}
`;
		/** A short film strip whose frames render one after another: the loading state, with no text to read. */
		function RenderAnimation({ label }) {
			(0, react.useLayoutEffect)(() => {
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = STYLE;
				document.head.appendChild(style);
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dfs-render",
				role: "status",
				"aria-label": label,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dfs-strip",
					"aria-hidden": "true",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dfs-frame" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dfs-frame" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dfs-frame" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dfs-frame" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dfs-sweep" })
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dfs-brand",
					"aria-hidden": "true",
					children: "VibeDev Film"
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Film Studio browser half: the workbench as one right-sidebar tab type, with
		* an entry box on the sidebar's guide page.
		*
		* Built by tsdown into the `__ModuleLoader__` factory bundle at
		* client/client.js; React and the client primitives come from the Host's module
		* table. The Host surfaces used here are typed structurally (see types.ts), so
		* this external package depends on no monorepo-internal types.
		*/
		/**
		* The event another plugin dispatches on `window` to add media to the open canvas:
		* `detail = { paths: string[]; sessionId?: string; respond(result): void }`. The
		* workbench sets `detail.accepted = true` synchronously; still false after
		* dispatching means it is not installed.
		*/
		const ADD_MEDIA_EVENT = "vibedev-film:add-media";
		/**
		* Open (or bring forward) the workbench tab in a session. The session on screen
		* gets it at once; another session gets it as soon as it comes on screen, so an
		* agent working in the background never pulls the user away from what they view.
		*/
		function createTabOpener(ctx) {
			const waiting = /* @__PURE__ */ new Set();
			let unsubscribe;
			const surface = () => ctx.get?.("sidebarRight");
			const flush = () => {
				const current = surface()?.mounted?.getSnapshot();
				if (current === void 0 || !waiting.has(current)) return;
				waiting.delete(current);
				surface()?.openTab(TAB_KIND, { revealIfOpened: true });
			};
			ctx.effect(() => () => {
				unsubscribe?.();
			}, "dsh-film-studio: pending opens");
			return (sessionId) => {
				const sidebar = surface();
				if (sidebar === void 0) return;
				if (sidebar.mounted?.getSnapshot() === sessionId) {
					sidebar.openTab(TAB_KIND, { revealIfOpened: true });
					return;
				}
				waiting.add(sessionId);
				unsubscribe ??= sidebar.mounted?.subscribe(flush);
			};
		}
		/** The dictionary namespace this plugin owns. */
		const LOCALE_NAMESPACE = "dsh-film-studio";
		/**
		* The tab type's identity, which is also the key its body registers under: the
		* registry wants a value unique across every registration, and a package name is
		* the natural one.
		*/
		const TAB_ID = "dsh-film-studio";
		/** The kind tabs of the workbench are opened with. */
		const TAB_KIND = "film-studio-workbench";
		const VIEW = "workbench";
		const name = "dsh-film-studio";
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs"
		];
		/**
		* Register the dictionary, then the workbench tab type and its body.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, {
				zh,
				en
			}), "dsh-film-studio: dictionaries");
			const t = ctx.locale.bind(LOCALE_NAMESPACE);
			const host = { async reveal(path) {
				const session = (ctx.get?.("remote"))?.session;
				if (session === void 0) return false;
				try {
					const available = await session.canOpenWorkspacePath();
					if (!available.ok || available.value !== true) return false;
					return (await session.openWorkspacePath({
						path,
						action: "reveal"
					})).ok;
				} catch {
					return false;
				}
			} };
			const openTab = createTabOpener(ctx);
			ctx.effect(() => {
				const lifetime = new AbortController();
				(async () => {
					while (!lifetime.signal.aborted) try {
						const response = await fetch("api/dsh-film-studio/opens", {
							method: "GET",
							credentials: "same-origin",
							cache: "no-store",
							signal: lifetime.signal
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const body = await response.json();
						for (const open of body.opens ?? []) if (typeof open.sessionId === "string") openTab(open.sessionId);
					} catch {
						if (lifetime.signal.aborted) return;
						await new Promise((resume) => setTimeout(resume, 5e3));
					}
				})();
				return () => {
					lifetime.abort();
				};
			}, "dsh-film-studio: open feed");
			ctx.effect(() => {
				const onAddMedia = (event) => {
					const detail = event.detail;
					if (detail === null || typeof detail !== "object" || !Array.isArray(detail.paths) || typeof detail.respond !== "function") return;
					detail.accepted = true;
					addMediaToCanvas(detail.paths.filter((path) => typeof path === "string"), typeof detail.sessionId === "string" ? detail.sessionId : void 0, openTab).then(detail.respond, (error) => {
						detail.respond({
							ok: false,
							message: error instanceof Error ? error.message : String(error)
						});
					});
				};
				window.addEventListener(ADD_MEDIA_EVENT, onAddMedia);
				return () => {
					window.removeEventListener(ADD_MEDIA_EVENT, onAddMedia);
				};
			}, "dsh-film-studio: add media to canvas");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				keepMounted: true,
				title: () => t("tab.title"),
				guide: [{
					id: VIEW,
					order: 10,
					title: () => t("tab.title"),
					description: () => t("tab.guide.description"),
					icon: ArtworkStudio
				}]
			}), "dsh-film-studio: tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				locale: LOCALE_NAMESPACE,
				inject: () => ({
					translate: t,
					view: VIEW,
					host
				})
			}, TabBody)), "dsh-film-studio: tab body");
		}
		//#endregion
		exports.ADD_MEDIA_EVENT = ADD_MEDIA_EVENT;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
