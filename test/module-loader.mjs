/**
 * Module-resolution hook for smoke.mjs: alias the one bare specifier the
 * plugin's Host half imports to the local stub.
 */

const STUBBED = new Map([["@deepseek-ai/dsh-llm", new URL("./llm-stub.mjs", import.meta.url).href]]);

export async function resolve(specifier, context, next) {
	const target = STUBBED.get(specifier);
	if (target !== undefined) return { url: target, shortCircuit: true };
	return next(specifier, context);
}
