/**
 * Follow-up suggestions — browser half.
 *
 * Renders the chips into ui-chat's `conversation.chat.turnTail` list seat,
 * which sits between the closing assistant prose and the message action strip:
 * that is "under the finished answer" without touching the shipped renderer.
 *
 * Two conditions gate every render, and both come from data the seat already
 * carries:
 *
 * - the Turn record's own `status === "closed"` — a live Turn has no chips;
 * - the Turn is the newest in `useChat().timeline.turnOrder` — only the
 *   Session's tail carries suggestions, so scrollback stays quiet and one
 *   Session costs at most one call per Turn.
 *
 * A click never sends: it writes the chip into the composer draft through the
 * `inputActions` seat and puts the keyboard back into the composer, so the user
 * can edit before pressing Enter. After the label sits a refresh button that
 * asks the Host for one fresh batch for the same Turn.
 *
 * Answers are cached per closed Turn under a key of Session + Turn + closing
 * node sequence, in two tiers: an in-page map (switching views or Session tabs
 * and back costs nothing) and `localStorage` behind it (a reload shows the same
 * chips instantly and asks the Host nothing). Only non-empty answers are kept,
 * so a transient failure is retried on the next visit instead of being frozen.
 * A miss shows three placeholder pills for as long as the Host takes, so the
 * row arrives with the reply rather than popping in seconds later. A refresh is
 * the one write that crosses both tiers on purpose: it asks for new text and,
 * once new text arrives, replaces what is shown and remembered. An empty or
 * failed refresh changes nothing, so the chips the user is reading stay.
 *
 * The refresh request is self-sufficient for two Host builds. A current Host
 * reads its `refresh` flag and regenerates instead of replaying the settled
 * answer; a Host build loaded before that flag existed ignores the flag, so the
 * request also carries a synthetic closing sequence that no real node can
 * occupy — the settled-answer key such a Host computes is then a miss.
 */

window.__ModuleLoader__.load({
	id: "dsh-followup-suggestions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/** Dictionary namespace owned by this plugin. */
		const NS = "followupSuggestions";
		/** Exact route the Host half registered. */
		const ROUTE = "/api/dsh-followup-suggest";
		/** Marker stamped on the mount node so the running build is identifiable from DevTools. */
		const BUILD_TAG = "v1.1.0";
		/** Persistent cache key owned by this plugin. */
		const STORE_KEY = "dsh.followupSuggestions.v1";
		/** Turns kept in the persistent tier before the oldest is dropped. */
		const STORE_LIMIT = 40;
		/** Age past which a cached Turn is stale enough to regenerate. */
		const STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
		/**
		* Offset step that keeps a refresh's synthetic closing sequence far outside
		* every real node sequence; see `refreshCoordinates`.
		*/
		const REFRESH_SEQ_STEP = 1000000000;
		/** Stable empty list, so an idle seat never re-renders on a fresh array identity. */
		const EMPTY_ITEMS = [];
		/** Selector hook used when the composition provides no `chat` seat; keeps the call count fixed. */
		const NOOP_HOOK = () => void 0;
		/** One class prefix for every rule below. */
		const CSS = [
			// `order: 1` puts this row BELOW the shipped action strip. The seat's outlet
			// wrapper is `display: contents`, so this div is a flex item of ui-chat's own
			// turn-tail column next to the action row, and that row keeps the default
			// order 0. If the container ever stops being a flex column the declaration is
			// ignored and the row falls back to the seat's own position, above the strip.
			".dshfu_root{display:flex;flex-direction:column;gap:8px;order:1;margin-top:-4px}",
			".dshfu_head{display:flex;align-items:center;gap:8px}",
			".dshfu_label{color:var(--dsw-alias-label-caption,#8a8f99);font-size:12px;line-height:18px}",
			// Refresh affordance: one small icon button right after the label. Its box is
			// exactly the label's 18px line-height and its glyph exactly the label's 12px
			// font size, so the two sit on the same line without either looking heavier;
			// the 8px head gap keeps it clear of the caption instead of hugging it.
			".dshfu_refresh{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-caption,#8a8f99);cursor:pointer;transition:background-color .12s,color .12s}",
			".dshfu_refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,inherit)}",
			".dshfu_refresh:disabled{cursor:default;opacity:.45}",
			".dshfu_refresh:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:1px}",
			// Spinning while a refresh is in flight, so the row shows the work without
			// replacing the chips the user is already reading.
			".dshfu_refresh[data-busy=\"true\"] svg{animation:dshfu_spin .8s linear infinite}",
			"@keyframes dshfu_spin{to{transform:rotate(360deg)}}",
			".dshfu_list{display:flex;flex-wrap:wrap;gap:8px}",
			".dshfu_chip{box-sizing:border-box;max-width:100%;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.32));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13.5px;line-height:20px;text-align:start;cursor:pointer;padding:7px 13px;transition:background-color .12s,border-color .12s}",
			".dshfu_chip:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.5));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}",
			".dshfu_chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}",
			// Placeholder pills shown while the Host is answering, so the row appears
			// with the reply instead of popping in two seconds later.
			".dshfu_skel{display:inline-block;height:34px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));animation:dshfu_pulse 1.4s ease-in-out infinite}",
			".dshfu_skel:nth-child(1){width:150px}",
			".dshfu_skel:nth-child(2){width:186px}",
			".dshfu_skel:nth-child(3){width:126px}",
			"@keyframes dshfu_pulse{0%,100%{opacity:.5}50%{opacity:.95}}",
			"@media (prefers-reduced-motion:reduce){.dshfu_chip{transition:none}.dshfu_skel{animation:none;opacity:.7}.dshfu_refresh[data-busy=\"true\"] svg{animation:none;opacity:.6}}"
		].join("");
		/** Material-style refresh glyph, drawn with `currentColor` and no icon dependency. */
		const REFRESH_ICON_PATH = "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";

		const zh = {
			label: "为你推荐",
			insert: "填入输入框，可先修改再发送",
			refresh: "换一批推荐",
			refreshing: "正在换一批推荐"
		};
		const en = {
			label: "Suggested",
			insert: "Insert into the composer to edit before sending",
			refresh: "Refresh suggestions",
			refreshing: "Refreshing suggestions"
		};

		/**
		* Inject the stylesheet once per document, and rewrite it when this build's
		* rules differ from the injected tag's.
		*
		* The rewrite is what makes a plugin reload reach the page: HMR and a
		* re-mount do not reload the document, so a tag left by the previous build
		* would otherwise keep supplying the old rules — a changed icon size or gap
		* would stay invisible until a hard refresh.
		*/
		function ensureStyle() {
			if (typeof document === "undefined") return;
			const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(NS)}]`);
			if (existing !== null && existing.textContent === CSS) return;
			const tag = existing ?? document.createElement("style");
			tag.dataset.plugin = "@local/dsh-followup-suggestions";
			tag.dataset.pluginCss = NS;
			tag.textContent = CSS;
			if (existing === null) document.head.appendChild(tag);
		}

		/**
		* In-page tier of the answer cache: survives view and Session-tab switches
		* without touching storage, and is hydrated once from the persistent tier.
		*/
		const memory = new Map();
		/** Whether the persistent tier has been read into `memory` yet. */
		let hydrated = false;
		/** Host calls in flight, keyed like the cache; see `requestSuggestions`. */
		const inFlight = new Map();
		/** Refreshes issued by this page, used to keep every refresh a distinct host key. */
		let refreshes = 0;

		/** The persistent tier, or `null` when the browser withholds it. */
		function storage() {
			try {
				return globalThis.localStorage ?? null;
			} catch {
				return null;
			}
		}

		/** Load the persistent tier into memory once, dropping aged entries. */
		function hydrate() {
			if (hydrated) return;
			hydrated = true;
			const store = storage();
			if (store === null) return;
			let parsed;
			try {
				parsed = JSON.parse(store.getItem(STORE_KEY) ?? "null");
			} catch {
				parsed = null;
			}
			const entries = parsed?.entries;
			if (entries === null || typeof entries !== "object") return;
			const cutoff = Date.now() - STORE_MAX_AGE_MS;
			for (const [key, value] of Object.entries(entries)) {
				if (typeof value?.at !== "number" || value.at < cutoff || !Array.isArray(value.items)) continue;
				const items = value.items.filter((item) => typeof item === "string" && item.length > 0);
				if (items.length > 0) memory.set(key, {
					items,
					at: value.at
				});
			}
		}

		/** Write the in-page tier back to the persistent one. */
		function persist() {
			const store = storage();
			if (store === null) return;
			const entries = {};
			for (const [key, value] of memory) entries[key] = {
				items: value.items,
				at: value.at
			};
			try {
				store.setItem(STORE_KEY, JSON.stringify({
					version: 1,
					entries
				}));
			} catch {}
		}

		/** Drop the oldest entries past the bound. */
		function trim() {
			if (memory.size <= STORE_LIMIT) return;
			const ordered = [...memory.entries()].sort((left, right) => right[1].at - left[1].at);
			memory.clear();
			for (const [key, value] of ordered.slice(0, STORE_LIMIT)) memory.set(key, value);
		}

		/**
		* Cache key of one closed Turn.
		*
		* The closing node sequence is what makes the entry self-invalidating: a
		* retry, a branch, or a later Turn all move it.
		* @param sessionId - viewed Session.
		* @param turn - closed Turn number.
		* @param seq - closing final node sequence.
		* @returns the key.
		*/
		function cacheKey(sessionId, turn, seq) {
			return `${sessionId}|${turn ?? ""}|${seq ?? ""}`;
		}

		/** The chips already known for one key, or `undefined`. */
		function remembered(key) {
			hydrate();
			return memory.get(key);
		}

		/** Keep chips for one key in both tiers. */
		function remember(key, items) {
			hydrate();
			memory.set(key, {
				items,
				at: Date.now()
			});
			trim();
			persist();
		}

		/**
		* Transport coordinates for one refresh request.
		*
		* A Host that knows the `refresh` flag regenerates for the key it is handed,
		* so the coordinates only have to be valid. A Host build loaded before that
		* flag existed reads neither it nor this intent: it keys settled answers by
		* the closing sequence it receives, so the refresh hands it a sequence no
		* real closing node can occupy (a billion is far past any node count, and
		* the sum stays a safe integer for billions of refreshes). The offset grows
		* with every refresh on this page, which keeps two clicks two distinct keys.
		*
		* @param turn - closed Turn number from the seat.
		* @param seq - closing final node sequence, when the seat carries one.
		* @returns the `turn` / `seq` pair to send.
		*/
		function refreshCoordinates(turn, seq) {
			refreshes += 1;
			const offset = REFRESH_SEQ_STEP * refreshes;
			if (typeof seq === "number") return { turn, seq: seq + offset };
			return { turn: typeof turn === "number" ? turn + offset : turn, seq };
		}

		/**
		* Ask the Host for this Turn's chips.
		*
		* Calls are shared per cache key while they run: a composition that mounts
		* the seat twice for one Turn (or re-runs the effect) must not pay for two
		* model calls, and the Host's own in-flight map is only a backstop. A refresh
		* deliberately runs its own call even while a first ask is in flight — the
		* user asked for different text, and sharing the pending promise would hand
		* back the very answer being replaced.
		*
		* @param sessionId - viewed Session.
		* @param turn - closed Turn number.
		* @param seq - closing final node sequence, the Host's cache key.
		* @param key - this plugin's cache key.
		* @param refresh - whether this is the refresh button's one fresh batch.
		* @returns chip texts; never rejects on a Host failure.
		*/
		function requestSuggestions(sessionId, turn, seq, key, refresh) {
			const flight = refresh === true ? `${key}\u0000refresh` : key;
			const running = inFlight.get(flight);
			if (running !== undefined) return running;
			const coordinates = refresh === true ? refreshCoordinates(turn, seq) : { turn, seq };
			const call = (async () => {
				try {
					const response = await fetch(ROUTE, {
						method: "POST",
						credentials: "include",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sessionId,
							turn: coordinates.turn,
							seq: coordinates.seq,
							...refresh === true ? { refresh: true } : {}
						})
					});
					if (!response.ok) return EMPTY_ITEMS;
					const payload = await response.json();
					const items = payload?.items;
					return Array.isArray(items) ? items.filter((item) => typeof item === "string" && item.trim().length > 0) : EMPTY_ITEMS;
				} catch {
					return EMPTY_ITEMS;
				} finally {
					inFlight.delete(flight);
				}
			})();
			inFlight.set(flight, call);
			return call;
		}

		/**
		* The composer's editable surface inside one Session's conversation.
		*
		* `data-conversation-content` carries the Session id, which keeps the lookup
		* on the conversation the chips belong to instead of another mounted one.
		* Both attributes belong to ui-conversation: a composition that renames
		* either makes this lookup miss, and a click then merely writes the draft,
		* exactly as it did before this build.
		*
		* @param sessionId - Session the chips were rendered for.
		* @returns the contenteditable host, or `null` when it cannot be resolved.
		*/
		function composerInput(sessionId) {
			if (typeof document === "undefined") return null;
			let scope = document;
			if (typeof sessionId === "string" && sessionId.length > 0) {
				const id = typeof CSS === "object" && CSS !== null && typeof CSS.escape === "function" ? CSS.escape(sessionId) : sessionId;
				scope = document.querySelector(`[data-conversation-content][data-conversation-session="${id}"]`) ?? document;
			}
			const input = scope.querySelector("[data-composer-input]");
			return input !== null && input !== void 0 && typeof input.focus === "function" ? input : null;
		}

		/**
		* Move the keyboard into the composer, at the end of the draft just written.
		*
		* Focusing the contenteditable alone is not enough: ui-conversation restores
		* the caret through the Lexical editor's own `focus()`, and a bare DOM focus
		* lands at the start of the content instead. The caret is therefore placed
		* explicitly, which is also what makes typing continue the inserted chip.
		*
		* @param sessionId - Session whose composer should take the keyboard.
		*/
		function focusComposer(sessionId) {
			const input = composerInput(sessionId);
			if (input === null) return;
			input.focus({ preventScroll: true });
			const selection = typeof window === "undefined" ? null : window.getSelection?.() ?? null;
			if (selection === null || typeof document.createRange !== "function") return;
			const range = document.createRange();
			range.selectNodeContents(input);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		}

		/**
		* Render one closed Turn's suggestion chips, or nothing.
		* @param props - the Turn seat's owner props plus the Session standard kit.
		* @returns the chips, or `null` when this Turn shows none.
		*/
		function FollowupTail(props) {
			const record = props.turn !== null && typeof props.turn === "object" ? props.turn : void 0;
			const turn = typeof record?.turn === "number" ? record.turn : typeof props.turn === "number" ? props.turn : void 0;
			// The seat's own `seq` is the closing final node's sequence: it is what makes
			// one Turn's cached answer invalidate itself when the reply is regenerated.
			const seq = typeof props.seq === "number" ? props.seq : void 0;
			const sessionId = props.sessionId;
			const useChat = props.useChat;
			const inputActions = props.inputActions;
			const t = props.t;
			// Exactly one hook call in a fixed position: the `chat` seat is resolved once
			// per composition, and the no-op stand-in keeps the call count stable when the
			// seat is absent, so a missing standard hook can never reorder the hooks below.
			const useChatHook = typeof useChat === "function" ? useChat : NOOP_HOOK;
			const latest = useChatHook((snapshot) => {
				const order = snapshot?.timeline?.turnOrder;
				return turn !== void 0 && Array.isArray(order) && order[order.length - 1] === turn;
			}) === true;
			const active = record?.status === "closed" && latest === true && typeof sessionId === "string" && sessionId.length > 0;
			const key = active ? cacheKey(sessionId, turn, seq) : "";
			// Both initial states read the cache during the FIRST render: a remembered
			// answer paints with the reply, and a miss paints the placeholder row in the
			// same frame instead of appearing one render later.
			const [items, setItems] = react.useState(() => {
				const hit = key.length === 0 ? void 0 : remembered(key);
				return hit === void 0 ? EMPTY_ITEMS : hit.items;
			});
			/** Whether a Host call is in flight for this key; drives the placeholder row. */
			const [pending, setPending] = react.useState(() => key.length > 0 && remembered(key) === void 0);
			/** Whether the refresh button's call is in flight; drives the icon's spin. */
			const [refreshing, setRefreshing] = react.useState(false);
			/**
			* Refresh ticket: the cache key the button was last pressed for plus a
			* counter, so a second press on the same Turn still re-runs the effect and
			* a Turn change retires the ticket instead of forcing that Turn's first ask.
			*/
			const [refresh, setRefresh] = react.useState(null);
			const tick = refresh !== null && refresh.key === key ? refresh.n : 0;
			react.useEffect(() => {
				const force = tick > 0;
				if (key.length === 0) {
					setItems(EMPTY_ITEMS);
					setPending(false);
					setRefreshing(false);
					return void 0;
				}
				// A cached answer is final: it is shown as-is and the Host is not asked
				// again, which is what makes a reload free. A miss fetches once and keeps
				// the result; an empty or failed answer is deliberately not cached.
				// A refresh is the exception: it asks again on purpose and, on success,
				// replaces both what is shown and what is remembered.
				if (!force) {
					setRefreshing(false);
					const hit = remembered(key);
					if (hit !== void 0) {
						setItems(hit.items);
						setPending(false);
						return void 0;
					}
				}
				let cancelled = false;
				if (force) setRefreshing(true);
				else {
					setItems(EMPTY_ITEMS);
					setPending(true);
				}
				requestSuggestions(sessionId, turn, seq, key, force).then((next) => {
					if (cancelled) return;
					if (force) setRefreshing(false);
					else setPending(false);
					// An empty refresh is not an answer: the chips on screen stay, and so
					// does the cache entry behind them.
					if (next.length === 0) return;
					remember(key, next);
					setItems(next);
				});
				return () => {
					cancelled = true;
				};
			}, [
				key,
				sessionId,
				turn,
				seq,
				tick
			]);
			if (!active || (items.length === 0 && pending === false)) return null;
			const label = typeof t === "function" ? t("label") : "Suggested";
			const hint = typeof t === "function" ? t("insert") : "Insert into the composer";
			const refreshHint = typeof t === "function" ? t(refreshing ? "refreshing" : "refresh") : refreshing ? "Refreshing suggestions" : "Refresh suggestions";
			const chips = items.length > 0
				? items.map((text, index) => h("button", {
					key: `${index}:${text}`,
					type: "button",
					className: "dshfu_chip",
					title: hint,
					onClick: () => {
						const write = inputActions?.setDraft;
						if (typeof write !== "function") return;
						write(text);
						// The chip button takes the click's focus; hand the keyboard back to
						// the composer so a click is an entry into the input state.
						focusComposer(sessionId);
					}
				}, text))
				: [
					0,
					1,
					2
				].map((index) => h("span", {
					key: `placeholder-${index}`,
					className: "dshfu_skel",
					"aria-hidden": "true"
				}));
			return h("div", {
				className: "dshfu_root",
				"data-followup-suggestions": BUILD_TAG,
				"data-turn": turn,
				"aria-busy": pending || refreshing ? "true" : void 0
			}, [
				h("div", {
					className: "dshfu_head",
					key: "label"
				}, [
					h("span", {
						className: "dshfu_label",
						key: "text"
					}, label),
					h("button", {
						key: "refresh",
						type: "button",
						className: "dshfu_refresh",
						title: refreshHint,
						"aria-label": refreshHint,
						"data-busy": refreshing ? "true" : void 0,
						disabled: pending || refreshing,
						onClick: () => {
							if (key.length === 0) return;
							setRefresh((previous) => ({
								key,
								n: previous !== null && previous.key === key ? previous.n + 1 : 1
							}));
						}
					}, h("svg", {
						viewBox: "0 0 24 24",
						width: 12,
						height: 12,
						fill: "currentColor",
						"aria-hidden": "true",
						focusable: "false"
					}, h("path", { d: REFRESH_ICON_PATH })))
				]),
				h("div", {
					className: "dshfu_list",
					key: "list"
				}, chips)
			]);
		}

		/** Services this plugin needs: the slot registry and its dictionary seat. */
		const inject = ["slots", "locale"];

		/**
		* Client plugin body: register the dictionaries and one Turn-tail entry.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ensureStyle();
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-followup-suggestions: dictionaries");
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: "@local/dsh-followup-suggestions",
				order: 50,
				locale: NS
			}, FollowupTail));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
