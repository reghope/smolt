import * as RechartsPrimitive from "recharts";
import { cn } from "../lib/cn.ts";
import { compactNumber, formatCost, formatHour, relativeTime } from "../lib/format.ts";
import { app, bump, projectName, switchToSession } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Button } from "./ui/button.tsx";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart.tsx";

/** The home screen: a greeting and the usage card, shown on an empty chat. */

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Still going";
	if (hour < 12) return "Morning";
	if (hour < 18) return "Afternoon";
	return "Evening";
}

function dayKeyOf(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Weeks shown in the activity grid, as on a contribution graph. */
const GRID_WEEKS = 53;

/**
 * A fixed year of days ending with today, starting on a Sunday so each column
 * is one week and each row one weekday. The range selector changes the figures
 * above, never the shape of this grid.
 */
function activityDays(): { key: string; count: number; inRange: boolean }[] {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const start = new Date(today);
	start.setDate(start.getDate() - ((GRID_WEEKS - 1) * 7 + today.getDay()));

	const from = new Date(today);
	if (app.statsWindow > 0) from.setDate(from.getDate() - (app.statsWindow - 1));

	const out: { key: string; count: number; inRange: boolean }[] = [];
	const cursor = new Date(start);
	while (cursor <= today) {
		const key = dayKeyOf(cursor);
		out.push({
			key,
			count: app.stats?.byDay[key] ?? 0,
			inRange: app.statsWindow === 0 || cursor >= from,
		});
		cursor.setDate(cursor.getDate() + 1);
	}
	return out;
}

/**
 * Put the token total next to something readable. Word counts are the usual
 * published figures; tokens run about a third higher than words in English.
 */
function tokenComparison(tokens: number): string {
	const books: { title: string; words: number }[] = [
		{ title: "Of Mice and Men", words: 29_160 },
		{ title: "The Great Gatsby", words: 47_094 },
		{ title: "The Hobbit", words: 95_356 },
		{ title: "Jane Eyre", words: 183_858 },
		{ title: "The Lord of the Rings", words: 481_103 },
		{ title: "War and Peace", words: 587_287 },
	];
	if (tokens < 1000) return "Barely a page so far.";
	// Prefer the largest book the total still clears, so the multiple stays small.
	for (const book of [...books].reverse()) {
		const bookTokens = book.words * 1.33;
		if (tokens >= bookTokens) {
			const times = tokens / bookTokens;
			const rounded = times >= 10 ? Math.round(times) : Math.round(times * 10) / 10;
			return `You've used ~${rounded}× more tokens than ${book.title}.`;
		}
	}
	const smallest = books[0]!;
	const share = Math.round((tokens / (smallest.words * 1.33)) * 100);
	return `That's about ${share}% of ${smallest.title}.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SERIES_COLOURS = ["var(--salmon)", "#e4907f", "#c9705f", "#a8574a", "#8c4038", "#6d312b"];

const GRID_LEVELS = [
	"bg-secondary",
	"bg-[rgba(250,128,114,0.28)]",
	"bg-[rgba(250,128,114,0.5)]",
	"bg-[rgba(250,128,114,0.72)]",
	"bg-salmon",
];

/**
 * Usage over time as a shadcn/Recharts stacked bar chart, with a legend
 * carrying the in/out split and each model's share. Buckets are chosen so a
 * long history stays readable rather than becoming one bar per day.
 */
function ModelsChart() {
	const stats = app.stats;
	if (!stats || stats.byModel.length === 0) {
		return <div className="py-2 text-sm text-faint">No replies recorded yet.</div>;
	}
	const days = activityDays();
	const bucketCount = Math.min(12, days.length);
	const perBucket = Math.ceil(days.length / bucketCount);
	const ranked = stats.byModel.slice(0, SERIES_COLOURS.length).map((row) => row.model);

	const data: Record<string, number | string>[] = [];
	for (let start = 0; start < days.length; start += perBucket) {
		const slice = days.slice(start, start + perBucket);
		const bucket: Record<string, number | string> = {};
		for (const model of ranked) bucket[model] = 0;
		for (const day of slice) {
			const perModel = stats.byDayModel[day.key] ?? {};
			for (const [model, tokens] of Object.entries(perModel)) {
				// Anything outside the top series folds into the last band.
				const series = ranked.includes(model) ? model : (ranked.at(-1) ?? model);
				bucket[series] = ((bucket[series] as number) ?? 0) + tokens;
			}
		}
		const first = slice[0]?.key ?? "";
		const [, month, day] = first.split("-");
		bucket.label = month && day ? `${MONTHS[Number(month) - 1]} ${Number(day)}` : "";
		data.push(bucket);
	}

	const config: ChartConfig = Object.fromEntries(
		ranked.map((model, index) => [model, { label: model, color: SERIES_COLOURS[index] }]),
	);

	return (
		<div className="flex h-full flex-col">
			<ChartContainer config={config} className="min-h-0 w-full flex-1 aspect-auto">
				<RechartsPrimitive.BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
					<RechartsPrimitive.CartesianGrid vertical={false} />
					<RechartsPrimitive.XAxis
						dataKey="label"
						tickLine={false}
						axisLine={false}
						tickMargin={6}
						interval={1}
					/>
					<RechartsPrimitive.YAxis
						width={44}
						tickLine={false}
						axisLine={false}
						tickFormatter={(value: number) => compactNumber(value)}
					/>
					<ChartTooltip
						cursor={{ fill: "var(--accent)", opacity: 0.4 }}
						content={<ChartTooltipContent valueFormatter={(value) => `${compactNumber(value)} tokens`} />}
					/>
					{ranked.map((model, index) => (
						<RechartsPrimitive.Bar
							key={model}
							dataKey={model}
							stackId="tokens"
							fill={SERIES_COLOURS[index]}
							radius={index === 0 ? [0, 0, 2, 2] : index === ranked.length - 1 ? [2, 2, 0, 0] : 0}
						/>
					))}
				</RechartsPrimitive.BarChart>
			</ChartContainer>
			<div className="mt-3 flex flex-col gap-1">
				{stats.byModel.slice(0, SERIES_COLOURS.length).map((row, index) => {
					const share = (row.tokens / Math.max(1, stats.tokens)) * 100;
					return (
						<div key={row.model} className="flex items-center gap-2 text-xs">
							<span className="size-2 flex-none rounded-xs" style={{ background: SERIES_COLOURS[index] }} />
							<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{row.model}</span>
							<span className="whitespace-nowrap font-mono text-faint">
								{compactNumber(row.input)} in · {compactNumber(row.output)} out
							</span>
							<span className="min-w-[42px] flex-none text-right tabular-nums text-muted-foreground">
								{share >= 10 ? Math.round(share) : share.toFixed(1)}%
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** Replies by hour of day as a clock-face radial chart. */
function RhythmChart() {
	const stats = app.stats;
	if (!stats) return null;
	const total = stats.byHour.reduce((sum, count) => sum + count, 0);
	if (total === 0) {
		return <div className="py-2 text-sm text-faint">No replies recorded yet.</div>;
	}
	const busiest = Math.max(...stats.byHour);
	const peak = stats.byHour.indexOf(busiest);
	const data = stats.byHour.map((count, hour) => ({ hour, replies: count }));
	const config: ChartConfig = { replies: { label: "Replies", color: "var(--salmon)" } };

	return (
		<div className="flex h-full flex-col">
			<ChartContainer config={config} className="mx-auto aspect-square max-h-[280px] min-h-0 w-full flex-1">
				<RechartsPrimitive.RadialBarChart
					data={data}
					innerRadius="28%"
					outerRadius="98%"
					startAngle={90}
					endAngle={90 - 360}
				>
					<RechartsPrimitive.PolarAngleAxis type="number" domain={[0, busiest]} tick={false} />
					<RechartsPrimitive.RadialBar
						dataKey="replies"
						background={{ fill: "var(--secondary)" }}
						cornerRadius={4}
						fill="var(--salmon)"
					/>
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => formatHour((payload?.[0]?.payload as { hour: number }).hour)}
								valueFormatter={(value) => `${compactNumber(value)} ${value === 1 ? "reply" : "replies"}`}
							/>
						}
					/>
				</RechartsPrimitive.RadialBarChart>
			</ChartContainer>
			<div className="mt-3 flex items-center justify-center gap-2 text-xs text-faint">
				<span className="size-2 rounded-xs" style={{ background: "var(--salmon)" }} />
				Busiest hour {formatHour(peak)} · {busiest} {busiest === 1 ? "reply" : "replies"}
			</div>
		</div>
	);
}

/** The five most recently touched chats, for picking a thread back up. */
function RecentSessions() {
	const state = useApp();
	const rows = [...state.sessionRows].sort((a, b) => b.lastActive - a.lastActive).slice(0, 5);
	if (rows.length === 0) return null;
	return (
		<div className="mt-3">
			<h2 className="mb-1.5 px-1 text-xs tracking-wide text-faint">Pick up where you left off</h2>
			<div className="flex flex-col gap-0.5">
				{rows.map((row) => (
					<button
						key={row.path}
						type="button"
						title={row.preview || row.title}
						className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60"
						onClick={() => void switchToSession(row.path)}
					>
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{row.title}</span>
						<span className="flex-none text-xs text-faint">{relativeTime(row.lastActive)}</span>
						<span className="w-16 flex-none text-right text-xs text-faint tabular-nums">{row.messageCount} msg</span>
					</button>
				))}
			</div>
		</div>
	);
}

function Tile({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-card px-2.5 py-2">
			<span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-faint">{label}</span>
			<span className="text-sm font-semibold tabular-nums">{value}</span>
		</div>
	);
}

export function HomeStats() {
	const state = useApp();
	const stats = state.stats;
	const name = projectName();
	const days = activityDays();
	const busiest = Math.max(1, ...days.map((day) => day.count));

	return (
		<div className="mx-auto mt-[12vh] max-w-[560px] px-2 @max-[550px]:mt-[6vh]">
			<h1 className="mb-5 text-balance text-center text-xl font-medium tracking-tight">
				{greeting()}
				{name ? ` — what's next in ${name}?` : " — what's next?"}
			</h1>
			{stats && stats.sessions > 0 && (
				<div className="rounded-xl border bg-background-deep p-3 [background:var(--background-deep)]">
					<div className="mb-3 flex items-center justify-between">
						<div className="flex gap-0.5">
							{(["overview", "models", "rhythm"] as const).map((tab) => (
								<Button
									key={tab}
									variant="ghost"
									size="xs"
									className={cn("capitalize", state.statsTab === tab && "bg-accent text-foreground")}
									onClick={() => {
										app.statsTab = tab;
										bump();
									}}
								>
									{tab}
								</Button>
							))}
						</div>
						<div className="flex gap-0.5">
							{[
								{ id: 0, label: "All" },
								{ id: 30, label: "30d" },
								{ id: 7, label: "7d" },
							].map((range) => (
								<Button
									key={range.id}
									variant="ghost"
									size="xs"
									className={cn(state.statsWindow === range.id && "bg-accent text-foreground")}
									onClick={() => {
										app.statsWindow = range.id;
										bump();
									}}
								>
									{range.label}
								</Button>
							))}
						</div>
					</div>
					{/* Both faces share one grid cell, so the card keeps one size:
					    switching tabs never makes the page jump. */}
					<div className="grid [grid-template-areas:'stack']">
						<div
							className={cn(
								"[grid-area:stack] min-w-0",
								state.statsTab !== "overview" && "invisible pointer-events-none",
							)}
							aria-hidden={state.statsTab !== "overview"}
						>
							<div className="grid grid-cols-5 gap-1.5 @max-[550px]:grid-cols-2">
								<Tile label="Sessions" value={String(stats.sessions)} />
								<Tile label="Messages" value={stats.messages.toLocaleString()} />
								<Tile label="Total tokens" value={compactNumber(stats.tokens)} />
								<Tile label="Spend" value={stats.cost > 0 ? formatCost(stats.cost) : "—"} />
								<Tile label="Active days" value={String(stats.activeDays)} />
								<Tile label="Current streak" value={`${stats.currentStreak}d`} />
								<Tile label="Longest streak" value={`${stats.longestStreak}d`} />
								<Tile
									label="Avg / active day"
									value={compactNumber(Math.round(stats.tokens / Math.max(1, stats.activeDays)))}
								/>
								<Tile label="Peak hour" value={stats.peakHour === null ? "—" : formatHour(stats.peakHour)} />
								<Tile
									label="Favourite model"
									value={stats.favouriteModel ? stats.favouriteModel.split("/").pop()! : "—"}
								/>
							</div>
							<div className="mt-2.5 grid w-full grid-flow-col grid-rows-[repeat(7,auto)] grid-cols-[repeat(53,minmax(0,1fr))] gap-0.5">
								{days.map((day) => {
									// Four steps is enough to read density without inventing precision.
									const level = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / busiest) * 4));
									return (
										<span
											key={day.key}
											title={`${day.key} · ${day.count} ${day.count === 1 ? "reply" : "replies"}`}
											className={cn("aspect-square min-w-0 rounded-xs", GRID_LEVELS[level], !day.inRange && "opacity-35")}
										/>
									);
								})}
							</div>
							<div className="mt-2.5 text-xs text-faint">{tokenComparison(stats.tokens)}</div>
						</div>
						<div
							className={cn(
								"[grid-area:stack] min-h-0 min-w-0",
								state.statsTab !== "models" && "invisible pointer-events-none",
							)}
							aria-hidden={state.statsTab !== "models"}
						>
							<ModelsChart />
						</div>
						<div
							className={cn(
								"[grid-area:stack] min-h-0 min-w-0",
								state.statsTab !== "rhythm" && "invisible pointer-events-none",
							)}
							aria-hidden={state.statsTab !== "rhythm"}
						>
							<RhythmChart />
						</div>
					</div>
				</div>
			)}
			<RecentSessions />
		</div>
	);
}
