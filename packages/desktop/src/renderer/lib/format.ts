export function formatTokens(total: number): string {
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
	if (total >= 1000) return `${(total / 1000).toFixed(1)}k tokens`;
	return `${total} tokens`;
}

/** "350.9k", "1M" — token counts sized for the context ring's labels. */
export function shortTokens(total: number): string {
	if (total >= 1_000_000) {
		const millions = total / 1_000_000;
		return `${millions % 1 === 0 ? millions : millions.toFixed(1)}M`;
	}
	if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
	return String(total);
}

export function compactNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

export function formatHour(hour: number): string {
	if (hour === 0) return "12 AM";
	if (hour === 12) return "12 PM";
	return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

export function formatCost(value: number): string {
	if (value >= 100) return `$${Math.round(value)}`;
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(3)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", "Aug 12" — for activity lists. */
export function relativeTime(ms: number): string {
	const seconds = Math.round((Date.now() - ms) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatElapsed(seconds: number): string {
	const whole = Math.floor(seconds);
	return whole >= 60 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : `${whole}s`;
}
