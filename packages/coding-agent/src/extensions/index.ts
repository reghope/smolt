import type { InlineExtension } from "../core/extensions/types.ts";
import learningExtension from "./learning/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "learning", factory: learningExtension, hidden: true },
];
