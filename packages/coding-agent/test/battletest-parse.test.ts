import type { Api, Model } from "@smolt/ai";
import { describe, expect, test } from "vitest";
import {
	looksLikeModelReference,
	parseBattletestInvocation,
	resolveModelPhrase,
	suggestModels,
} from "../src/extensions/battletest/parse.ts";

/**
 * Natural-language parsing for the /battletest command: tester counts in
 * plain words, model phrases resolved against the catalog (including
 * provider disambiguation), and everything else left as the run's focus.
 */

/** Only provider/id/name are read by the parser; the rest of Model is irrelevant. */
const m = (provider: string, id: string): Model<Api> => ({ provider, id, name: id }) as unknown as Model<Api>;

const catalog: Model<Api>[] = [
	m("opencode", "minimax-m3"),
	m("minimax", "MiniMax-M3"),
	m("minimax-cn", "MiniMax-M3"),
	m("opencode", "kimi-k2.6"),
	m("openai", "gpt-5.5"),
	m("openai-codex", "gpt-5.5"),
	m("anthropic", "claude-opus-4-8"),
];

const ref = (model: Model<Api> | undefined): string => (model ? `${model.provider}/${model.id}` : "undefined");

describe("provider-less model phrases", () => {
	const mimoCatalog = [...catalog, m("xiaomi", "mimo-v2.5"), m("openrouter", "mimo-v2.5")];

	test("'use' introduces a model phrase like 'using' does", () => {
		const parsed = parseBattletestInvocation("this app in the tui and use xiaomi mimo-v2.5", mimoCatalog);
		expect(ref(parsed.model)).toBe("xiaomi/mimo-v2.5");
	});

	test("a bare model name with no provider resolves across the whole catalog", () => {
		const result = resolveModelPhrase("mimo v2.5", [...catalog, m("xiaomi", "mimo-v2.5")]);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && ref(result.model)).toBe("xiaomi/mimo-v2.5");
	});

	test("a bare model name served by several providers surfaces the options for the caller to pick", () => {
		const parsed = parseBattletestInvocation("test the app use mimo v2.5", mimoCatalog);
		expect(parsed.model).toBeUndefined();
		expect(parsed.ambiguous).toEqual(["xiaomi/mimo-v2.5", "openrouter/mimo-v2.5"]);
	});
});

describe("resolveModelPhrase", () => {
	test("a canonical provider/model ref resolves exactly", () => {
		const result = resolveModelPhrase("opencode/minimax-m3", catalog);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && ref(result.model)).toBe("opencode/minimax-m3");
	});

	test("a plain phrase pins the provider word and the model word", () => {
		const result = resolveModelPhrase("opencode minimax-m3", catalog);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && ref(result.model)).toBe("opencode/minimax-m3");
	});

	test("a split model id is joined before matching", () => {
		const result = resolveModelPhrase("minimax m3", catalog);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && ref(result.model)).toBe("minimax/MiniMax-M3");
	});

	test("a multi-word provider name wins over its prefix", () => {
		const result = resolveModelPhrase("openai codex gpt-5.5", catalog);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && ref(result.model)).toBe("openai-codex/gpt-5.5");
	});

	test("a partial id inside a named provider prefers the provider's default model", () => {
		const result = resolveModelPhrase("openai gpt", catalog);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && ref(result.model)).toBe("openai/gpt-5.5");
	});

	test("a bare id that exists on several providers is ambiguous, naming them all", () => {
		const result = resolveModelPhrase("minimax-m3", catalog);
		expect(result.status).toBe("ambiguous");
		expect(result.status === "ambiguous" && result.options).toEqual([
			"minimax/MiniMax-M3",
			"opencode/minimax-m3",
			"minimax-cn/MiniMax-M3",
		]);
	});

	test("an explicit thinking level rides along with a canonical ref", () => {
		const result = resolveModelPhrase("opencode/kimi-k2.6:high", catalog);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && result.thinkingLevel).toBe("high");
	});

	test("an unmatched phrase is unresolved", () => {
		expect(resolveModelPhrase("opencode minimax-m9", catalog).status).toBe("unresolved");
		expect(resolveModelPhrase("the settings page", catalog).status).toBe("unresolved");
		expect(resolveModelPhrase("", catalog).status).toBe("unresolved");
	});
});

describe("parseBattletestInvocation", () => {
	test("the canonical plain-language example: count, model, focus", () => {
		const parsed = parseBattletestInvocation("15 subagents using opencode minimax-m3 to test a feature", catalog);
		expect(parsed.count).toBe(15);
		expect(ref(parsed.model)).toBe("opencode/minimax-m3");
		expect(parsed.focus).toBe("test a feature");
		expect(parsed.error).toBeUndefined();
	});

	test("a number word counts only when a unit noun follows", () => {
		const parsed = parseBattletestInvocation("five testers to test checkout", catalog);
		expect(parsed.count).toBe(5);
		expect(parsed.model).toBeUndefined();
		expect(parsed.focus).toBe("test checkout");
	});

	test("a connector names the model without a count", () => {
		const parsed = parseBattletestInvocation("using minimax m3 to test the settings page", catalog);
		expect(parsed.count).toBeUndefined();
		expect(ref(parsed.model)).toBe("minimax/MiniMax-M3");
		expect(parsed.focus).toBe("test the settings page");
	});

	test("the word 'model' also works as the connector", () => {
		const parsed = parseBattletestInvocation("5 using model opencode minimax-m3 to test X", catalog);
		expect(parsed.count).toBe(5);
		expect(ref(parsed.model)).toBe("opencode/minimax-m3");
		expect(parsed.focus).toBe("test X");
	});

	test("historic positional forms keep working", () => {
		expect(parseBattletestInvocation("3 checkout deep dive", catalog)).toMatchObject({
			count: 3,
			model: undefined,
			focus: "checkout deep dive",
		});
		expect(parseBattletestInvocation("7", catalog)).toMatchObject({ count: 7, focus: "" });
		expect(parseBattletestInvocation("", catalog)).toMatchObject({ count: undefined, focus: "" });
	});

	test("a count beyond the cap passes through for the caller to reject", () => {
		expect(parseBattletestInvocation("404 page flow", catalog)).toMatchObject({
			count: 404,
			focus: "page flow",
		});
	});

	test("a connector followed by a URL is a hosted target, not a model", () => {
		const parsed = parseBattletestInvocation("3 testers using https://example.dev to smoke it", catalog);
		expect(parsed.count).toBe(3);
		expect(parsed.model).toBeUndefined();
		expect(parsed.error).toBeUndefined();
		expect(parsed.focus).toBe("using https://example.dev to smoke it");
	});

	test("a bare ambiguous model name is refused with the provider options", () => {
		const parsed = parseBattletestInvocation("5 using minimax-m3 to test X", catalog);
		expect(parsed.model).toBeUndefined();
		expect(parsed.error).toContain("several providers");
		expect(parsed.error).toContain("minimax/MiniMax-M3");
		expect(parsed.error).toContain("opencode/minimax-m3");
	});

	test("an unknown model after a provider word is refused with suggestions", () => {
		const parsed = parseBattletestInvocation("5 using opencode minimax-m9 to test X", catalog);
		expect(parsed.model).toBeUndefined();
		expect(parsed.error).toContain('No model matches "opencode minimax-m9"');
		expect(parsed.error).toContain("opencode/kimi-k2.6");
		expect(parsed.error).toContain("smolt --list-models");
	});

	test("prose after a connector stays in the focus", () => {
		const parsed = parseBattletestInvocation("test the checkout flow with a maxed out cart", catalog);
		expect(parsed.count).toBeUndefined();
		expect(parsed.model).toBeUndefined();
		expect(parsed.error).toBeUndefined();
		expect(parsed.focus).toBe("test the checkout flow with a maxed out cart");
	});

	test("an empty catalog degrades to focus-only parsing", () => {
		const parsed = parseBattletestInvocation("15 subagents using opencode minimax-m3 to test a feature", []);
		expect(parsed.count).toBe(15);
		expect(parsed.model).toBeUndefined();
		expect(parsed.error).toBeUndefined();
		expect(parsed.focus).toBe("using opencode minimax-m3 to test a feature");
	});
});

describe("model phrase helpers", () => {
	test("looksLikeModelReference spots provider names and near-names, not prose", () => {
		expect(looksLikeModelReference("opencode minimax-m9", catalog)).toBe(true);
		expect(looksLikeModelReference("openai codex gpt-9.9", catalog)).toBe(true);
		expect(looksLikeModelReference("a maxed out cart", catalog)).toBe(false);
		expect(looksLikeModelReference("the settings page", catalog)).toBe(false);
	});

	test("suggestModels lists the closest catalog entries", () => {
		expect(suggestModels("opencode minimax-m9", catalog)).toEqual(["opencode/kimi-k2.6", "opencode/minimax-m3"]);
		expect(suggestModels("the settings page", catalog)).toEqual([]);
	});
});
