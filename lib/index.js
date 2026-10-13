/**
 * Follow-up suggestions — Host half.
 *
 * One job: answer `POST /api/dsh-followup-suggest` with 1-3 short next-prompt
 * strings for a Session whose latest Turn just closed. The browser half owns
 * "when" (only the last closed Turn of the viewed Session) and "where" (the
 * `conversation.chat.turnTail` seat); this half owns "how".
 *
 * The model route is the Session's OWN selection, never a configured one: the
 * request header the agent loop logged for that Session carries
 * `config.provider` / `config.model`, which is exactly what `/model` and the
 * composer model seat switch. A Session that never issued a request has no
 * header, and this plugin then answers with an empty list instead of guessing.
 *
 * Editing the conversation is deliberately not part of the design: the call is
 * one-shot, its prompt is built from already-logged messages, and its output
 * reaches only the browser — nothing here appends to the Session log or reaches
 * the agent loop, so the conversation's model-visible history is unchanged.
 *
 * One closed Turn costs one model call. The route remembers settled answers and
 * shares the promise of a call already in flight, both keyed by the Turn's
 * closing node sequence; the browser half keeps its own persistent copy of the
 * same key so a reload or a second visit never comes back here. The exception is
 * the browser's refresh button: its request carries `refresh: true`, which skips
 * both shortcuts, calls the model again, and replaces the settled answer for the
 * key it was handed.
 */

import { BlockAssembler, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";

/** Exact route the browser half calls; it sits behind the carrier's trust fence. */
const SUGGEST_PATH = "/api/dsh-followup-suggest";

/** Upper bound on returned chips; the product promise is "1-3". */
const MAX_ITEMS = 3;
/** A chip longer than this reads as an instruction, not a next prompt. */
const MAX_ITEM_CHARS = 60;
/** Retained tail of the closing assistant reply used as context. */
const DEFAULT_MAX_CONTEXT_CHARS = 1200;
/**
 * Output cap. A cap is not a target — it costs nothing unless the model uses
 * it — so this stays generous: a route that inherits a high reasoning effort
 * spends the budget thinking first, and a tight cap then truncates the answer
 * to fewer than `maxItems` lines.
 */
const DEFAULT_MAX_TOKENS = 320;
/** Wall-clock bound on the one-shot call. */
const DEFAULT_TIMEOUT_MS = 30000;
/** Lowest reasoning effort: choosing three next prompts needs no deliberation. */
const DEFAULT_REASONING_EFFORT = "off";
/** Terminal failure code a route returns when it does not know the requested effort. */
const UNSUPPORTED_EFFORT_CODE = "UNSUPPORTED_REASONING_EFFORT";
/** Settled answers kept per Host process before the oldest is dropped. */
const CACHE_MAX_ENTRIES = 256;
/** Wall-clock bound on a cached answer; the browser tier keeps its own, longer one. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Instruction for the suggestion call. It asks for the user's own voice, not
 * an assistant's, because every chip is inserted into the composer as a message
 * the user may then edit and send.
 */
const SYSTEM_PROMPT = [
	"You propose the user's next messages in an ongoing chat.",
	"Read the final exchange, then output 1-3 follow-up requests the user is likely to send next.",
	"One per line: no numbering, bullets, quotes, or commentary; each line is a complete instruction the user could send as-is, of at most 30 CJK or 60 latin characters; the same language as the conversation; specific to what was just discussed; never restating the user's last message.",
	"Output only the lines."
].join("\n");

/** Plugin name the loader row addresses. */
const name = "dsh-followup-suggestions";
/** Services this plugin cannot work without: the route registry, the model calls, the Session log. */
const inject = ["connection", "llm", "sessions"];

/**
 * Clamp one numeric option, falling back when it is absent or unusable.
 * @param value - candidate from the loader config.
 * @param fallback - value to use when the candidate is out of range.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the accepted value.
 */
function clampNumber(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Normalize the reasoning-effort option.
 * @param value - candidate from the loader config.
 * @returns the effort to request, or `null` to inherit the route default.
 */
function normalizeEffort(value) {
	if (value === undefined) return DEFAULT_REASONING_EFFORT;
	if (value === null) return null;
	if (typeof value !== "string") return DEFAULT_REASONING_EFFORT;
	const trimmed = value.trim();
	return trimmed.length === 0 || trimmed === "inherit" || trimmed === "default" ? null : trimmed;
}

/**
 * Resolve the effective settings from loader config.
 * @param config - plugin configuration; omitted fields keep their defaults.
 * @returns clamped limits for one suggestion call.
 */
function resolveSettings(config) {
	const source = config ?? {};
	return {
		maxItems: clampNumber(source.maxItems, MAX_ITEMS, 1, MAX_ITEMS),
		maxTokens: clampNumber(source.maxTokens, DEFAULT_MAX_TOKENS, 32, 4096),
		timeoutMs: clampNumber(source.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000),
		maxContextChars: clampNumber(source.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, 200, 20000),
		reasoningEffort: normalizeEffort(source.reasoningEffort)
	};
}

/**
 * Join the text blocks of one message.
 * @param message - a derived model message.
 * @returns its plain text, with non-text blocks dropped.
 */
function textOf(message) {
	if (message === undefined || message === null || !Array.isArray(message.content)) return "";
	const parts = [];
	for (const block of message.content) {
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * The last message of one role that carries text.
 * @param messages - derived model history in order.
 * @param role - role to search for.
 * @returns the message text, or `''` when no such message carries any.
 */
function lastTextOf(messages, role) {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined || message === null || message.role !== role) continue;
		const text = textOf(message).trim();
		if (text.length > 0) return text;
	}
	return "";
}

/**
 * Retain the tail of one block of context.
 * @param text - full text.
 * @param limit - maximum retained characters.
 * @returns the retained tail, marked when it was cut.
 */
function tail(text, limit) {
	if (text.length <= limit) return text;
	return `…${text.slice(text.length - limit)}`;
}

/**
 * Build the one user message the suggestion call receives.
 * @param lastUser - the Session's last user message text.
 * @param lastAssistant - the closing assistant reply text.
 * @param settings - resolved limits.
 * @returns the prompt body.
 */
function buildPrompt(lastUser, lastAssistant, settings) {
	return [
		"【用户最近的消息】",
		lastUser.length === 0 ? "(无)" : tail(lastUser, settings.maxContextChars),
		"",
		"【助手最后的回复】",
		tail(lastAssistant, settings.maxContextChars),
		"",
		`请给出 1-${settings.maxItems} 条后续指令，每行一条，不要编号。`
	].join("\n");
}

/**
 * Strip list markers and surrounding quotes from one candidate line.
 * @param line - raw model output line.
 * @returns the chip text, possibly empty.
 */
function stripDecoration(line) {
	return line
		.replace(/^\s*(?:[-*•·—]+|\d{1,2}\s*[.、)）:])\s*/u, "")
		.replace(/^["'“”‘’「『【]+/u, "")
		.replace(/["'“”‘’」』】]+$/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Turn assembled assistant blocks into chips.
 * @param blocks - `BlockAssembler.blocks()` output.
 * @param maxItems - maximum chips to return.
 * @returns deduplicated chip texts in model order.
 */
function parseSuggestions(blocks, maxItems) {
	const text = (Array.isArray(blocks) ? blocks : [])
		.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	const items = [];
	const seen = new Set();
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = stripDecoration(rawLine);
		if (line.length === 0 || line.length > MAX_ITEM_CHARS) continue;
		const key = line.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(line);
		if (items.length >= maxItems) break;
	}
	return items;
}

/**
 * Run one suggestion call and assemble its blocks.
 *
 * @param ctx - Host context carrying the LLM service.
 * @param settings - resolved limits.
 * @param route - the Session's provider and model.
 * @param sessionId - Session the call is attributed to.
 * @param prompt - the single user message body.
 * @param reasoningEffort - effort to request, or `undefined` to inherit the route default.
 * @returns the assembled text blocks and the terminal finish reason.
 */
async function runCall(ctx, settings, route, sessionId, prompt, reasoningEffort) {
	const assembler = new BlockAssembler();
	const call = {
		provider: route.provider,
		model: route.model,
		maxTokens: settings.maxTokens,
		sessionId,
		messages: [
			createSystemMessage(SYSTEM_PROMPT),
			createUserMessage({
				content: [{ type: "text", text: prompt }],
				source: { kind: "user" }
			})
		],
		signal: AbortSignal.timeout(settings.timeoutMs),
		...reasoningEffort === undefined ? {} : { reasoningEffort }
	};
	for await (const chunk of ctx.llm.stream(call)) assembler.push(chunk);
	return {
		blocks: assembler.blocks(),
		finish: assembler.finish
	};
}

/**
 * Generate the chips for one Session.
 *
 * Every failure path answers with an empty list: suggestions are an optional
 * affordance, so a gone Session, an unrouted Session, or a failed model call
 * must leave the transcript exactly as it was rather than surface an error.
 *
 * The call asks for the lowest advertised reasoning effort, because picking
 * three short next prompts needs no deliberation and thinking is what dominates
 * this call's latency. A route that does not know that effort answers with
 * `UNSUPPORTED_REASONING_EFFORT`; the call is then repeated without an effort
 * and the route is remembered as effortless, so the extra round trip happens at
 * most once per route for the lifetime of the process.
 *
 * @param state - the plugin's caches and resolved settings.
 * @param sessionId - Session whose last closed Turn the browser is showing.
 * @returns 0-`maxItems` chip texts.
 */
async function suggestFor(state, sessionId) {
	const { ctx, settings } = state;
	let session;
	try {
		session = ctx.sessions.get(sessionId);
	} catch {
		return [];
	}
	if (session === undefined || session === null) return [];

	const target = typeof session.requestHeader === "function" ? session.requestHeader()?.config : undefined;
	const provider = target?.provider;
	const model = target?.model;
	if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) return [];

	const messages = typeof session.deriveMessages === "function" ? session.deriveMessages() : [];
	const lastAssistant = lastTextOf(messages, "assistant");
	if (lastAssistant.length === 0) return [];

	const route = {
		provider,
		model
	};
	const key = `${provider}/${model}`;
	const prompt = buildPrompt(lastTextOf(messages, "user"), lastAssistant, settings);
	const requested = settings.reasoningEffort === null || state.effortlessRoutes.has(key) ? undefined : settings.reasoningEffort;
	let result = await runCall(ctx, settings, route, sessionId, prompt, requested);
	if (result.finish?.kind === "error" && requested !== undefined && result.finish.failure?.code === UNSUPPORTED_EFFORT_CODE) {
		state.effortlessRoutes.add(key);
		result = await runCall(ctx, settings, route, sessionId, prompt, undefined);
	}
	if (result.finish?.kind === "error") return [];
	return parseSuggestions(result.blocks, settings.maxItems);
}

/**
 * Cache key for one closed Turn's answer.
 *
 * The final node's sequence identifies the exact closing reply: a retry, a
 * branch, or a later Turn all move it, so an entry invalidates itself instead
 * of needing a session-event watcher.
 *
 * @param sessionId - Session whose Turn closed.
 * @param turn - Turn number, used when the caller sent no sequence.
 * @param seq - closing final node sequence, when the caller sent one.
 * @returns the cache key.
 */
function answerKey(sessionId, turn, seq) {
	return `${sessionId}\u0000${seq ?? turn ?? ""}`;
}

/**
 * Store one answer and drop the oldest entries past the bound.
 * @param answers - the settled-answer cache.
 * @param key - cache key.
 * @param items - the chips to remember.
 */
function remember(answers, key, items) {
	answers.set(key, {
		items,
		at: Date.now()
	});
	if (answers.size <= CACHE_MAX_ENTRIES) return;
	const ordered = [...answers.entries()].sort((left, right) => right[1].at - left[1].at);
	answers.clear();
	for (const [entryKey, value] of ordered.slice(0, CACHE_MAX_ENTRIES)) answers.set(entryKey, value);
}

/**
 * Answer one closed Turn, reusing a settled answer or one already in flight.
 *
 * Two carriers can ask in the same instant (a reload races the mount, or a
 * second tab opens), and the browser tier cannot see the other tab; sharing the
 * in-flight promise here is what keeps that race to exactly one model call.
 * A failed or empty answer is never remembered, so the next ask retries it.
 *
 * A refresh is the one caller that must not take either shortcut: the browser
 * asked for different text than the text it is showing, so the model is called
 * again and the settled answer for that key is replaced. It is not parked in the
 * in-flight map either — an ordinary ask arriving while a refresh runs should
 * still join the ordinary call, and a refresh should never be answered by one.
 *
 * @param state - the plugin's caches and resolved settings.
 * @param sessionId - Session whose Turn closed.
 * @param turn - Turn number from the request.
 * @param seq - closing final node sequence from the request.
 * @param refresh - whether the caller asked for one fresh batch.
 * @returns 0-`maxItems` chip texts.
 */
function cachedAnswer(state, sessionId, turn, seq, refresh = false) {
	const key = answerKey(sessionId, turn, seq);
	if (!refresh) {
		const settled = state.answers.get(key);
		if (settled !== undefined && Date.now() - settled.at <= CACHE_TTL_MS) return Promise.resolve(settled.items);
		const running = state.pending.get(key);
		if (running !== undefined) return running;
	}
	const call = (async () => {
		try {
			const items = await suggestFor(state, sessionId);
			if (items.length > 0) remember(state.answers, key, items);
			return items;
		} finally {
			if (!refresh) state.pending.delete(key);
		}
	})();
	if (!refresh) state.pending.set(key, call);
	return call;
}

/**
 * Answer one suggestion request with JSON.
 * @param ctx - Host context.
 * @param state - the plugin's caches and resolved settings.
 * @param request - the carrier's buffered Fetch request.
 * @returns the JSON response, always with a `items` array.
 */
async function handleSuggest(ctx, state, request) {
	const headers = { "cache-control": "no-store" };
	let body;
	try {
		body = await request.json();
	} catch {
		return Response.json({ items: [], error: "expected a JSON body" }, { status: 400, headers });
	}
	const record = body !== null && typeof body === "object" ? body : {};
	const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
	if (sessionId.length === 0) return Response.json({ items: [], error: "expected { sessionId }" }, { status: 400, headers });
	const turn = Number.isSafeInteger(record.turn) ? record.turn : undefined;
	const seq = Number.isSafeInteger(record.seq) ? record.seq : undefined;
	const refresh = record.refresh === true;
	try {
		return Response.json({ items: await cachedAnswer(state, sessionId, turn, seq, refresh) }, { headers });
	} catch (error) {
		ctx.logger?.warn?.(`dsh-followup-suggestions: ${error instanceof Error ? error.message : String(error)}`);
		return Response.json({ items: [], error: "suggestion call failed" }, { status: 500, headers });
	}
}

/**
 * Register the suggestion route.
 *
 * Deliberately a named export with no default: the Loader takes a module's
 * default export when it has one, and a default that is the bare `apply`
 * function is a plugin *without* this module's `name` and `inject` — the fiber
 * would then activate with an empty inject list and the first service read
 * would throw.
 *
 * @param ctx - Host context carrying the carrier and the LLM service.
 * @param config - plugin configuration; omitted fields keep their defaults.
 */
function apply(ctx, config = {}) {
	const state = {
		ctx,
		settings: resolveSettings(config),
		answers: new Map(),
		pending: new Map(),
		/** Routes that rejected the requested reasoning effort, so it is not asked twice. */
		effortlessRoutes: new Set()
	};
	ctx.effect(() => ctx.connection.fetch.register({
		path: SUGGEST_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: (request) => handleSuggest(ctx, state, request)
	}), "dsh-followup-suggestions: suggest route");
}

export { SUGGEST_PATH, apply, inject, name };
