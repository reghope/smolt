import type { InlineExtension } from "../core/extensions/types.ts";
import learningExtension from "./learning/index.ts";
import llamaExtension from "./llama/index.ts";
import permissionsExtension from "./permissions/index.ts";
import screenshotExtension from "./screenshot/index.ts";
import telegramExtension from "./telegram/index.ts";
import wayfinderExtension from "./wayfinder/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "learning", factory: learningExtension, hidden: true },
	{ name: "screenshot", factory: screenshotExtension, hidden: true },
	{ name: "permissions", factory: permissionsExtension, hidden: true },
	{ name: "wayfinder", factory: wayfinderExtension, hidden: true },
	{ name: "telegram", factory: telegramExtension, hidden: true },
];
