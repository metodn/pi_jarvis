/**
 * pi-jarvis: talk to pi, and let it talk back.
 *
 * Everything runs on one local llama-swap server and its LFM audio model:
 *   ears   hold Space, speak, release. Your words are typed into the prompt while you talk and, when
 *          you let go, sent to pi (if they are a real sentence). Say "stop" to abort the running task,
 *          "repeat" to hear the last report again.
 *   voice  when pi finishes, Jarvis speaks a short report. pi's own model writes it: Jarvis asks the agent
 *          to end its final reply with one `VOICE: ...` sentence, and the audio model reads that aloud.
 *          Without such a line he falls back to the start of the reply plus what was done (files changed,
 *          commands run, failures). Esc, or holding Space to talk, cuts him off.
 *
 *   /jarvis          switch Jarvis on or off (off at the start of every session)
 *   /jarvis mute     stop / resume the speaking (the listening stays)
 *   /jarvis say ...  speak the given words
 *   /jarvis servers | use <name> | add <name> <host[:port]> [model] [key=<token>] | key <name> [token] | remove <name>
 *                    several servers, each with an optional API key (sent as a Bearer token)
 *   /jarvis submit   toggle sending spoken prompts automatically
 *   /jarvis release <send|type|compose>   what happens when you let go of Space (see README)
 *   /jarvis compose  toggle compose mode: dictation only builds the prompt, say "send" to send it
 *   /jarvis info     (any other argument) show state and server, changes nothing
 *
 * Config (optional) ~/.pi/agent/pi-jarvis.json:
 *   { "url": "http://localhost:8181", "model": "lfm3-audio-2b", "speak": true, "autoSubmit": true, "minWords": 3 }
 *
 * Hands-free: Ctrl+R starts recording, Ctrl+R or Enter ends it, Esc cancels.
 * Listening: parecord, arecord or sox (src/recorder.ts). Speaking: paplay/aplay (Linux) or sox `play` (macOS:
 * brew install sox, and allow the terminal to use the microphone). Try without installing:
 *   pi --no-extensions -e ./extensions/pi-jarvis.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { isSilent, onPath, pickRecorder, startCapture } from "../src/recorder.ts";

type Server = { name: string; url: string; model: string; apiKey?: string };
// `url`/`model`/`apiKey` always mirror the active server (kept so old config files keep working).
type Config = { url: string; model: string; apiKey?: string; speak: boolean; autoSubmit: boolean; minWords: number; servers?: Server[]; active?: string };

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-jarvis.json");
const DEFAULTS: Config = { url: "http://localhost:8181", model: "lfm3-audio-2b", speak: true, autoSubmit: true, minWords: 3 };

const REPEAT_MS = 120; // spaces closer than this are a held key, not typing
const RELEASE_MS = 150; // no space for this long = released
const STEP_BYTES = 32000; // re-decode after this much new audio (1 s of 16 kHz s16le)
const MIN_BYTES = 9600; // 0.3 s
const SEGMENT_BYTES = 32000 * 40; // commit the text so far every 40 s
const MAX_RECORD_BYTES = 32000 * 300; // a hold longer than 5 minutes ends by itself
const SPEAK_TIMEOUT_MS = 30_000; // give up on a speech request that never finishes
const STATUS = "pi-jarvis";
const VERSION = "0.2.1"; // keep in step with package.json

/** Which copy is installed: the version, a short hash of this very file, and when that file was written. */
function buildInfo(): string {
	try {
		const f = fileURLToPath(import.meta.url);
		const hash = createHash("sha1").update(readFileSync(f)).digest("hex").slice(0, 7);
		return `${VERSION} (build ${hash}, file dated ${statSync(f).mtime.toISOString().slice(0, 16).replace("T", " ")})`;
	} catch {
		return VERSION;
	}
}
const TOGGLE_KEY = "ctrl+r"; // hands-free recording on/off (unused by pi's editor)

function loadConfig(): Config {
	try {
		const c = { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>) };
		const act = c.servers?.find((s) => s.name === c.active);
		if (act) {
			c.url = act.url;
			c.model = act.model;
			c.apiKey = act.apiKey;
		}
		return { ...c, url: String(c.url).replace(/\/+$/, "") };
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(c: Config): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); // may hold API keys
	try {
		chmodSync(CONFIG_PATH, 0o600); // also for a file created earlier with looser rights
	} catch {}
}

/** Request headers for a server; adds the bearer token when it has an apiKey. */
const authHeaders = (s: { apiKey?: string }): Record<string, string> => (s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {});

/** "ready" / "up" / "needs an API key" / ... for one server, from its model list. */
async function serverState(s: { url: string; model: string; apiKey?: string }, checkModel: boolean): Promise<string> {
	return fetch(`${s.url}/v1/models`, { headers: authHeaders(s), signal: AbortSignal.timeout(2500) }).then(
		async (r) => {
			if (r.status === 401 || r.status === 403) return s.apiKey ? "API key rejected" : "needs an API key";
			if (!r.ok) return "no models API";
			if (!checkModel) return "up";
			return ((await r.json().catch(() => ({}))) as { data?: { id: string }[] }).data?.some((m) => m.id === s.model) ? "ready" : "model not listed";
		},
		() => "down",
	);
}

// ------------------------------------------------------------------ listening: audio + decode

/**
 * Drop everything before the speech starts (the model invents words from room noise and clicks).
 * Speech = two loud 100 ms windows in a row, "loud" being well above the noise floor; half a second of
 * lead-in is kept. Returns empty if there is none.
 */
function trimSilence(pcm: Buffer): Buffer {
	const win = 3200; // 100 ms
	const rms: number[] = [];
	for (let i = 0; i + win <= pcm.length; i += win) {
		let sum = 0;
		for (let j = i; j < i + win; j += 2) {
			const v = pcm.readInt16LE(j);
			sum += v * v;
		}
		rms.push(Math.sqrt(sum / (win / 2)));
	}
	const sorted = [...rms].sort((a, b) => a - b);
	const noise = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
	const threshold = Math.max(80, 3 * noise, 0.05 * Math.max(0, ...rms));
	for (let k = 0; k + 1 < rms.length; k++) {
		if (rms[k] > threshold && rms[k + 1] > threshold) return pcm.subarray(Math.max(0, (k - 5) * win));
	}
	return Buffer.alloc(0);
}

function wav(pcm: Buffer): Buffer {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcm.length, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20); // PCM
	h.writeUInt16LE(1, 22); // mono
	h.writeUInt32LE(16000, 24);
	h.writeUInt32LE(32000, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([h, pcm]);
}

async function decodeAudio(cfg: Config, pcm: Buffer): Promise<string> {
	const res = await fetch(`${cfg.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
		signal: AbortSignal.timeout(60_000),
		body: JSON.stringify({
			model: cfg.model,
			temperature: 0,
			max_tokens: 1024,
			messages: [
				{ role: "system", content: "Perform ASR." },
				{ role: "user", content: [{ type: "input_audio", input_audio: { data: wav(pcm).toString("base64"), format: "wav" } }] },
			],
		}),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${cfg.url}`);
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return (json.choices?.[0]?.message?.content ?? "").replace(/<_*media_*>/g, "").trim();
}

// ------------------------------------------------------------------ speaking: what Jarvis says

// The audio model only READS what it is given: a persona makes it improvise, and as a summariser it rambles
// (tested), so the summary is written by pi's own model (see AGENT_NOTE) and spoken word for word.
const INSTR_VERBATIM =
	"Respond with interleaved text and audio. You are a text to speech reader. Repeat the user's message back " +
	"word for word. Never add, remove or change a word.";

/** Added to pi's system prompt while Jarvis speaks, so the agent writes its own spoken summary. */
const AGENT_NOTE =
	"\n\nThe user is listening through a speaker. When you finish and your reply has no more tool calls, end it with " +
	"one last line of the form `VOICE: <one or two short plain sentences telling a listener the outcome, or the " +
	"question you need answered; no code, no file names, no markdown>`.";

/** Plain, speakable text from an assistant message: no code, links, paths or markdown. */
function speakable(text: string, max: number): string {
	return text
		.replace(/```[\s\S]*?```/g, " (code omitted) ")
		.replace(/`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " a link ")
		.replace(/(?:[\w.~-]+\/)+[\w.-]+/g, " a file ")
		.replace(/\b[\w-]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml|toml|rs|go|sh|css|html|txt)\b/g, " a file ")
		.replace(/[#*_>|~]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function textOf(message: unknown): string {
	const c = (message as { content?: unknown }).content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? ((p as { text?: string }).text ?? "") : "")).join("\n");
}

// ------------------------------------------------------------------ the extension

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let unsubscribe: (() => void) | undefined;
	let enabled = false; // set by /jarvis; Space is left completely alone while off

	// The editor instance, so the transcript can go in at the caret.
	let editor: CustomEditor | undefined;
	let requestRender: (() => void) | undefined;
	class JarvisEditor extends CustomEditor {
		constructor(...args: ConstructorParameters<typeof CustomEditor>) {
			super(...args);
			editor = this;
			requestRender = () => args[0].requestRender();
		}
	}

	// ---- speaking state
	const isMac = process.platform === "darwin";
	const player = isMac ? "play" : spawnSync("which", ["paplay"], { stdio: "ignore" }).status === 0 ? "paplay" : "aplay";
	let playerProc: ChildProcess | undefined;
	let speakSocket: WebSocket | undefined;
	let speakGen = 0; // bumped on every stop/new utterance so stale callbacks do nothing
	let isTalking = false;
	let lastSpoken = "";

	// ---- what pi did during the current run (for the spoken report)
	const run = { request: "", reply: "", voice: "", failed: false, edited: new Set<string>(), commands: 0, reads: 0, failures: 0, startedAt: 0 };

	// ---- recording state
	let rec: ChildProcess | undefined;
	let recDone: Promise<void> = Promise.resolve(); // resolves when the recorder process is gone (attached at spawn)
	let stopping = false; // a stop is still transcribing: ignore new holds
	let ignoring = false; // swallowing a hold that began while stopping
	let pcm: Buffer[] = [];
	let pcmStart = 0; // absolute byte offset of pcm[0] (old audio is dropped once its text is committed)
	let bytes = 0; // absolute bytes recorded
	let segStart = 0; // absolute offset where the current segment begins
	const committed: string[] = [];
	let segText = "";
	let decodedBytes = 0;
	let decoding = false;
	let discarded = false;
	let decodeFailed = false; // the last live decode failed: stopRecording must decode once more or the tail of the speech is lost
	let ticker: ReturnType<typeof setInterval> | undefined;

	// ---- hold detection state
	let spaceRun = 0;
	let lastSpaceAt = 0;
	let isHeld = false;
	let latched = false; // hands-free recording: started with Ctrl+R, ended with Ctrl+R or Enter
	let releaseTimer: ReturnType<typeof setInterval> | undefined;

	// ---- release behaviour
	let compose = false; // session only: dictation builds the prompt, only the voice command "send" sends it
	let voiceSent = ""; // the last voice prompt, put back into the editor if Esc aborts the run

	const transcript = () => [...committed, segText].filter(Boolean).join(" ");

	/** Footer line: one glyph per state. */
	function indicator(ctx: ExtensionContext, state: "rec" | "wait" | "talk" | "idle"): void {
		const t = ctx.ui.theme;
		if (!enabled) ctx.ui.setStatus(STATUS, undefined);
		else if (state === "rec") ctx.ui.setStatus(STATUS, t.fg("error", "● REC") + t.fg("dim", latched ? " Ctrl+R or Enter to finish, Esc cancels" : " release Space, Esc cancels"));
		else if (state === "wait") ctx.ui.setStatus(STATUS, t.fg("warning", "◌ transcribing…"));
		else if (state === "talk") ctx.ui.setStatus(STATUS, t.fg("accent", "♪ Jarvis") + t.fg("dim", " Esc, or hold Space, to interrupt"));
		else ctx.ui.setStatus(STATUS, t.fg("dim", (compose ? "jarvis: composing, say send" : "jarvis: listening") + (cfg.speak ? "" : " (muted)")));
	}

	// ================================================================== voice

	function stopSpeaking(ctx?: ExtensionContext): void {
		speakGen++;
		try {
			speakSocket?.close();
		} catch {}
		speakSocket = undefined;
		if (playerProc) {
			if (isMac && playerProc.pid) spawnSync("pkill", ["-TERM", "-P", String(playerProc.pid)]); // cat and play under the sh
			playerProc.kill("SIGTERM");
		}
		playerProc = undefined;
		if (isTalking) {
			isTalking = false;
			if (ctx) indicator(ctx, "idle");
		}
	}

	/**
	 * Speak through llama-swap's realtime route: text in, speech out, streamed to the speakers as it arrives.
	 */
	function speak(ctx: ExtensionContext, input: string, retry = true): void {
		stopSpeaking();
		const gen = ++speakGen;
		const url = `${cfg.url.replace(/^http/, "ws")}/v1/realtime?model=${encodeURIComponent(cfg.model)}`;
		let ws: WebSocket;
		try {
			ws = new (WebSocket as unknown as new (u: string, o?: object) => WebSocket)(url, { headers: authHeaders(cfg) });
		} catch (e) {
			ctx.ui.notify(`jarvis: cannot speak (${(e as Error).message})`, "error");
			return;
		}
		speakSocket = ws;
		let spoken = "";
		let retrying = false;
		const watchdog = setTimeout(() => finish(), SPEAK_TIMEOUT_MS);
		const finish = () => {
			clearTimeout(watchdog);
			if (gen !== speakGen) return;
			try {
				ws.close();
			} catch {}
			if (playerProc) playerProc.stdin?.end(); // the 'close' handler resets the state once playback has drained
			else {
				isTalking = false; // nothing was ever played
				indicator(ctx, "idle");
			}
		};
		ws.onopen = () => {
			ws.send(JSON.stringify({ type: "session.update", session: { output_modalities: ["text", "audio"], instructions: INSTR_VERBATIM } }));
			ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: input }] } }));
			ws.send(JSON.stringify({ type: "response.create" }));
		};
		ws.onmessage = (m: MessageEvent) => {
			if (gen !== speakGen) return;
			let ev: { type?: string; delta?: string; transcript?: string; text?: string; error?: { message?: string } };
			try {
				ev = JSON.parse(String(m.data));
			} catch {
				return;
			}
			const t = ev.type ?? "";
			if (t.endsWith("audio.delta") && ev.delta) {
				if (!playerProc) {
					if (isMac && !onPath("play")) {
						ctx.ui.notify("jarvis: cannot play audio, brew install sox", "error"); // sh would start fine and exit 127 silently
						finish();
						return;
					}
					if (isMac) {
						// sox stops at the first pause of a Node pipe (it sees end-of-input); behind `cat` it plays on.
						playerProc = spawn("sh", ["-c", "cat | play -q -t raw -r 24000 -e signed-integer -b 16 -c 1 -"], { stdio: ["pipe", "ignore", "ignore"] });
					} else {
						const args = player === "paplay" ? ["--raw", "--rate=24000", "--format=s16le", "--channels=1"] : ["-q", "-t", "raw", "-r", "24000", "-f", "S16_LE", "-c", "1"];
						playerProc = spawn(player, args, { stdio: ["pipe", "ignore", "ignore"] });
					}
					playerProc.on("error", (e) => ctx.ui.notify(`jarvis: cannot play audio (${e.message})${isMac ? ". brew install sox" : ""}`, "error"));
					const p = playerProc;
					p.on("close", () => {
						if (playerProc === p) playerProc = undefined; // so a later stop never signals a reused pid
						if (gen === speakGen) {
							isTalking = false;
							indicator(ctx, "idle");
						}
					});
					playerProc.stdin?.on("error", () => {});
					isTalking = true;
					indicator(ctx, "talk");
				}
				playerProc.stdin?.write(Buffer.from(ev.delta, "base64"));
			} else if (t.endsWith("output_text.done") || t.endsWith("audio_transcript.done")) {
				spoken = ev.transcript || ev.text || spoken;
				if (spoken) lastSpoken = spoken;
			} else if (t === "error") {
				ctx.ui.notify(`jarvis: ${ev.error?.message ?? "speech error"}`, "error");
				finish();
			} else if (t === "response.done") finish();
		};
		ws.onerror = () => {
			if (gen === speakGen && !playerProc && retry) {
				// llama-swap is probably still loading the model: try once more before giving up
				clearTimeout(watchdog);
				retrying = true;
				setTimeout(() => {
					if (gen === speakGen) speak(ctx, input, false);
				}, 800);
				return;
			}
			if (gen === speakGen) ctx.ui.notify(`jarvis: cannot reach ${cfg.url} to speak`, "error");
			finish();
		};
		ws.onclose = () => {
			if (retrying) return; // onerror is retrying
			finish(); // the server hung up before response.done
		};
	}

	/** What Jarvis says when pi settles: the agent's own VOICE line, else the start of its reply plus the facts. */
	function spokenSummary(aborted: boolean): string {
		if (aborted) return "Stopped.";
		if (run.failed && !run.voice) return "That request failed. Check the screen.";
		if (run.voice) return run.voice;
		const first = speakable(run.reply, 500).split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 220);
		const did: string[] = [];
		if (run.edited.size) did.push(`changed ${run.edited.size} file${run.edited.size === 1 ? "" : "s"}`);
		if (run.commands) did.push(`ran ${run.commands} command${run.commands === 1 ? "" : "s"}`);
		return [first || "Done.", did.length ? `I ${did.join(" and ")}.` : "", run.failures ? `${run.failures} step${run.failures === 1 ? "" : "s"} failed.` : ""].filter(Boolean).join(" ");
	}

	// ================================================================== ears

	let live: { pre: string; post: string; shown: string; expect: string; abandoned: boolean } | undefined;

	function beginLive(): void {
		if (!editor) return;
		const { line, col } = editor.getCursor();
		const cur = editor.getLines()[line] ?? "";
		const b = cur[col - 1];
		const a = cur[col];
		live = { pre: b && !/\s/.test(b) ? " " : "", post: a && !/\s/.test(a) ? " " : "", shown: "", expect: editor.getText(), abandoned: false };
	}

	const keys = (k: string, n: number) => {
		for (let i = 0; i < n; i++) editor?.handleInput(k);
	};

	/** Make the typed words equal `words`, retyping only the part that changed. */
	function setLive(words: string): void {
		const l = live;
		if (!editor || !l || l.abandoned) return;
		if (editor.getText() !== l.expect) {
			l.abandoned = true; // the person edited the prompt meanwhile: hands off
			return;
		}
		const next = words ? l.pre + words : "";
		if (next !== l.shown) {
			if (!l.shown && next) {
				editor.insertTextAtCursor(next + l.post);
				keys("\x1b[D", l.post.length);
			} else if (l.shown && !next) {
				keys("\x7f", l.shown.length);
				keys("\x1b[3~", l.post.length);
			} else {
				let k = 0;
				while (k < l.shown.length && k < next.length && l.shown[k] === next[k]) k++;
				keys("\x7f", l.shown.length - k);
				if (next.length > k) editor.insertTextAtCursor(next.slice(k));
			}
			l.shown = next;
			l.expect = editor.getText();
			requestRender?.();
		}
	}

	async function refine(ctx: ExtensionContext): Promise<void> {
		const nChunks = pcm.length; // chunks that arrive during the awaited decode must survive a commit
		const all = Buffer.concat(pcm); // starts at absolute offset pcmStart
		const end = pcmStart + all.length;
		decodedBytes = end;
		const voiced = trimSilence(all.subarray(segStart - pcmStart));
		if (voiced.length < MIN_BYTES) {
			segText = "";
			return;
		}
		segText = await decodeAudio(cfg, voiced);
		decodeFailed = false;
		if (!discarded) setLive(transcript());
		if (end - segStart > SEGMENT_BYTES) {
			if (segText) committed.push(segText);
			segText = "";
			segStart = end;
			pcm = pcm.slice(nChunks); // the committed audio is no longer needed
			pcmStart = end;
		}
	}

	function insertAtCaret(ctx: ExtensionContext, text: string): void {
		if (!editor) {
			ctx.ui.pasteToEditor(text);
			return;
		}
		const { line, col } = editor.getCursor();
		const cur = editor.getLines()[line] ?? "";
		const before = cur[col - 1];
		const after = cur[col];
		editor.insertTextAtCursor((before && !/\s/.test(before) ? " " : "") + text + (after && !/\s/.test(after) ? " " : ""));
		requestRender?.();
	}

	function startRecording(ctx: ExtensionContext): boolean {
		if (rec) return false; // one recorder at a time
		stopSpeaking(ctx); // barge-in: talking over Jarvis silences it
		pcm = [];
		pcmStart = 0;
		bytes = 0;
		segStart = 0;
		committed.length = 0;
		segText = "";
		decodedBytes = 0;
		discarded = false;
		decodeFailed = false;
		beginLive();
		const picked = pickRecorder();
		if ("error" in picked) {
			ctx.ui.notify(`jarvis: ${picked.error}`, "error");
			live = undefined;
			return false;
		}
		rec = startCapture(picked.backend);
		rec.stdout?.on("data", (d: Buffer) => {
			pcm.push(d);
			bytes += d.length;
		});
		const proc = rec;
		recDone = new Promise<void>((resolve) => {
			proc.once("close", (code) => {
				if (rec === proc) ctx.ui.notify(`jarvis: the recording tool stopped by itself (exit ${code}). Is a sound server running?`, "error");
				resolve();
			});
			proc.once("error", (e) => {
				ctx.ui.notify(`jarvis: cannot record with ${picked.backend.cmd} (${e.message})`, "error");
				resolve();
			});
		});
		indicator(ctx, "rec");
		ticker = setInterval(() => {
			if (bytes > MAX_RECORD_BYTES && (isHeld || latched)) {
				isHeld = false; // too long: finish as if Space had been released
				latched = false;
				if (releaseTimer) clearInterval(releaseTimer);
				ctx.ui.notify("jarvis: that was five minutes, I stopped listening", "info");
				void stopRecording(ctx, false);
				return;
			}
			if (decoding || bytes - decodedBytes < STEP_BYTES) return;
			decoding = true;
			refine(ctx)
				.catch((e) => {
					decodeFailed = true;
					ctx.ui.notify(`jarvis: ${e.message}`, "error");
				})
				.finally(() => (decoding = false));
		}, 200);
		return true;
	}

	/** Spoken commands that act instead of becoming a prompt. */
	function voiceCommand(text: string): "stop" | "repeat" | "send" | "compose" | "direct" | undefined {
		const n = text
			.toLowerCase()
			.replace(/[^a-z\s']/g, " ")
			.replace(/\b(jarvis|please|ok|okay|hey|could you|can you|would you)\b/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (/^(stop|abort|stop that|stop it|stop everything|stop talking|that is enough)$/.test(n)) return "stop";
		if (/^(repeat|repeat that|repeat it|say that again|say it again|what did you say|come again)$/.test(n)) return "repeat";
		if (/^(send|sand|sent|cent|send it|sand it|send the prompt|submit|submit it|submit the prompt)$/.test(n)) return "send";
		if (/^(compose|compose mode|prompt input|prompt editing|prompt edit|edit mode)$/.test(n)) return "compose";
		if (/^(direct mode|direct|auto send|auto submit|send mode)$/.test(n)) return "direct";
		return undefined;
	}

	/** Every voice prompt goes through here: remembered so Esc can give the words back, and added to Up-arrow history. */
	function sendVoicePrompt(ctx: ExtensionContext, text: string): void {
		voiceSent = text;
		(editor as { addToHistory?: (t: string) => void } | undefined)?.addToHistory?.(text);
		pi.sendUserMessage(text, ctx.isIdle() ? { expandPromptTemplates: true } : { deliverAs: "steer", expandPromptTemplates: true });
	}

	const releaseMode = () => (compose ? "compose (say send)" : cfg.autoSubmit ? `send (from ${cfg.minWords} words)` : "type only");

	function setCompose(ctx: ExtensionContext, on: boolean): void {
		compose = on;
		indicator(ctx, isTalking ? "talk" : "idle");
		ctx.ui.notify(on ? 'jarvis: compose mode. Dictation only fills the prompt; say "send" to send it.' : "jarvis: direct mode. Dictation follows the release setting again.", "info");
	}

	const VOICE_HELP =
		'jarvis: say stop, repeat, compose, direct mode, send. Also: "jarvis mute", "jarvis unmute", "be quiet", "speak again", "type only", "send automatically", "use <server>", "jarvis status", "jarvis version", "what can I say".';

	/** Voice twins of the /jarvis settings: the whole utterance must match, then the same handler runs. Jarvis answers aloud. */
	const VOICE_CONTROLS: [RegExp, string, () => string][] = [
		[/^(jarvis )?(mute|be quiet)$/, "mute on", () => "Muted."],
		[/^(jarvis )?(unmute|speak again)$/, "mute off", () => "Speaking again."],
		[/^(jarvis )?type only$/, "release type", () => "Typing only."],
		[/^(jarvis )?send automatically$/, "release send", () => "Sending on release."],
	];

	/** True when the utterance was a Jarvis setting (already carried out and answered), false for anything else. */
	async function voiceControl(ctx: ExtensionContext, text: string): Promise<boolean> {
		const n = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
		const say = (t: string) => speak(ctx, t); // answers ignore the mute setting: a command must be confirmed
		const hit = VOICE_CONTROLS.find(([re]) => re.test(n));
		if (hit) {
			await control(hit[1], ctx);
			say(hit[2]());
			return true;
		}
		if (/^(jarvis status|jarvis info)$/.test(n)) {
			const st = await serverState(cfg, true);
			say(`Voice ${cfg.speak ? "on" : "muted"}. On release: ${releaseMode()}. Server ${cfg.active ?? "default"}, ${st}.`);
			return true;
		}
		if (/^(jarvis version|what version)$/.test(n)) {
			const v = buildInfo();
			ctx.ui.notify(`jarvis ${v}`, "info");
			say(`Jarvis version ${v.split(" ")[0]}, build ${v.match(/build (\w+)/)?.[1] ?? "unknown"}.`);
			return true;
		}
		if (/^(jarvis help|what can i say)$/.test(n)) {
			ctx.ui.notify(VOICE_HELP, "info");
			say("The commands are on the screen.");
			return true;
		}
		const m = /^(jarvis )?(use|switch to) (.+)$/.exec(n);
		if (m) {
			const key = m[3].replace(/ server$/, "").replace(/\s/g, "");
			const s = cfg.servers?.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
			if (!s) {
				if (!m[1]) return false; // "use the bash tool" is a prompt, not a command
				say(`There is no server called ${m[3]}.`);
				return true;
			}
			if (s.name === cfg.active) say(`Already using ${s.name}.`);
			else {
				const st = await serverState(s, true); // never strand the microphone on a server that cannot hear us
				if (st !== "ready") say(`${s.name} is not ready, ${st}. Staying on ${cfg.active}.`);
				else await control(`use ${s.name}`, ctx);
			}
			return true;
		}
		return false;
	}

	async function stopRecording(ctx: ExtensionContext, discard: boolean): Promise<void> {
		const proc = rec;
		if (!proc) return;
		rec = undefined;
		stopping = true;
		if (ticker) clearInterval(ticker);
		discarded = discard;
		proc.kill("SIGTERM");
		await recDone;
		if (discard) {
			while (decoding) await new Promise((r) => setTimeout(r, 50));
			setLive("");
			indicator(ctx, "idle");
			live = undefined;
			stopping = false;
			return;
		}
		indicator(ctx, "wait");
		try {
			while (decoding) await new Promise((r) => setTimeout(r, 50));
			if (bytes - decodedBytes > 4800 || !transcript() || decodeFailed) await refine(ctx);
			const final = transcript();
			if (!final) {
				setLive("");
				ctx.ui.notify(bytes === 0 ? "jarvis: the recording tool delivered no audio" : isSilent(Buffer.concat(pcm)) ? "jarvis: the microphone delivered only silence. Check the microphone permission of this terminal." : "jarvis: I did not hear anything", "info");
				return;
			}
			if (await voiceControl(ctx, final)) {
				setLive("");
				return;
			}
			const cmd = voiceCommand(final);
			if (cmd) {
				setLive(""); // a command, not text for the prompt
				if (cmd === "send") {
					const text = (ctx.ui.getEditorText?.() ?? editor?.getText() ?? "").trim();
					if (!text) ctx.ui.notify("jarvis: the prompt is empty, nothing to send", "info");
					else {
						ctx.ui.setEditorText("");
						sendVoicePrompt(ctx, text);
					}
				} else if (cmd === "compose" || cmd === "direct") setCompose(ctx, cmd === "compose");
				else if (cmd === "stop") {
					// Aborting makes pi settle, and the settle report says "Stopped." — so only speak when idle.
					if (ctx.isIdle()) {
						if (cfg.speak) speak(ctx, "Nothing is running.");
					} else {
							voiceSent = ""; // a stop is not a mistake to take back
							ctx.abort();
						}
				} else if (lastSpoken) speak(ctx, lastSpoken); // an explicit request to hear it again, so mute does not apply
				else if (cfg.speak) speak(ctx, "I have not said anything yet.");
				return;
			}
			const enough = final.split(/\s+/).length >= cfg.minWords;
			if (!live && !compose && cfg.autoSubmit && enough) {
				sendVoicePrompt(ctx, final); // another extension owns the editor: nothing to type into, send directly
				return;
			}
			let placed = false; // the prompt holds exactly what was dictated, untouched by the user
			if (live && !live.abandoned) {
				setLive(final);
				if (!live.abandoned) {
					keys("\x1b[C", live.post.length);
					placed = true;
				}
			}
			if (live?.abandoned) {
				// The person edited the prompt while dictating. Our partial words are still in it, so do not
				// add the whole transcript again; hand it over in a message instead.
				if (live.shown) ctx.ui.notify(`jarvis: you changed the prompt, so I left it. I heard: "${final}"`, "info");
				else insertAtCaret(ctx, final);
			} else if (!live) {
				insertAtCaret(ctx, final); // no editor access (another extension owns it): plain insert, no auto-send
			}
			if (placed && !compose && cfg.autoSubmit && enough) {
				const text = (ctx.ui.getEditorText?.() ?? editor?.getText() ?? "").trim();
				if (text) {
					ctx.ui.setEditorText("");
					sendVoicePrompt(ctx, text);
				}
			}
		} catch (e) {
			setLive("");
			ctx.ui.notify(`jarvis: ${(e as Error).message}`, "error");
		} finally {
			live = undefined;
			stopping = false;
			indicator(ctx, isTalking ? "talk" : "idle");
		}
	}

	// ================================================================== keyboard

	function onInput(ctx: ExtensionContext) {
		return (data: string): { consume?: boolean } | undefined => {
			if (!enabled) return undefined;
			// Another extension replaced the prompt editor after us: ours is detached, so paste instead of typing live.
			if (editor && !(ctx.ui.getEditorComponent() as { isJarvis?: boolean } | undefined)?.isJarvis) editor = undefined;
			if (editor && !editor.focused) return undefined; // a dialog or overlay has the keyboard
			if (isTalking && (data === "\x1b" || data === "\x03")) {
				stopSpeaking(ctx); // Esc silences Jarvis
				return { consume: true };
			}
			if (!isHeld && matchesKey(data, TOGGLE_KEY)) {
				if (latched) {
					latched = false;
					void stopRecording(ctx, false);
				} else if (stopping) ctx.ui.notify("jarvis: still transcribing, try again in a moment", "info");
				else if (!rec) {
					latched = true; // before starting, so the status line shows the right hint
					latched = startRecording(ctx);
				}
				return { consume: true };
			}
			if (latched && matchesKey(data, "enter")) {
				latched = false;
				void stopRecording(ctx, false);
				return { consume: true };
			}
			if ((isHeld || latched) && (data === "\x1b" || data === "\x03")) {
				isHeld = false;
				latched = false;
				ignoring = false;
				if (releaseTimer) clearInterval(releaseTimer);
				void stopRecording(ctx, true);
				return { consume: true };
			}
			if (latched) return undefined; // spaces are ordinary typing during a hands-free recording
			const isSpace = data === " " || /^ {2,}$/.test(data) || data === "\x1b[32u";
			if (!isSpace) {
				spaceRun = 0;
				return undefined;
			}
			const now = performance.now();
			const gap = now - lastSpaceAt;
			lastSpaceAt = now;
			if (isHeld) return { consume: true };

			const burst = data.length >= 3;
			if (!burst && !(spaceRun >= 2 && gap < REPEAT_MS)) {
				spaceRun += data.length;
				return undefined; // an ordinary space: let the editor type it
			}
			for (let i = 0; i < spaceRun; i++) editor?.handleInput("\x7f");
			spaceRun = 0;
			isHeld = true;
			if (stopping) {
				// The last dictation is still being transcribed: swallow this hold instead of mixing the two.
				ignoring = true;
				ctx.ui.notify("jarvis: still transcribing, hold Space again in a moment", "info");
			} else startRecording(ctx);
			releaseTimer = setInterval(() => {
				if (performance.now() - lastSpaceAt < RELEASE_MS) return;
				if (releaseTimer) clearInterval(releaseTimer);
				isHeld = false;
				if (ignoring) ignoring = false;
				else void stopRecording(ctx, false);
			}, 50);
			requestRender?.();
			return { consume: true };
		};
	}

	// ================================================================== wiring

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		cfg = loadConfig();
		// Take over the prompt editor (we need the caret), unless another extension already owns it:
		// then dictation still works, but the text is pasted when you release instead of typed live.
		const existing = ctx.ui.getEditorComponent() as { isJarvis?: boolean } | undefined;
		if (!existing || existing.isJarvis) {
			const make = Object.assign((...a: ConstructorParameters<typeof CustomEditor>) => new JarvisEditor(...a), { isJarvis: true });
			ctx.ui.setEditorComponent(make);
		}
		unsubscribe?.();
		unsubscribe = ctx.ui.onTerminalInput(onInput(ctx));
		indicator(ctx, "idle");
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		stopSpeaking();
		if (ticker) clearInterval(ticker);
		if (releaseTimer) clearInterval(releaseTimer);
		rec?.kill("SIGTERM");
	});

	// ---- watching the run, so the report is true
	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		stopSpeaking();
		const e = event as { messageType?: string; prompt?: string };
		run.request = e.messageType === "user" ? (e.prompt ?? "") : "";
		run.reply = "";
		run.voice = "";
		run.failed = false;
		run.edited.clear();
		run.commands = run.reads = run.failures = 0;
		run.startedAt = Date.now();
		if (cfg.speak) return { systemPrompt: (event as { systemPrompt: string }).systemPrompt + AGENT_NOTE };
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return;
		const e = event as { toolName: string; input?: { path?: string; file_path?: string } };
		if (e.toolName === "edit" || e.toolName === "write") run.edited.add(e.input?.path ?? e.input?.file_path ?? `file${run.edited.size}`);
		else if (e.toolName === "bash") run.commands++;
		else if (e.toolName === "read") run.reads++;
	});

	pi.on("tool_execution_end", async (event) => {
		if (enabled && (event as { isError?: boolean }).isError) run.failures++;
	});

	pi.on("agent_end", async (event) => {
		if (!enabled) return;
		const msgs = (event as { messages?: { role?: string; stopReason?: string }[] }).messages ?? [];
		const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
		if (lastAssistant?.stopReason === "error") run.failed = true;
		if (lastAssistant) {
			const text = textOf(lastAssistant);
			const lines = [...text.matchAll(/^[ \t>*_`]*VOICE:[ \t]*(.+?)[ \t*_`]*$/gim)];
			if (lines.length) run.voice = speakable(lines[lines.length - 1][1], 300);
			run.reply = text.replace(/^[ \t>*_`]*VOICE:.*$/gim, "").trim() || run.reply;
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		const aborted = (event as { aborted?: boolean }).aborted === true;
		const mine = voiceSent;
		voiceSent = ""; // also while Jarvis is off, so an old voice prompt never comes back later
		if (!enabled || !ctx.hasUI) return;
		// Esc aborted a voice prompt: give the words back so they can be edited instead of re-dictated.
		if (aborted && mine && !(ctx.ui.getEditorText?.() ?? "").trim()) ctx.ui.setEditorText(mine);
		if (cfg.speak && !rec && !stopping) speak(ctx, spokenSummary(aborted)); // never talk into an open microphone
	});

	// ---- the command
	/** Version, where the ears and the voice go, and every saved server with its state and how to switch to it. */
	async function serverReport(): Promise<string> {
		const list = cfg.servers ?? [{ name: "local", url: cfg.url, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) }];
		const act = list.find((x) => x.name === cfg.active) ?? list[0];
		const rows = await Promise.all(
			list.map(async (x) => [`${x === act ? "*" : " "} ${x.name.padEnd(8)} ${x.url}  ${x.model}${x.apiKey ? "  (key)" : ""}  [${await serverState(x, true)}]`, `/jarvis use ${x.name}`]),
		);
		const w = Math.max(...rows.map((r) => r[0].length));
		return [
			`jarvis ${buildInfo()}`,
			`listening (transcription) and speaking both go to: ${act.name}  ${act.url}  ${act.model}`,
			"servers (* = active):",
			...rows.map(([info, hint]) => `${info.padEnd(w)}  |  ${hint}`),
		].join("\n");
	}

	/** The whole /jarvis command; voice commands call it with the same argument string. */
	async function control(args: string | undefined, ctx: ExtensionContext): Promise<void> {
		const [verb, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
		if (verb === "mute") {
			cfg.speak = rest[0] === "on" ? false : rest[0] === "off" ? true : !cfg.speak; // "on" = silent, like a mic mute
			saveConfig(cfg);
			if (!cfg.speak) stopSpeaking(ctx);
			indicator(ctx, "idle");
			ctx.ui.notify(cfg.speak ? "jarvis: speaking again" : "jarvis: muted, still listening", "info");
			return;
		}
		if (verb === "submit") {
			cfg.autoSubmit = !cfg.autoSubmit;
			saveConfig(cfg);
			ctx.ui.notify(cfg.autoSubmit ? `jarvis: spoken prompts are sent automatically (from ${cfg.minWords} words)` : "jarvis: spoken prompts are only typed, you press Enter", "info");
			return;
		}
		if (verb === "version") {
			ctx.ui.notify(`jarvis ${buildInfo()}`, "info");
			return;
		}
		if (verb === "compose") {
			setCompose(ctx, rest[0] === "on" ? true : rest[0] === "off" ? false : !compose);
			return;
		}
		if (verb === "release") {
			const mode = rest[0];
			if (mode !== "send" && mode !== "type" && mode !== "compose") {
				ctx.ui.notify(`jarvis: on release: ${releaseMode()}. Usage: /jarvis release <send|type|compose>`, "info");
				return;
			}
			if (mode === "compose") setCompose(ctx, true);
			else {
				cfg.autoSubmit = mode === "send";
				saveConfig(cfg);
				if (compose) setCompose(ctx, false);
				ctx.ui.notify(mode === "send" ? `jarvis: on release the prompt is sent (from ${cfg.minWords} words)` : "jarvis: on release the words are only typed, you press Enter", "info");
			}
			return;
		}
		if (verb === "servers" || verb === "use" || verb === "add" || verb === "remove" || verb === "key") {
			let list = (cfg.servers ??= [{ name: "local", url: cfg.url, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) }]);
			cfg.active ??= list.find((s) => s.url === cfg.url)?.name ?? list[0].name;
			const name = rest[0];
			/** Make the top-level url/model/apiKey follow the active server. */
			const mirror = () => {
				const a = list.find((x) => x.name === cfg.active) ?? list[0];
				cfg.active = a.name;
				cfg.url = a.url;
				cfg.model = a.model;
				cfg.apiKey = a.apiKey;
			};
			if (verb === "use") {
				const s = list.find((x) => x.name === name);
				if (!s) {
					ctx.ui.notify(`jarvis: no server "${name}". Known: ${list.map((x) => x.name).join(", ")}`, "error");
					return;
				}
				cfg.active = s.name;
				mirror();
				saveConfig(cfg);
				ctx.ui.notify(`jarvis: using ${s.name} (${s.url}, ${s.model})`, "info");
				if (enabled && cfg.speak) speak(ctx, `Using ${s.name}.`);
				return;
			}
			if (verb === "add") {
				if (!name || !rest[1]) {
					ctx.ui.notify("usage: /jarvis add <name> <host[:port]|url> [model] [key=<API key>]", "error");
					return;
				}
				const url = (/^https?:\/\//.test(rest[1]) ? rest[1] : `http://${rest[1]}`).replace(/\/+$/, "");
				const keyArg = rest.slice(2).find((w) => w.startsWith("key="))?.slice(4);
				const model = rest.slice(2).find((w) => !w.startsWith("key="));
				const i = list.findIndex((x) => x.name === name);
				const apiKey = keyArg || (i >= 0 ? list[i].apiKey : undefined); // re-adding keeps the saved key
				const entry: Server = { name, url, model: model ?? DEFAULTS.model, ...(apiKey ? { apiKey } : {}) };
				if (i >= 0) list[i] = entry;
				else list.push(entry);
				mirror();
				saveConfig(cfg);
				ctx.ui.notify(`jarvis: ${i >= 0 ? "updated" : "added"} ${name} (${url}, ${entry.model}${apiKey ? ", key set" : ""})`, "info");
				return;
			}
			if (verb === "key") {
				const s = list.find((x) => x.name === name);
				if (!s) {
					ctx.ui.notify(`usage: /jarvis key <name> [token]  (no token clears the key). Known: ${list.map((x) => x.name).join(", ")}`, "error");
					return;
				}
				if (rest[1]) s.apiKey = rest[1];
				else delete s.apiKey;
				mirror();
				saveConfig(cfg);
				ctx.ui.notify(`jarvis: ${rest[1] ? "key set for" : "key cleared for"} ${s.name}`, "info");
				return;
			}
			if (verb === "remove") {
				if (list.length < 2 || !list.some((x) => x.name === name)) {
					ctx.ui.notify(`jarvis: cannot remove "${name}" (unknown, or the only server)`, "error");
					return;
				}
				list = cfg.servers = list.filter((x) => x.name !== name);
				mirror();
				saveConfig(cfg);
				ctx.ui.notify(`jarvis: removed ${name}; active: ${cfg.active}`, "info");
				return;
			}
			ctx.ui.notify(await serverReport(), "info");
			return;
		}
		if (verb === "say") {
			if (rest.length) speak(ctx, rest.join(" "));
			return;
		}
		if (verb) {
			ctx.ui.notify(`jarvis: ${enabled ? "ON" : "off"}   voice: ${cfg.speak ? "on" : "muted"}   on release: ${releaseMode()}   player: ${player}\n${await serverReport()}`, "info");
			return;
		}
		enabled = !enabled;
		spaceRun = 0;
		if (!enabled) {
			stopSpeaking();
			compose = false;
			if (rec) {
				isHeld = false;
				latched = false;
				if (releaseTimer) clearInterval(releaseTimer);
				await stopRecording(ctx, true);
			}
		}
		indicator(ctx, "idle");
		if (enabled && cfg.speak) speak(ctx, "Jarvis online. Hold space and talk to me."); // before the report: it waits for the servers
		if (enabled && !(ctx.ui.getEditorComponent() as { isJarvis?: boolean } | undefined)?.isJarvis) ctx.ui.notify("jarvis: another extension owns the prompt editor, so dictated text is pasted at the end instead of typed live", "warning");
		ctx.ui.notify(enabled ? `jarvis: online. Hold Space (or press Ctrl+R) and talk; I will tell you when I am done.\n${await serverReport()}` : "jarvis: off. Space types normally again.", "info");
	}

	pi.registerCommand("jarvis", {
		description: "Switch Jarvis (voice in, voice out) on/off. Try: mute, say <words>, submit, release <send|type|compose>, compose, info, servers, use <name>, add <name> <host[:port]> [model] [key=<token>], key <name> [token], remove <name>",
		handler: (args, ctx) => control(args, ctx),
	});
}
