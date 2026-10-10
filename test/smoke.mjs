/**
 * Follow-up suggestions smoke test.
 *
 * Drives the real plugin halves with no DSH runtime and no network:
 *
 * - Host half: `apply()` registers its route on a stub carrier, and the test
 *   calls that route's handler with real `Request`/`Response` objects while a
 *   stub LLM streams a canned reply.
 * - Browser half: `lib/client.js` is evaluated against a stub module loader and
 *   a minimal hook runtime, then the registered `conversation.chat.turnTail`
 *   component is rendered with controlled seat props.
 *
 * Run: node test/smoke.mjs
 */

import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

register("./module-loader.mjs", import.meta.url);

const HOST_PATH = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const CLIENT_PATH = fileURLToPath(new URL("../lib/client.js", import.meta.url));

let failures = 0;
let checks = 0;

/** Record one assertion. */
function check(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`  PASS  ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** Deep structural comparison for the small values this test produces. */
function same(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Let queued promise continuations run. */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

//#region Host half

const host = await import(pathToFileURL(HOST_PATH).href);

/**
 * Build one Host context plus the Session it serves.
 * @param options - per-case overrides for the Session and the model reply.
 * @returns the context, the captured route registrations, and the captured LLM calls.
 */
function hostHarness(options = {}) {
	const registered = [];
	const calls = [];
	const session = options.session === null ? undefined : {
		requestHeader: () => options.noHeader === true ? undefined : { config: { provider: "stub-provider", model: "stub-model" } },
		deriveMessages: () => options.messages ?? [
			{ role: "user", content: [{ type: "text", text: "帮我解释一下飞夺泸定桥" }] },
			{ role: "assistant", content: [{ type: "text", text: "飞夺泸定桥是 1935 年 5 月的一次战斗……" }] }
		]
	};
	const ctx = {
		connection: {
			fetch: {
				register(spec) {
					registered.push(spec);
					return () => {};
				}
			}
		},
		effect(run) {
			const dispose = run();
			return typeof dispose === "function" ? dispose : () => {};
		},
		logger: { warn() {} },
		sessions: {
			get(id) {
				return id === "s1" ? session : undefined;
			}
		},
		llm: {
			stream(call) {
				const index = calls.length;
				calls.push(call);
				const planned = options.plan?.[Math.min(index, options.plan.length - 1)] ?? {};
				const text = Object.hasOwn(planned, "reply") ? planned.reply : options.reply ?? "继续解释细节\n给一个类比\n总结成三点";
				const finish = Object.hasOwn(planned, "finish") ? planned.finish : options.finish ?? { kind: "stop" };
				return (async function* stream() {
					yield { type: "text-delta", index: 0, text };
					yield { type: "finish", reason: finish };
				})();
			}
		}
	};
	return { ctx, registered, calls };
}

/**
 * Invoke one captured route.
 * @param spec - the registered route.
 * @param body - raw request body text.
 * @returns the Fetch response.
 */
function callRoute(spec, body) {
	return spec.fetch(new Request(`http://127.0.0.1${spec.path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body
	}));
}

console.log("host half");

{
	const { ctx, registered, calls } = hostHarness();
	host.apply(ctx, {});
	check("apply() registers exactly one route", registered.length === 1, `got ${registered.length}`);
	const spec = registered[0];
	check("route path matches the exported constant", spec.path === host.SUGGEST_PATH, spec.path);
	check("route accepts POST", same(spec.methods, ["POST"]), JSON.stringify(spec.methods));
	check("route buffers the body", spec.requestBody === "buffered", String(spec.requestBody));

	const response = await callRoute(spec, JSON.stringify({ sessionId: "s1", turn: 7 }));
	const payload = await response.json();
	check("happy path answers 200", response.status === 200, String(response.status));
	check("happy path returns the model's lines", same(payload.items, ["继续解释细节", "给一个类比", "总结成三点"]), JSON.stringify(payload.items));
	check("one model call was made", calls.length === 1, `got ${calls.length}`);
	check("the call uses the session's selected provider", calls[0]?.provider === "stub-provider", String(calls[0]?.provider));
	check("the call uses the session's selected model", calls[0]?.model === "stub-model", String(calls[0]?.model));
	check("the call is addressed to the session", calls[0]?.sessionId === "s1", String(calls[0]?.sessionId));
	check("the call carries a system message plus one user message", calls[0]?.messages?.length === 2, String(calls[0]?.messages?.length));
	check("the prompt carries the closing assistant reply", typeof calls[0]?.messages?.[1]?.content?.[0]?.text === "string" && calls[0].messages[1].content[0].text.includes("飞夺泸定桥"), "prompt missing context");
	check("the call is cancellable", calls[0]?.signal instanceof AbortSignal, String(calls[0]?.signal));
}

{
	// Decorated lines must be cleaned before they reach a chip; the reply lists
	// them first because the plugin caps every answer at three chips.
	const { ctx, registered } = hostHarness({ reply: "“换个说法”\n1. 继续解释细节\n- 总结成三点\n2) 给一个类比\n继续解释细节" });
	host.apply(ctx, {});
	const payload = await (await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 7 }))).json();
	check("list markers and quotes are stripped", same(payload.items, ["换个说法", "继续解释细节", "总结成三点"]), JSON.stringify(payload.items));
}

{
	const { ctx, registered } = hostHarness({ reply: `${"很".repeat(61)}\n短的那条` });
	host.apply(ctx, {});
	const payload = await (await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 7 }))).json();
	check("over-long lines are dropped", same(payload.items, ["短的那条"]), JSON.stringify(payload.items));
}

{
	const { ctx, registered } = hostHarness({ reply: "一条\n二条\n三条" });
	host.apply(ctx, { maxItems: 1 });
	const payload = await (await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 7 }))).json();
	check("maxItems is honoured", same(payload.items, ["一条"]), JSON.stringify(payload.items));
}

{
	const { ctx, registered } = hostHarness({ finish: { kind: "error" } });
	host.apply(ctx, {});
	const payload = await (await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 7 }))).json();
	check("a failed model call yields no chips", same(payload.items, []), JSON.stringify(payload.items));
}

{
	const { ctx, registered, calls } = hostHarness({ noHeader: true });
	host.apply(ctx, {});
	const payload = await (await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 7 }))).json();
	check("a session without a logged route yields no chips", same(payload.items, []), JSON.stringify(payload.items));
	check("no model call is made without a route", calls.length === 0, `got ${calls.length}`);
}

{
	const { ctx, registered, calls } = hostHarness({ session: null });
	host.apply(ctx, {});
	const payload = await (await callRoute(registered[0], JSON.stringify({ sessionId: "gone", turn: 7 }))).json();
	check("an unknown session yields no chips", same(payload.items, []), JSON.stringify(payload.items));
	check("no model call is made for an unknown session", calls.length === 0, `got ${calls.length}`);
}

{
	const { ctx, registered, calls } = hostHarness();
	host.apply(ctx, {});
	const spec = registered[0];
	const body = JSON.stringify({ sessionId: "s1", turn: 3, seq: 30 });
	const first = await (await callRoute(spec, body)).json();
	const second = await (await callRoute(spec, body)).json();
	check("a repeated request is served from the Host cache", calls.length === 1, `got ${calls.length}`);
	check("the cached answer is identical", same(first.items, second.items), JSON.stringify(second.items));
	const regenerated = await (await callRoute(spec, JSON.stringify({ sessionId: "s1", turn: 3, seq: 31 }))).json();
	check("a regenerated turn misses the cache", calls.length === 2, `got ${calls.length}`);
	check("the regenerated turn still answers", regenerated.items.length === 3, JSON.stringify(regenerated.items));
}

{
	const { ctx, registered, calls } = hostHarness();
	host.apply(ctx, {});
	const body = JSON.stringify({ sessionId: "s1", turn: 5, seq: 50 });
	const [left, right] = await Promise.all([callRoute(registered[0], body), callRoute(registered[0], body)]);
	check("two simultaneous requests share one model call", calls.length === 1, `got ${calls.length}`);
	check("both simultaneous requests answer identically", same((await left.json()).items, (await right.json()).items), "answers differ");
}

{
	const { ctx, registered, calls } = hostHarness({ finish: { kind: "error" } });
	host.apply(ctx, {});
	const body = JSON.stringify({ sessionId: "s1", turn: 4, seq: 40 });
	await callRoute(registered[0], body);
	await callRoute(registered[0], body);
	check("a failed answer is not cached", calls.length === 2, `got ${calls.length}`);
}

{
	const { ctx, registered, calls } = hostHarness();
	host.apply(ctx, {});
	await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 8, seq: 80 }));
	check("the call asks for the lowest reasoning effort", calls[0]?.reasoningEffort === "off", String(calls[0]?.reasoningEffort));
}

{
	const { ctx, registered, calls } = hostHarness({ reasoningEffort: null });
	host.apply(ctx, { reasoningEffort: null });
	await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 8, seq: 81 }));
	check("an explicit null effort inherits the route default", calls[0]?.reasoningEffort === undefined, String(calls[0]?.reasoningEffort));
	check("the prompt stays inside the context budget", calls[0].messages[1].content[0].text.length <= 1200 + 200, String(calls[0].messages[1].content[0].text.length));
}

{
	// A route that rejects the effort must be retried without it, and remembered.
	const { ctx, registered, calls } = hostHarness({
		plan: [
			{ finish: {
				kind: "error",
				failure: { code: "UNSUPPORTED_REASONING_EFFORT" }
			} },
			{ reply: "再举一个例子\n换成更短的说明\n总结成三点" }
		]
	});
	host.apply(ctx, {});
	const first = await (await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 9, seq: 90 }))).json();
	check("an unknown effort is retried without one", calls.length === 2, `got ${calls.length}`);
	check("the retry drops the effort field", calls[1]?.reasoningEffort === undefined, String(calls[1]?.reasoningEffort));
	check("the retry answers normally", same(first.items, ["再举一个例子", "换成更短的说明", "总结成三点"]), JSON.stringify(first.items));
	await callRoute(registered[0], JSON.stringify({ sessionId: "s1", turn: 9, seq: 91 }));
	check("the route is remembered as effortless", calls.length === 3 && calls[2]?.reasoningEffort === undefined, `n=${calls.length} effort=${String(calls[2]?.reasoningEffort)}`);
}

{
	const { ctx, registered } = hostHarness();
	host.apply(ctx, {});
	const missing = await callRoute(registered[0], JSON.stringify({ turn: 7 }));
	check("a body without sessionId is rejected", missing.status === 400, String(missing.status));
	const malformed = await callRoute(registered[0], "not json");
	check("a malformed body is rejected", malformed.status === 400, String(malformed.status));
}

//#endregion

//#region Browser half

/**
 * Minimal hook runtime: one component, state slots that survive renders, and
 * effects re-run on dependency change — enough to exercise the seat component.
 * Dispatch happens through `hookTarget`, the harness currently rendering.
 */
let hookTarget = null;
const reactStub = {
	createElement(type, attributes, ...children) {
		return {
			type,
			props: {
				...(attributes ?? {}),
				children: children.flat()
			}
		};
	},
	useState(initial) {
		const target = hookTarget;
		const index = target.cursor++;
		if (!(index in target.slots)) target.slots[index] = typeof initial === "function" ? initial() : initial;
		return [
			target.slots[index],
			(next) => {
				const value = typeof next === "function" ? next(target.slots[index]) : next;
				// React bails out of an identical state write; without that bailout an
				// effect that re-asserts its initial state would render forever here.
				if (Object.is(value, target.slots[index])) return;
				target.slots[index] = value;
				target.render();
			}
		];
	},
	useEffect(run, deps) {
		const target = hookTarget;
		const index = target.cursor++;
		const previous = target.slots[index];
		const changed = previous === undefined || deps === undefined || deps.length !== previous.deps.length || deps.some((value, position) => !Object.is(value, previous.deps[position]));
		if (!changed) return;
		if (typeof previous?.cleanup === "function") previous.cleanup();
		const cleanup = run();
		target.slots[index] = {
			deps: deps ?? [],
			cleanup: typeof cleanup === "function" ? cleanup : undefined
		};
	}
};

/**
 * One mounted seat. The react stand-in above is created once and dispatches to
 * whichever harness is currently rendering, because the bundle captures its
 * `require("react")` result at factory time — before any harness exists.
 * @param Component - the registered component under test.
 * @returns `mount(props)` plus the latest rendered tree.
 */
function createHarness(Component) {
	const target = {
		cursor: 0,
		slots: [],
		render: () => {}
	};
	let props = {};
	let tree = null;
	target.render = () => {
		target.cursor = 0;
		hookTarget = target;
		tree = Component(props);
		return tree;
	};
	return {
		mount(next) {
			props = next;
			target.slots = [];
			return target.render();
		},
		getTree: () => tree
	};
}

/** Collect every string rendered under one tree node. */
function texts(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) texts(child, out);
		return out;
	}
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (typeof node === "object") texts(node.props?.children, out);
	return out;
}

/** Collect every `button` element in one tree. */
function buttons(node, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const child of node) buttons(child, out);
		return out;
	}
	if (node.type === "button") out.push(node);
	buttons(node.props?.children, out);
	return out;
}

/** Fake `useChat` seat: applies the seat's selector to a snapshot with one turn order. */
function chatSeat(order) {
	return (selector) => selector({
		timeline: {
			turnOrder: order
		}
	});
}

console.log("browser half");

const clientSource = await readFile(CLIENT_PATH, "utf8");
let loaded = null;
const windowStub = {
	__ModuleLoader__: {
		load(record) {
			loaded = record;
		}
	}
};
// The bundle is a plain script that registers itself on window.__ModuleLoader__.
new Function("window", clientSource)(windowStub);

check("client bundle registers itself", loaded?.id === "dsh-followup-suggestions", String(loaded?.id));

const clientModule = loaded.factory((specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`unexpected require(${specifier})`);
});

let registration = null;
let localeRegistrations = 0;
const clientCtx = {
	effect(run) {
		const dispose = run();
		return typeof dispose === "function" ? dispose : () => {};
	},
	locale: {
		register() {
			localeRegistrations += 1;
			return () => {};
		}
	},
	slots: {
		inject(key, register) {
			registration = { key, entry: register() };
			return () => {};
		},
		register(spec, Component) {
			return { spec, Component };
		}
	}
};
clientModule.apply(clientCtx);
check("client registers one dictionary set", localeRegistrations === 1, String(localeRegistrations));
check("client registers into the turn-tail seat", registration?.key === "conversation.chat.turnTail", String(registration?.key));
check("the entry declares the seat name", registration?.entry?.spec?.name === "conversation.chat.turnTail", String(registration?.entry?.spec?.name));
check("the entry declares its locale namespace", registration?.entry?.spec?.locale === "followupSuggestions", String(registration?.entry?.spec?.locale));

const Component = registration.entry.Component;
const draftCalls = [];
const actions = {
	setDraft(text) {
		draftCalls.push(text);
	}
};
/** Mounted seat of the current case; `mountSeat` replaces it. */
let seatHarness = null;
/** Mount one seat render under a fresh harness. */
function mountSeat(turnProps) {
	seatHarness = createHarness(Component);
	return seatHarness.mount(turnProps);
}
const seat = (turn, order, overrides = {}) => ({
	turn,
	sessionId: "s1",
	useChat: chatSeat(order),
	inputActions: actions,
	t: (key) => ({
		label: "为你推荐",
		insert: "填入输入框"
	})[key] ?? key,
	...overrides
});

// Persistent tier: seed the store before the first mount, so hydration reads it.
const persistent = new Map([["dsh.followupSuggestions.v1", JSON.stringify({
	version: 1,
	entries: {
		"s1|2|900": {
			items: ["缓存的推荐一", "缓存的推荐二"],
			at: Date.now()
		}
	}
})]]);
globalThis.localStorage = {
	getItem(key) {
		return persistent.has(key) ? persistent.get(key) : null;
	},
	setItem(key, value) {
		persistent.set(key, String(value));
	},
	removeItem(key) {
		persistent.delete(key);
	}
};
/** Every entry currently in the persistent tier's payload. */
const storedEntries = () => Object.keys(JSON.parse(persistent.get("dsh.followupSuggestions.v1") ?? "{\"entries\":{}}").entries ?? {});

// A live turn renders nothing and never calls the Host.
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
	fetchCalls.push({ url, body: JSON.parse(init.body) });
	return {
		ok: true,
		json: async () => ({ items: ["继续解释细节", "给一个类比"] })
	};
};

{
	const cached = mountSeat(seat({
		turn: 2,
		status: "closed"
	}, [2], { seq: 900 }));
	check("a persisted answer renders immediately", cached !== null, String(cached));
	check("the persisted answer is the rendered one", same(texts(cached).slice(1), ["缓存的推荐一", "缓存的推荐二"]), JSON.stringify(texts(cached)));
	check("a persisted answer calls no route", fetchCalls.length === 0, String(fetchCalls.length));
}

{
	const live = mountSeat(seat({ turn: 2, status: "open" }, [1, 2]));
	check("a live turn renders nothing", live === null, JSON.stringify(live));
	check("a live turn calls no route", fetchCalls.length === 0, String(fetchCalls.length));
}

{
	const older = mountSeat(seat({ turn: 1, status: "closed" }, [1, 2]));
	check("a closed but not newest turn renders nothing", older === null, JSON.stringify(older));
}

{
	mountSeat(seat({ turn: 2, status: "closed" }, [1, 2]));
	const placeholder = seatHarness.getTree();
	check("the newest closed turn shows a placeholder while the Host answers", placeholder !== null, String(placeholder));
	check("the placeholder holds three pills and no chip", texts(placeholder).includes("为你推荐") && buttons(placeholder).length === 0, JSON.stringify(texts(placeholder)));
	await flush();
	const tree = seatHarness.getTree();
	check("chips appear once the Host answers", tree !== null, String(tree));
	check("the placeholder is gone", tree?.props?.children?.[1]?.props?.children?.length === 2, JSON.stringify(texts(tree)));
	check("the label is rendered", texts(tree).includes("为你推荐"), JSON.stringify(texts(tree)));
	check("one chip per returned suggestion", buttons(tree).length === 2, String(buttons(tree).length));
	check("chip order follows the Host", same(texts(tree).slice(1), ["继续解释细节", "给一个类比"]), JSON.stringify(texts(tree)));
	check("the request carries the session and turn", same(fetchCalls.at(-1)?.body, { sessionId: "s1", turn: 2 }), JSON.stringify(fetchCalls.at(-1)?.body));
	check("the request hits the Host route", fetchCalls.at(-1)?.url === "/api/dsh-followup-suggest", String(fetchCalls.at(-1)?.url));

	buttons(tree)[1].props.onClick();
	check("a click fills the draft instead of sending", same(draftCalls, ["给一个类比"]), JSON.stringify(draftCalls));

	check("the fetched answer is written to the persistent tier", storedEntries().includes("s1|2|"), JSON.stringify(storedEntries()));
	const before = fetchCalls.length;
	mountSeat(seat({ turn: 2, status: "closed" }, [1, 2]));
	await flush();
	check("a remount is served from the in-page tier", fetchCalls.length === before, `${fetchCalls.length} vs ${before}`);
	check("the remounted seat still renders", seatHarness.getTree() !== null, "rendered nothing");
	mountSeat(seat({ turn: 2, status: "closed" }, [1, 2], { seq: 901 }));
	await flush();
	check("a new closing sequence asks the Host again", fetchCalls.length === before + 1, `${fetchCalls.length} vs ${before + 1}`);
}

{
	// The Host failing (or returning an empty list) must leave the transcript untouched.
	fetchCalls.length = 0;
	globalThis.fetch = async () => {
		throw new Error("offline");
	};
	mountSeat(seat({ turn: 5, status: "closed" }, [5]));
	await flush();
	check("a Host failure renders nothing", seatHarness.getTree() === null, JSON.stringify(seatHarness.getTree()));

	globalThis.fetch = async (url, init) => {
		fetchCalls.push({ url, body: JSON.parse(init.body) });
		return {
			ok: true,
			json: async () => ({ items: [] })
		};
	};
	mountSeat(seat({ turn: 6, status: "closed" }, [6], { seq: 600 }));
	await flush();
	check("an empty answer renders nothing", seatHarness.getTree() === null, JSON.stringify(seatHarness.getTree()));
	check("an empty answer is not cached", !storedEntries().includes("s1|6|600"), JSON.stringify(storedEntries()));
	const beforeEmpty = fetchCalls.length;
	mountSeat(seat({ turn: 6, status: "closed" }, [6], { seq: 600 }));
	await flush();
	check("an uncached failure is retried on the next visit", fetchCalls.length === beforeEmpty + 1, `${fetchCalls.length} vs ${beforeEmpty + 1}`);
}

{
	// Defensive path: a composition without the `chat` seat must not crash the seat.
	const withoutSeat = mountSeat(seat({ turn: 3, status: "closed" }, [3], { useChat: undefined }));
	check("a missing chat seat renders nothing instead of throwing", withoutSeat === null, JSON.stringify(withoutSeat));

	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ items: ["继续解释细节", "给一个类比"] })
	});
	const withoutActions = mountSeat(seat({ turn: 4, status: "closed" }, [4], { inputActions: undefined }));
	await flush();
	const tree = seatHarness.getTree();
	check("a missing input seat still renders chips", tree !== null, String(tree));
	buttons(tree)[0].props.onClick();
	check("a click without the input seat is a no-op", draftCalls.length === 1, String(draftCalls.length));
}

//#endregion

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
