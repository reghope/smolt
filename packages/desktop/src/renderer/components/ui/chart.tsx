import { createContext, useContext } from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/cn.ts";

/**
 * The shadcn chart wrapper over Recharts, less its ChartStyle component: that
 * injects a `<style>` element, which this page's CSP (style-src 'self')
 * refuses, so series colours are passed straight to the SVG marks instead.
 */

export interface ChartConfig {
	[key: string]: {
		label?: React.ReactNode;
		color?: string;
	};
}

const ChartContext = createContext<{ config: ChartConfig } | null>(null);

function useChart(): { config: ChartConfig } {
	const context = useContext(ChartContext);
	if (!context) throw new Error("useChart must be used within a <ChartContainer />");
	return context;
}

function ChartContainer({
	className,
	children,
	config,
	...props
}: React.ComponentProps<"div"> & {
	config: ChartConfig;
	children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
	return (
		<ChartContext.Provider value={{ config }}>
			<div
				data-slot="chart"
				className={cn(
					"flex aspect-video justify-center overflow-hidden text-xs [&_.recharts-cartesian-axis-tick_text]:fill-faint [&_.recharts-cartesian-grid_line]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-accent/40 [&_.recharts-layer]:outline-hidden [&_.recharts-surface]:outline-hidden",
					className,
				)}
				{...props}
			>
				<RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
			</div>
		</ChartContext.Provider>
	);
}

const ChartTooltip = RechartsPrimitive.Tooltip;

interface TooltipEntry {
	dataKey?: string | number;
	name?: string | number;
	value?: number | string;
	color?: string;
	payload?: Record<string, unknown>;
}

function ChartTooltipContent({
	active,
	payload,
	label,
	valueFormatter,
}: {
	active?: boolean;
	payload?: TooltipEntry[];
	label?: React.ReactNode;
	valueFormatter?: (value: number) => string;
}) {
	const { config } = useChart();
	if (!active || !payload || payload.length === 0) return null;
	return (
		<div className="min-w-36 rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-xl">
			{label != null && label !== "" && <div className="mb-1 font-medium">{label}</div>}
			<div className="grid gap-1">
				{payload.map((entry, index) => {
					const key = String(entry.dataKey ?? entry.name ?? index);
					const series = config[key];
					const value = typeof entry.value === "number" ? entry.value : Number(entry.value ?? 0);
					if (value === 0) return null;
					return (
						<div key={key} className="flex w-full items-center gap-1.5">
							<span
								className="size-2 shrink-0 rounded-xs"
								style={{ background: series?.color ?? entry.color ?? "currentColor" }}
							/>
							<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
								{series?.label ?? key}
							</span>
							<span className="font-mono font-medium tabular-nums">
								{valueFormatter ? valueFormatter(value) : value.toLocaleString()}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export { ChartContainer, ChartTooltip, ChartTooltipContent };
