import type { InlineExtension } from "../core/extensions/types.ts";
import autoThinkingExtension from "./auto-thinking/index.ts";
import battleTestExtension from "./battletest/index.ts";
import cuesExtension from "./cues/index.ts";
import degenerationExtension from "./degeneration/index.ts";
import goalExtension from "./goal/index.ts";
import learningExtension from "./learning/index.ts";
import semanticRecallExtension from "./learning/semantic.ts";
import llamaExtension from "./llama/index.ts";
import permissionsExtension from "./permissions/index.ts";
import { poolExtension } from "./pool/index.ts";
import researchExtension from "./research/index.ts";
import reviewExtension from "./review/index.ts";
import screenshotExtension from "./screenshot/index.ts";
import subagentsExtension from "./subagents/index.ts";
import tasteExtension from "./taste/index.ts";
import telegramExtension from "./telegram/index.ts";
import wayfinderExtension from "./wayfinder/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{
		name: "llama.cpp",
		factory: llamaExtension,
		hidden: true,
		description: "Local models through a llama.cpp server, with downloads and loading",
	},
	{
		name: "degeneration",
		factory: degenerationExtension,
		hidden: true,
		description: "Catches a looping response mid-stream and resamples it once",
	},
	// Semantic recall is listed before learning deliberately: it hands the
	// learning extension an embedder at load, and the handoff only works in
	// this order.
	{
		name: "semantic-recall",
		factory: semanticRecallExtension,
		hidden: true,
		description: "Finds past sessions by meaning with a small embedding model that runs on this machine",
	},
	{
		name: "learning",
		factory: learningExtension,
		hidden: true,
		description: "Curated memory, agent-written skills, and search over past sessions",
	},
	{
		name: "screenshot",
		factory: screenshotExtension,
		hidden: true,
		description: "Lets the agent capture and look at your screen",
	},
	{
		name: "permissions",
		factory: permissionsExtension,
		hidden: true,
		description: "Permission modes that limit what the agent may change unasked",
	},
	{
		name: "auto-thinking",
		factory: autoThinkingExtension,
		hidden: true,
		description: "Picks how much thinking each message needs, instead of one fixed level",
	},
	// Goal is listed before wayfinder deliberately: both continue a settled
	// session on their own, and an active goal is the one the user asked for.
	// Going first means wayfinder sees the queued continuation and stands down.
	{
		name: "goal",
		factory: goalExtension,
		hidden: true,
		description: "Holds one objective and keeps the session working until it is met",
	},
	{
		name: "wayfinder",
		factory: wayfinderExtension,
		hidden: true,
		description: "Maps work too big for one session into decision tickets",
	},
	{
		name: "taste",
		factory: tasteExtension,
		hidden: true,
		description: "Design doctrine that arms itself on design work, and holds the finish",
	},
	{
		name: "subagents",
		factory: subagentsExtension,
		hidden: true,
		description: "Background agent threads that keep their own context",
	},
	{
		name: "battletest",
		factory: battleTestExtension,
		hidden: true,
		description: "Simulated users run the app and file what they find as tickets",
	},
	{
		name: "research",
		factory: researchExtension,
		hidden: true,
		description: "A team of investigators works a subject and stops at nothing short of the answer",
	},
	{
		name: "review",
		factory: reviewExtension,
		hidden: true,
		description: "Reads the pending diff, or any target you name, for defects",
	},
	{
		name: "pool",
		factory: poolExtension,
		hidden: true,
		description: "Several credentials per provider, with failover when one hits a limit",
	},
	{
		name: "telegram",
		factory: telegramExtension,
		hidden: true,
		description: "Two-way bridge between this session and your own Telegram bot",
	},
	{
		name: "cues",
		factory: cuesExtension,
		hidden: true,
		description: "House notes that enter the prompt only when their subject comes up",
	},
];
