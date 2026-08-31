import type { InlineExtension } from "../core/extensions/types.ts";
import autoThinkingExtension from "./auto-thinking/index.ts";
import battleTestExtension from "./battletest/index.ts";
import goalExtension from "./goal/index.ts";
import learningExtension from "./learning/index.ts";
import llamaExtension from "./llama/index.ts";
import permissionsExtension from "./permissions/index.ts";
import { poolExtension } from "./pool/index.ts";
import screenshotExtension from "./screenshot/index.ts";
import subagentsExtension from "./subagents/index.ts";
import tasteExtension from "./taste/index.ts";
import telegramExtension from "./telegram/index.ts";
import wayfinderExtension from "./wayfinder/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "learning", factory: learningExtension, hidden: true },
	{ name: "screenshot", factory: screenshotExtension, hidden: true },
	{ name: "permissions", factory: permissionsExtension, hidden: true },
	{ name: "auto-thinking", factory: autoThinkingExtension, hidden: true },
	// Goal is listed before wayfinder deliberately: both continue a settled
	// session on their own, and an active goal is the one the user asked for.
	// Going first means wayfinder sees the queued continuation and stands down.
	{ name: "goal", factory: goalExtension, hidden: true },
	{ name: "wayfinder", factory: wayfinderExtension, hidden: true },
	{ name: "taste", factory: tasteExtension, hidden: true },
	{ name: "subagents", factory: subagentsExtension, hidden: true },
	{ name: "battletest", factory: battleTestExtension, hidden: true },
	{ name: "pool", factory: poolExtension, hidden: true },
	{ name: "telegram", factory: telegramExtension, hidden: true },
];
