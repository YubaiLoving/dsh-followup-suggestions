/**
 * Stub for `@deepseek-ai/dsh-llm` used only by smoke.mjs.
 *
 * The Host half imports three names from that package. Rather than pull the
 * real 100 KB bundle (which is not resolvable from this repository), the smoke
 * test aliases the specifier here and reproduces exactly the surface the plugin
 * touches: the two message factories and a text-only stream assembler.
 */

let messageSeq = 0;

/** Freeze one identified message the way the real factories do. */
function createMessage(input) {
	messageSeq += 1;
	return Object.freeze({
		...input,
		id: `stub-${messageSeq}`
	});
}

/** @returns an identified system message. */
export function createSystemMessage(text) {
	return createMessage({
		role: "system",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		source: { kind: "system-prompt" }
	});
}

/** @returns an identified user message. */
export function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}

/** Text-only stand-in for the real assembler. */
export class BlockAssembler {
	constructor() {
		this.text = "";
		this._finish = undefined;
	}
	push(chunk) {
		if (chunk.type === "text-delta") this.text += chunk.text;
		else if (chunk.type === "finish") this._finish = chunk.reason;
	}
	get finish() {
		return this._finish ?? { kind: "stop" };
	}
	blocks() {
		return this.text.length === 0 ? [] : [{ type: "text", text: this.text }];
	}
}
