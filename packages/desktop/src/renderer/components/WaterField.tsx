import { useEffect, useRef } from "react";

/**
 * Ambient ASCII water, ported from the smolt.dev hero: two faint layers of
 * ripple characters — gray crests and sparse salmon glints — redrawn a few
 * times a second by writing straight to the DOM nodes, so the shimmer costs
 * no React renders. The loop stops while off-screen or in a hidden window,
 * and reduced motion gets a single still frame.
 */

const CELL_W = 7.2; // 12px monospace advance
const CELL_H = 16;
const FRAME_MS = 160;

/** Per-cell hash so the interference pattern doesn't tile visibly. */
function jitter(x: number, y: number): number {
	const h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
	return ((h >>> 8) % 1000) / 1000;
}

/** Two independent crest families (max, not sum, so several ride the surface
 * at once), each broken up along x by its own envelope. Every x phase uses
 * the (kx - wt) form so the whole surface travels one direction. */
function wave(x: number, y: number, t: number): number {
	const c1 = Math.sin(y * 0.8 + Math.sin(x * 0.05 - t * 0.4) * 1.6 - t * 0.15);
	const e1 = 0.72 + 0.28 * Math.sin(x * 0.045 + y * 1.7 - t * 0.5);
	const c2 = Math.sin(y * 0.45 + Math.sin(x * 0.035 - t * 0.3) * 1.3 - t * 0.1 + 2.1);
	const e2 = 0.72 + 0.28 * Math.sin(x * 0.06 - y * 0.9 - t * 0.35);
	return Math.max(c1 * e1, c2 * e2) + jitter(x, y) * 0.35;
}

function draw(cols: number, rows: number, t: number): { base: string; glint: string } {
	let base = "";
	let glint = "";
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const v = wave(x, y, t);
			base += v > 1.0 ? "~" : v > 0.9 ? "·" : v > 0.8 ? "." : " ";
			glint += v > 1.18 ? "°" : v > 1.12 ? "·" : " ";
		}
		base += "\n";
		glint += "\n";
	}
	return { base, glint };
}

const MASK = "linear-gradient(to bottom, black, rgba(0,0,0,0.5) 45%, transparent 92%)";

const preStyle: React.CSSProperties = {
	position: "absolute",
	inset: 0,
	margin: 0,
	fontFamily: "var(--font-mono, ui-monospace, monospace)",
	fontSize: "12px",
	lineHeight: "16px",
	overflow: "hidden",
	userSelect: "none",
};

export function WaterField({ className }: { className?: string }) {
	const wrap = useRef<HTMLDivElement>(null);
	const baseRef = useRef<HTMLPreElement>(null);
	const glintRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		const el = wrap.current;
		const basePre = baseRef.current;
		const glintPre = glintRef.current;
		if (!el || !basePre || !glintPre) return;

		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		let cols = 0;
		let rows = 0;
		let t = 0;
		let raf = 0;
		let last = 0;

		const paint = () => {
			const { base, glint } = draw(cols, rows, t);
			basePre.textContent = base;
			glintPre.textContent = glint;
		};

		const measure = () => {
			cols = Math.ceil(el.clientWidth / CELL_W);
			rows = Math.ceil(el.clientHeight / CELL_H);
			paint();
		};
		measure();

		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (now - last < FRAME_MS) return;
			last = now;
			t += 0.16;
			paint();
		};

		const start = () => {
			if (raf || motion.matches) return;
			last = 0;
			raf = requestAnimationFrame(tick);
		};
		const stop = () => {
			if (!raf) return;
			cancelAnimationFrame(raf);
			raf = 0;
		};
		start();

		const seen = new IntersectionObserver(([entry]) => {
			if (entry?.isIntersecting) start();
			else stop();
		});
		seen.observe(el);

		const onVisibility = () => {
			if (!document.hidden) start();
		};
		document.addEventListener("visibilitychange", onVisibility);

		const onMotionChange = () => {
			if (motion.matches) stop();
			else start();
		};
		motion.addEventListener("change", onMotionChange);

		const sized = new ResizeObserver(measure);
		sized.observe(el);

		return () => {
			stop();
			seen.disconnect();
			sized.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			motion.removeEventListener("change", onMotionChange);
		};
	}, []);

	return (
		<div
			ref={wrap}
			className={className}
			aria-hidden="true"
			style={{ pointerEvents: "none", maskImage: MASK, WebkitMaskImage: MASK }}
		>
			<pre ref={baseRef} style={{ ...preStyle, color: "var(--faint)", opacity: 0.45 }} />
			<pre ref={glintRef} style={{ ...preStyle, color: "var(--salmon-text)", opacity: 0.6 }} />
		</div>
	);
}
