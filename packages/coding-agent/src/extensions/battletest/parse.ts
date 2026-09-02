/**
 * Natural-language parsing for the /battletest command.
 *
 * "/battletest 15 subagents using opencode minimax-m3 to test a feature"
 * means: 15 testers, each running on opencode/minimax-m3, focused on testing
 * a feature. The pieces are heuristics: a leading count (digits, or a number
 * word followed by a unit noun like "testers"), a model named after a
 * connector word ("using/with/via/on ..."), and everything else becomes the
 * run's focus. Whatever the heuristics cannot pin down stays in the focus
 * text, so the historic "/battletest <count> [focus]" forms keep working.
 */

import type { ThinkingLevel } from "@smolt/agent-core";
import type { Api, KnownProvider, Model } from "@smolt/ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { defaultModelPerProvider, parseModelPattern } from "../../core/model-resolver.ts";

export type ModelPhraseResolution =
	| { status: "resolved"; model: Model<Api>; thinkingLevel?: ThinkingLevel }
	| { status: "ambiguous"; options: string[] }
	| { status: "unresolved" };

const canonicalRef = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/**
 * Resolve a model named the way a person would say it: "opencode/minimax-m3",
 * "opencode minimax-m3", "minimax m3", "openai codex gpt-5.5", "kimi-k2.6:high".
 * Resolves against the full catalog (`getAll()`), not just authed models, so a
 * missing API key surfaces as a clear error instead of "no such model".
 */
export function resolveModelPhrase(phrase: string, models: readonly Model<Api>[]): ModelPhraseResolution {
	const text = phrase.trim();
	if (text === "") return { status: "unresolved" };

	// Canonical and single-token forms: "provider/model", a bare id, a partial
	// id, an optional ":thinking" suffix. A bare id that exists on several
	// providers ("minimax-m3" on minimax, minimax-cn, opencode) is ambiguous
	// by design: it must not silently pick one for a 15-tester run.
	const pattern = parseModelPattern(text, [...models]);
	if (pattern.model) {
		if (!text.includes("/")) {
			const sameId = models.filter((m) => m.id.toLowerCase() === pattern.model!.id.toLowerCase());
			if (sameId.length > 1) {
				// Prefer the shortest provider name first, so the suggestion is
				// the global provider (minimax) rather than a mirror (minimax-cn).
				const options = sameId
					.map(canonicalRef)
					.sort((a, b) => a.split("/")[0]!.length - b.split("/")[0]!.length || a.localeCompare(b));
				return { status: "ambiguous", options };
			}
		}
		return { status: "resolved", model: pattern.model, thinkingLevel: pattern.thinkingLevel };
	}

	// Natural phrase: a provider word followed by model words. Prefer the
	// longest leading run that names a provider ("openai codex" beats
	// "openai"), then match the rest against that provider's model ids.
	const tokens = text.toLowerCase().split(/\s+/);
	const providers = new Set(models.map((m) => m.provider.toLowerCase()));
	for (let split = tokens.length - 1; split >= 1; split--) {
		const left = tokens.slice(0, split);
		const providerKey = [left.join(""), left.join("-")].find((key) => providers.has(key));
		if (!providerKey) continue;
		const providerModels = models.filter((m) => m.provider.toLowerCase() === providerKey);
		const right = tokens.slice(split);
		const idKeys = [...new Set([right.join(" "), right.join("-"), right.join(""), right[right.length - 1] ?? ""])];
		for (const idKey of idKeys) {
			const exact = providerModels.find((m) => m.id.toLowerCase() === idKey);
			if (exact) return { status: "resolved", model: exact };
		}
		for (const idKey of idKeys) {
			// "m3" or "5.5" are real model fragments; short plain words ("a",
			// "to", "the") must never fuzzy-match an id substring.
			if (idKey.length < 3 && !/\d/.test(idKey)) continue;
			const partial = providerModels.filter((m) => m.id.toLowerCase().includes(idKey));
			if (partial.length > 0) return { status: "resolved", model: pickWithinProvider(providerKey, partial) };
		}
	}

	// No provider named at all: match the words against model ids across the
	// whole catalog, the way a person says "use mimo v2.5" without caring who
	// serves it. Several providers carrying the id is ambiguous here — the
	// caller holds the auth and usage context needed to pick one sensibly.
	// Only version-shaped names ride this path (a digit somewhere: "mimo
	// v2.5", "m3", "gpt-5.5"). Plain words after common connectors are prose
	// — "on mobile", "with images" — and matching them once put a whole run
	// on a model nobody asked for.
	const bareKeys = [...new Set([tokens.join(" "), tokens.join("-"), tokens.join(""), tokens[tokens.length - 1]!])]
		.map((key) => key.replace(/[^a-z0-9.]/g, ""))
		.filter((key) => key.length >= 2 && /\d/.test(key));
	for (const bareKey of bareKeys) {
		const matches = models.filter((m) =>
			m.id
				.toLowerCase()
				.replace(/[^a-z0-9.]/g, "")
				.includes(bareKey),
		);
		if (matches.length === 0) continue;
		const byProvider = new Set(matches.map((m) => m.provider));
		if (byProvider.size === 1) {
			return { status: "resolved", model: pickWithinProvider(matches[0]!.provider.toLowerCase(), matches) };
		}
		const options = [...new Set(matches.map(canonicalRef))].sort(
			(a, b) => a.split("/")[0]!.length - b.split("/")[0]!.length || a.localeCompare(b),
		);
		return { status: "ambiguous", options };
	}
	return { status: "unresolved" };
}

/** Among several matches inside one provider, prefer its default model, else the highest id. */
function pickWithinProvider(providerKey: string, candidates: Model<Api>[]): Model<Api> {
	const defaultId = defaultModelPerProvider[providerKey as KnownProvider];
	const preferred = defaultId !== undefined ? candidates.find((m) => m.id === defaultId) : undefined;
	if (preferred) return preferred;
	return [...candidates].sort((a, b) => b.id.localeCompare(a.id))[0]!;
}

/** Whether the phrase plausibly names a model: any word is (a prefix of) a known provider. */
export function looksLikeModelReference(phrase: string, models: readonly Model<Api>[]): boolean {
	const providers = new Set(models.map((m) => m.provider.toLowerCase()));
	return phrase
		.toLowerCase()
		.split(/\s+/)
		.some((token) => providers.has(token) || (token.length >= 5 && [...providers].some((p) => p.startsWith(token))));
}

/** Closest catalog models to an unmatched phrase, for the error message. */
export function suggestModels(phrase: string, models: readonly Model<Api>[], limit = 5): string[] {
	const tokens = phrase
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.length >= 3);
	return models
		.filter((m) => tokens.some((token) => m.provider.toLowerCase() === token || m.id.toLowerCase().includes(token)))
		.map(canonicalRef)
		.sort()
		.slice(0, limit);
}

/** Number words accepted as a tester count. */
const NUMBER_WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	dozen: 12,
	pair: 2,
	couple: 2,
	few: 3,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
	twenty: 20,
};

/** Nouns that mark the number before them as a tester count ("15 subagents"). */
const COUNT_NOUNS = new Set([
	"tester",
	"testers",
	"subagent",
	"subagents",
	"agent",
	"agents",
	"user",
	"users",
	"persona",
	"personas",
	"bot",
	"bots",
	"monkey",
	"monkeys",
	"simulated",
	// Research teams are counted the same way: "/research 3 researchers into ...".
	"researcher",
	"researchers",
	"investigator",
	"investigators",
	"analyst",
	"analysts",
]);

/** Words that can introduce a model phrase ("using opencode minimax-m3"). */
const MODEL_CONNECTORS = new Set(["using", "use", "uses", "with", "via", "on", "through", "running", "model"]);

/** Trailing filler trimmed from an unresolvable model phrase in error messages. */
const PHRASE_FILLER = new Set([...MODEL_CONNECTORS, "to", "and", "the", "for"]);

export interface ParsedInvocation {
	/** Testers requested; undefined when not stated (the caller applies its default). */
	count: number | undefined;
	/** Model the testers should run on, when one was named and resolved. */
	model: Model<Api> | undefined;
	/** Thinking level stated with the model ("...:high"); undefined otherwise. */
	thinkingLevel: ThinkingLevel | undefined;
	/** Everything left after the count and the model phrase. */
	focus: string;
	/** A model was named but could not be resolved; the run must not start. */
	error: string | undefined;
	/** The candidate refs behind an ambiguous model name, for the caller to pick from. */
	ambiguous: string[] | undefined;
}

const word = (token: string): string => token.toLowerCase().replace(/[^a-z]/g, "");
const isCountNoun = (token: string): boolean => COUNT_NOUNS.has(word(token));

export function parseBattletestInvocation(args: string, models: readonly Model<Api>[]): ParsedInvocation {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter((token) => token !== "");
	if (tokens.length === 0) {
		return {
			count: undefined,
			model: undefined,
			thinkingLevel: undefined,
			focus: "",
			error: undefined,
			ambiguous: undefined,
		};
	}

	let at = 0;
	let count: number | undefined;

	// Leading digits keep the historic positional form: "/battletest 3 focus".
	if (/^\d+$/.test(tokens[0]!)) {
		count = Number.parseInt(tokens[0]!, 10);
		at = 1;
	} else {
		// A number word only counts when a unit noun follows it: "five testers".
		const value = NUMBER_WORDS[word(tokens[0]!)];
		if (value !== undefined && tokens.length >= 2 && isCountNoun(tokens[1]!)) {
			count = value;
			at = 1;
		}
	}
	// Unit nouns ride along with the count ("15 subagents", "five testers").
	while (at < tokens.length && isCountNoun(tokens[at]!)) at++;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	let error: string | undefined;
	let ambiguous: string[] | undefined;

	for (let i = at; i < tokens.length - 1 && model === undefined && error === undefined; i++) {
		const connector = tokens[i]!.toLowerCase();
		if (!MODEL_CONNECTORS.has(connector)) continue;
		// A URL after the connector is a hosted target, not a model.
		if (/^https?:\/\//i.test(tokens[i + 1] ?? "")) continue;
		// Consecutive connector words ("using model opencode ...") read as one.
		let start = i + 1;
		while (start < tokens.length && MODEL_CONNECTORS.has(tokens[start]!.toLowerCase())) start++;
		if (start >= tokens.length) break;
		// Longest window first: "openai codex gpt-5.5" must not stop at "openai codex".
		for (const size of [3, 2, 1]) {
			const windowTokens = tokens.slice(start, start + size);
			if (windowTokens.length < size) continue;
			// A very short lone word is ordinary prose ("with a maxed out cart"),
			// not a model name; fuzzy-matching it would resolve nonsense.
			if (size === 1 && windowTokens[0]!.length < 4) continue;
			const phrase = windowTokens.join(" ");
			const resolution = resolveModelPhrase(phrase, models);
			if (resolution.status === "resolved") {
				model = resolution.model;
				thinkingLevel = resolution.thinkingLevel;
				at = start + size;
				break;
			}
			if (resolution.status === "ambiguous") {
				ambiguous = resolution.options;
				error =
					`Model "${phrase}" is available on several providers: ${resolution.options.join(", ")}. ` +
					`Name one, e.g. "${resolution.options[0]}".`;
				break;
			}
		}
		if (model !== undefined || error !== undefined) break;
		// Nothing resolved: a phrase that still names a known provider is a
		// typo'd model, which must not silently run on the default model.
		const phraseTokens = tokens.slice(start, start + 3);
		while (phraseTokens.length > 1 && PHRASE_FILLER.has(phraseTokens[phraseTokens.length - 1]!.toLowerCase())) {
			phraseTokens.pop();
		}
		const phrase = phraseTokens.join(" ");
		if (looksLikeModelReference(phrase, models)) {
			const suggestions = suggestModels(phrase, models);
			error =
				`No model matches "${phrase}".` +
				(suggestions.length > 0 ? ` Closest: ${suggestions.join(", ")}.` : "") +
				" Check available models with smolt --list-models.";
		}
	}

	let focus = tokens.slice(at).join(" ");
	// "…using minimax-m3 to test a feature" — the "to" belonged to the phrasing.
	focus = focus.replace(/^to\s+/i, "");
	return { count, model, thinkingLevel, focus, error, ambiguous };
}

// ------------------------------------------------------------------
// Model overrides for a team run: shared by /battletest and /research.
// ------------------------------------------------------------------

/** A model override for a run's team members, resolved from a name or phrase. */
export interface ModelOverride {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

/** Providers that resell other people's models; the failsafe, never the first pick. */
const AGGREGATOR_PROVIDERS = /^openrouter/i;

/**
 * Pick one provider for a model that several carry, without bothering the
 * user: the session's own provider first (the one they demonstrably use),
 * then subscription (OAuth) providers, then plain API keys, with aggregators
 * like openrouter last as the failsafe. Unauthed providers never win over an
 * authed one. Returns undefined only when none of the options exist.
 */
export function pickAmbiguousModel(options: string[], ctx: ExtensionContext): Model<Api> | undefined {
	const models = options
		.map((ref) => {
			const [provider, ...rest] = ref.split("/");
			return ctx.modelRegistry.find(provider ?? "", rest.join("/"));
		})
		.filter((model): model is Model<Api> => model !== undefined);
	if (models.length === 0) return undefined;
	const authed = models.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	const pool = authed.length > 0 ? authed : models;
	const current = pool.find((model) => model.provider === ctx.model?.provider);
	if (current) return current;
	const rank = (model: Model<Api>): number =>
		ctx.modelRegistry.isUsingOAuth(model) ? 0 : AGGREGATOR_PROVIDERS.test(model.provider) ? 2 : 1;
	return [...pool].sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider))[0];
}

/**
 * Resolve a team model override: a canonical ref ("opencode/minimax-m3"), a
 * plain phrase ("opencode minimax-m3"), or a phrase with a thinking level
 * ("opencode/kimi-k2.6:high"). Returns undefined when nothing was named, an
 * error string when the model cannot be used, the override otherwise.
 * `member` names who would run on it, for the error messages.
 */
export function resolveModelOverride(
	phrase: string,
	ctx: ExtensionContext,
	member = "tester",
): ModelOverride | string | undefined {
	if (phrase === "") return undefined;
	const resolution = resolveModelPhrase(phrase, ctx.modelRegistry.getAll());
	if (resolution.status === "ambiguous") {
		const picked = pickAmbiguousModel(resolution.options, ctx);
		if (picked) return { model: picked };
		return `Model "${phrase}" is available on several providers: ${resolution.options.join(", ")}. Name one.`;
	}
	if (resolution.status === "unresolved") {
		return `No model matches "${phrase}". Check available models with smolt --list-models.`;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(resolution.model)) {
		return `No API key configured for provider "${resolution.model.provider}" — every ${member} would fail. Configure it first.`;
	}
	return { model: resolution.model, thinkingLevel: resolution.thinkingLevel };
}
