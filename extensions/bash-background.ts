// ctrl+b for bash, as in Claude Code: a running foreground bash call returns to the
// model at once, the command keeps running, and its completion arrives as a message.
// Local patch (not upstream). Output goes to a log file; a footer status counts jobs.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as PiTui from "@earendil-works/pi-tui";

type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };
type Job = { id: number; command: string; log: string; started: number; abort: AbortController; done: boolean };

const HINT_AFTER_MS = 2000;
const STATUS_KEY = "cc-bash-background";

let ui: any;
let unsubKey: (() => void) | undefined;
let nextId = 1;
const foreground = new Map<string, () => void>();
const jobs = new Map<number, Job>();

function logDir(): string {
	const dir = join(tmpdir(), "pi-bash-background");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function textOf(result: Result | undefined): string {
	return (result?.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
}

function refreshStatus(): void {
	const running = [...jobs.values()].filter((j) => !j.done).length;
	try {
		ui?.setStatus?.(STATUS_KEY, running > 0 ? `⏵ ${running} background shell${running === 1 ? "" : "s"} · /bg` : undefined);
	} catch { /* no ui */ }
}

export function bindBashBackgroundUi(nextUi: any): void {
	if (nextUi === ui) return;
	unsubKey?.();
	ui = nextUi;
	unsubKey = ui?.onTerminalInput?.((data: string) => {
		if (PiTui.isKeyRelease?.(data) || foreground.size === 0 || !PiTui.matchesKey(data, "ctrl+b")) return undefined;
		const all = [...foreground.values()];
		for (const handoff of all) handoff();
		try { ui.notify(`Sent ${all.length === 1 ? "1 command" : `${all.length} commands`} to the background.`, "info"); } catch { /* */ }
		return { consume: true };
	});
	refreshStatus();
}

export function hasForegroundBash(): boolean {
	return foreground.size > 0;
}

/**
 * Runs `run` (the real bash execute) so that ctrl+b can detach it. `notify` delivers
 * the completion message to the model.
 */
export async function runDetachable(
	toolCallId: string,
	command: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	run: (signal: AbortSignal, onUpdate: (partial: any) => void) => Promise<Result>,
	notify: (text: string, job: { id: number; command: string; log: string }) => void,
): Promise<Result> {
	const abort = new AbortController();
	const forward = () => abort.abort();
	signal?.addEventListener("abort", forward, { once: true });
	let detached = false;
	let lastPartial: Result | undefined;
	let job: Job | undefined;

	const update = (partial: any) => {
		lastPartial = partial;
		if (!detached) onUpdate?.(partial);
		else if (job) { try { writeFileSync(job.log, textOf(partial)); } catch { /* */ } }
	};

	const running = run(abort.signal, update);
	let handoff!: () => void;
	const handedOff = new Promise<Result>((resolve) => {
		handoff = () => {
			if (detached) return;
			detached = true;
			signal?.removeEventListener("abort", forward);
			foreground.delete(toolCallId);
			const id = nextId++;
			job = { id, command, log: join(logDir(), `bg-${id}.log`), started: Date.now(), abort, done: false };
			jobs.set(id, job);
			try { writeFileSync(job.log, textOf(lastPartial)); } catch { /* */ }
			refreshStatus();
			resolve({
				content: [{ type: "text", text: `Command moved to the background by the user (job bg-${id}). It keeps running; live output: ${job.log}. You will get a message when it finishes — do not poll.` }],
				details: { backgroundJob: id, log: job.log },
			});
		};
	});
	foreground.set(toolCallId, handoff);
	const hint = setTimeout(() => {
		if (!detached && foreground.has(toolCallId)) {
			try { ui?.setStatus?.(`${STATUS_KEY}-hint`, "ctrl+b to run in background"); } catch { /* */ }
		}
	}, HINT_AFTER_MS);

	const settled = running.then(
		(r) => ({ ok: true as const, r }),
		(e) => ({ ok: false as const, e }),
	);
	settled.then((s) => {
		clearTimeout(hint);
		foreground.delete(toolCallId);
		if (foreground.size === 0) { try { ui?.setStatus?.(`${STATUS_KEY}-hint`, undefined); } catch { /* */ } }
		if (!detached || !job) return;
		job.done = true;
		const out = s.ok ? textOf(s.r) : String((s.e as any)?.message ?? s.e);
		try { writeFileSync(job.log, out); } catch { /* */ }
		refreshStatus();
		const secs = Math.round((Date.now() - job.started) / 1000);
		const tail = out.split("\n").slice(-40).join("\n");
		const state = abort.signal.aborted ? "was stopped" : s.ok ? "finished" : "failed";
		notify(`Background command bg-${job.id} ${state} after ${secs}s: \`${command}\`\nFull output: ${job.log}\n\n${tail}`, job);
	});

	const winner = await Promise.race([settled.then((s) => ({ kind: "done" as const, s })), handedOff.then((r) => ({ kind: "bg" as const, r }))]);
	if (winner.kind === "bg") return winner.r;
	signal?.removeEventListener("abort", forward);
	if (!winner.s.ok) throw winner.s.e;
	return winner.s.r;
}

export function listJobs(): string {
	if (jobs.size === 0) return "No background shell commands.";
	return [...jobs.values()]
		.map((j) => `bg-${j.id} ${j.done ? "done" : "running"} ${Math.round((Date.now() - j.started) / 1000)}s  ${j.command.slice(0, 80)}\n      ${j.log}`)
		.join("\n");
}

export function killJob(id: number): boolean {
	const job = jobs.get(id);
	if (!job || job.done) return false;
	job.abort.abort();
	return true;
}
