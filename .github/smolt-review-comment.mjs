// Status comment plumbing for the Smolt review workflow. One marker comment per
// pull request, edited in place through every stage of a review.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = "<!-- smolt-review -->";
const ICON = "https://raw.githubusercontent.com/reghope/smolt/main/packages/desktop/build/icon.png";
const BRAND = `<img src="${ICON}" width="22" align="top" alt=""> **smolt review**`;
const BODY_START = "<!-- smolt-summary:start -->";
const BODY_END = "<!-- smolt-summary:end -->";

const repo = process.env.GITHUB_REPOSITORY ?? "";
const pr = process.env.PR_NUMBER ?? "";
const runUrl = process.env.RUN_URL ?? "";
const headSha = process.env.HEAD_SHA ?? "";
const baseRef = process.env.BASE_REF ?? "";
const defaultBranch = process.env.DEFAULT_BRANCH ?? "";
const provider = process.env.SMOLT_PROVIDER ?? "";
const model = process.env.SMOLT_MODEL ?? "";

function gh(args, input) {
	return execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function short(sha) {
	return sha.slice(0, 7);
}

function quote(text) {
	return text
		.split("\n")
		.map((line) => (line === "" ? ">" : `> ${line}`))
		.join("\n");
}

function details(summary, body) {
	return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function footer() {
	return `---\n\nReviewed by smolt with ${provider || "the configured provider"}/${model || "the configured model"}.`;
}

function changedFiles() {
	const raw = gh(["pr", "diff", pr, "--repo", repo, "--name-only"]).trim();
	return raw === "" ? [] : raw.split("\n");
}

function commits() {
	const raw = gh([
		"api",
		`repos/${repo}/pulls/${pr}/commits`,
		"--paginate",
		"--jq",
		'.[] | "\\(.sha) \\(.commit.message | split("\\n")[0])"',
	]).trim();
	return raw === "" ? [] : raw.split("\n");
}

function runConfiguration() {
	const rows = [
		["Provider", provider || "unset"],
		["Model", model || "unset"],
		["Base", baseRef || "unknown"],
		["Head", headSha ? short(headSha) : "unknown"],
		["Trigger", process.env.GITHUB_EVENT_NAME ?? "unknown"],
	];
	return `| Setting | Value |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
}

// The check row on the pull request: 'Smolt review — Review completed'.
function status(state, description, commentId) {
	if (!headSha) return;
	const args = [
		"api",
		"-X",
		"POST",
		`repos/${repo}/statuses/${headSha}`,
		"-f",
		`state=${state}`,
		"-f",
		"context=Smolt review",
		"-f",
		`description=${description}`,
		"--jq",
		".state",
	];
	if (commentId) args.push("-f", `target_url=https://github.com/${repo}/pull/${pr}#issuecomment-${commentId}`);
	gh(args);
}

function findCommentId() {
	const id = gh([
		"api",
		`repos/${repo}/issues/${pr}/comments`,
		"--paginate",
		"--jq",
		`map(select(.body | startswith("${MARKER}"))) | first | .id // empty`,
	]).trim();
	return id === "" ? null : id;
}

// The marker and brand row are ours, never the caller's: strip any copy the
// body arrived with and put exactly one back, so the comment stays findable.
function withHeader(body) {
	const stripped = body
		.replace(MARKER, "")
		.replace(BRAND, "")
		.replace(/^<img src="[^"]*icon\.png"[^>]*>\s*\*\*smolt review\*\*/m, "")
		.trimStart();
	return `${MARKER}\n\n${BRAND}\n\n${stripped}\n\n${footer()}`;
}

function upsert(rawBody, state, description) {
	const body = withHeader(rawBody);
	const file = join(tmpdir(), "smolt-review-body.md");
	writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
	const existing = findCommentId();
	let id = existing;
	if (existing) {
		gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing}`, "-F", `body=@${file}`, "--jq", ".id"]);
	} else {
		id = gh(["api", `repos/${repo}/issues/${pr}/comments`, "-F", `body=@${file}`, "--jq", ".id"]).trim();
	}
	status(state, description, id);
	return `${existing ? "updated" : "created"} ${id}, status ${state}`;
}

function skippedBody() {
	const note = [
		"**Review skipped**",
		"",
		`Automatic reviews only run against the default branch. This pull request targets \`${baseRef}\`, and the default branch is \`${defaultBranch}\`.`,
		"",
		"To review this pull request anyway, comment `@smolt review`. To review every base branch, set the repository variable `SMOLT_REVIEW_ALL_BASES` to `true`.",
	].join("\n");
	return `> [!IMPORTANT]\n${quote(note)}`;
}

function processingBody() {
	const files = changedFiles();
	const log = commits();
	const note = [
		`Reviewing \`${short(headSha)}\`. This takes a few minutes; the comment is updated in place when the review finishes.`,
		"",
		details("Run configuration", runConfiguration()),
		"",
		details(`Commits (${log.length})`, log.map((line) => `- \`${short(line)}\` ${line.slice(41)}`).join("\n")),
		"",
		details(`Files selected for processing (${files.length})`, files.map((f) => `- \`${f}\``).join("\n")),
	].join("\n");
	return `> [!NOTE]\n${quote(note)}`;
}

function failedBody() {
	const note = [
		"**Review did not finish**",
		"",
		`The review of \`${short(headSha)}\` failed before it produced findings. Nothing here says the change is good or bad.`,
		"",
		"Run the review again to retry.",
	].join("\n");
	return `> [!WARNING]\n${quote(note)}`;
}

function describe(file) {
	const summary = readFileSync(file, "utf8").trim();
	const body = gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".body // \"\""]);
	const block = `${BODY_START}\n\n## Summary by smolt\n\n${summary}\n\n${BODY_END}`;
	const start = body.indexOf(BODY_START);
	const end = body.indexOf(BODY_END);
	const next = start !== -1 && end !== -1 ? `${body.slice(0, start)}${block}${body.slice(end + BODY_END.length)}` : `${body.trimEnd()}\n\n${block}`;
	const out = join(tmpdir(), "smolt-pr-body.md");
	writeFileSync(out, `${next.trim()}\n`);
	gh(["api", "-X", "PATCH", `repos/${repo}/pulls/${pr}`, "-F", `body=@${out}`, "--jq", ".number"]);
	return "pull request body updated";
}

const [command, arg] = process.argv.slice(2);
if (command === "skipped") console.log(upsert(skippedBody(), "success", "Review skipped"));
else if (command === "processing") console.log(upsert(processingBody(), "pending", "Review in progress"));
else if (command === "failed") console.log(upsert(failedBody(), "error", "Review did not finish"));
else if (command === "upsert") console.log(upsert(readFileSync(arg, "utf8"), "success", "Review completed"));
else if (command === "describe") console.log(describe(arg));
else {
	console.error("usage: smolt-review-comment.mjs skipped|processing|failed|upsert <file>|describe <file>");
	process.exit(1);
}
