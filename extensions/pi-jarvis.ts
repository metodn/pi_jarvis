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
 *   /jarvis submit   toggle sending spoken prompts automatically
 *   /jarvis info     (any other argument) show state and server, changes nothing
 *
 * Config (optional) ~/.pi/agent/pi-jarvis.json:
 *   { "url": "http://localhost:8181", "model": "lfm3-audio-2b", "speak": true, "autoSubmit": true, "minWords": 3 }
 *
 * Needs `parecord` (listening) and `paplay` or `aplay` (speaking). Try without installing:
 *   pi --no-extensions -e ./extensions/pi-jarvis.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Config = { url: string; model: string; speak: boolean; autoSubmit: boolean; minWords: number };

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

function loadConfig(): Config {
	try {
		const c = { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>) };
		return { ...c, url: String(c.url).replace(/\/+$/, "") };
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(c: Config): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n");
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
		headers: { "Content-Type": "application/json" },
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
	const player = spawnSync("which", ["paplay"], { stdio: "ignore" }).status === 0 ? "paplay" : "aplay";
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
	let ticker: ReturnType<typeof setInterval> | undefined;

	// ---- hold detection state
	let spaceRun = 0;
	let lastSpaceAt = 0;
	let isHeld = false;
	let releaseTimer: ReturnType<typeof setInterval> | undefined;

	const transcript = () => [...committed, segText].filter(Boolean).join(" ");

	/** Footer line: one glyph per state. */
	function indicator(ctx: ExtensionContext, state: "rec" | "wait" | "talk" | "idle"): void {
		const t = ctx.ui.theme;
		if (!enabled) ctx.ui.setStatus(STATUS, undefined);
		else if (state === "rec") ctx.ui.setStatus(STATUS, t.fg("error", "● REC") + t.fg("dim", " release Space, Esc cancels"));
		else if (state === "wait") ctx.ui.setStatus(STATUS, t.fg("warning", "◌ transcribing…"));
		else if (state === "talk") ctx.ui.setStatus(STATUS, t.fg("accent", "♪ Jarvis") + t.fg("dim", " Esc, or hold Space, to interrupt"));
		else ctx.ui.setStatus(STATUS, t.fg("dim", cfg.speak ? "jarvis: listening" : "jarvis: listening (muted)"));
	}

	// ================================================================== voice

	function stopSpeaking(ctx?: ExtensionContext): void {
		speakGen++;
		try {
			speakSocket?.close();
		} catch {}
		speakSocket = undefined;
		playerProc?.kill("SIGTERM");
		playerProc = undefined;
		if (isTalking) {
			isTalking = false;
			if (ctx) indicator(ctx, "idle");
		}
	}

	/**
	 * Speak through llama-swap's realtime route: text in, speech out, streamed to the speakers as it arrives.
	 */
	function speak(ctx: ExtensionContext, input: string): void {
		stopSpeaking();
		const gen = ++speakGen;
		const url = `${cfg.url.replace(/^http/, "ws")}/v1/realtime?model=${encodeURIComponent(cfg.model)}`;
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (e) {
			ctx.ui.notify(`jarvis: cannot speak (${(e as Error).message})`, "error");
			return;
		}
		speakSocket = ws;
		let spoken = "";
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
					const args = player === "paplay" ? ["--raw", "--rate=24000", "--format=s16le", "--channels=1"] : ["-q", "-t", "raw", "-r", "24000", "-f", "S16_LE", "-c", "1"];
					playerProc = spawn(player, args, { stdio: ["pipe", "ignore", "ignore"] });
					playerProc.on("error", (e) => ctx.ui.notify(`jarvis: cannot play audio (${e.message})`, "error"));
					playerProc.on("close", () => {
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
			if (gen === speakGen) ctx.ui.notify(`jarvis: cannot reach ${cfg.url} to speak`, "error");
			finish();
		};
		ws.onclose = () => finish(); // the server hung up before response.done
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
		const all = Buffer.concat(pcm); // starts at absolute offset pcmStart
		const end = pcmStart + all.length;
		decodedBytes = end;
		const voiced = trimSilence(all.subarray(segStart - pcmStart));
		if (voiced.length < MIN_BYTES) {
			segText = "";
			return;
		}
		segText = await decodeAudio(cfg, voiced);
		if (!discarded) setLive(transcript());
		if (end - segStart > SEGMENT_BYTES) {
			if (segText) committed.push(segText);
			segText = "";
			segStart = end;
			pcm = [all.subarray(end - pcmStart)]; // the committed audio is no longer needed
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

	function startRecording(ctx: ExtensionContext): void {
		stopSpeaking(ctx); // barge-in: talking over Jarvis silences it
		pcm = [];
		pcmStart = 0;
		bytes = 0;
		segStart = 0;
		committed.length = 0;
		segText = "";
		decodedBytes = 0;
		discarded = false;
		beginLive();
		rec = spawn("parecord", ["--raw", "--latency-msec=30", "--channels=1", "--rate=16000", "--format=s16le"], { stdio: ["ignore", "pipe", "ignore"] });
		rec.stdout?.on("data", (d: Buffer) => {
			pcm.push(d);
			bytes += d.length;
		});
		const proc = rec;
		recDone = new Promise<void>((resolve) => {
			proc.once("close", () => resolve());
			proc.once("error", (e) => {
				ctx.ui.notify(`jarvis: cannot record (${e.message}). Is parecord installed?`, "error");
				resolve();
			});
		});
		indicator(ctx, "rec");
		ticker = setInterval(() => {
			if (bytes > MAX_RECORD_BYTES && isHeld) {
				isHeld = false; // too long: finish as if Space had been released
				if (releaseTimer) clearInterval(releaseTimer);
				ctx.ui.notify("jarvis: that was five minutes, I stopped listening", "info");
				void stopRecording(ctx, false);
				return;
			}
			if (decoding || bytes - decodedBytes < STEP_BYTES) return;
			decoding = true;
			refine(ctx)
				.catch((e) => ctx.ui.notify(`jarvis: ${e.message}`, "error"))
				.finally(() => (decoding = false));
		}, 200);
	}

	/** Spoken commands that act instead of becoming a prompt. */
	function voiceCommand(text: string): "stop" | "repeat" | undefined {
		const n = text
			.toLowerCase()
			.replace(/[^a-z\s']/g, " ")
			.replace(/\b(jarvis|please|ok|okay|hey|could you|can you|would you)\b/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (/^(stop|abort|stop that|stop it|stop everything|stop talking|that is enough)$/.test(n)) return "stop";
		if (/^(repeat|repeat that|repeat it|say that again|say it again|what did you say|come again)$/.test(n)) return "repeat";
		return undefined;
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
			if (bytes - decodedBytes > 4800 || !transcript()) await refine(ctx);
			const final = transcript();
			if (!final) {
				setLive("");
				ctx.ui.notify("jarvis: I did not hear anything", "info");
				return;
			}
			const cmd = voiceCommand(final);
			if (cmd) {
				setLive(""); // a command, not text for the prompt
				if (cmd === "stop") {
					// Aborting makes pi settle, and the settle report says "Stopped." — so only speak when idle.
					if (ctx.isIdle()) {
						if (cfg.speak) speak(ctx, "Nothing is running.");
					} else ctx.abort();
				} else if (lastSpoken) speak(ctx, lastSpoken); // an explicit request to hear it again, so mute does not apply
				else if (cfg.speak) speak(ctx, "I have not said anything yet.");
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
			if (placed && cfg.autoSubmit && final.split(/\s+/).length >= cfg.minWords) {
				const text = (editor?.getText() ?? "").trim();
				if (text) {
					ctx.ui.setEditorText("");
					pi.sendUserMessage(text, ctx.isIdle() ? { expandPromptTemplates: true } : { deliverAs: "steer", expandPromptTemplates: true });
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
			if (editor && !editor.focused) return undefined; // a dialog or overlay has the keyboard
			if (isTalking && (data === "\x1b" || data === "\x03")) {
				stopSpeaking(ctx); // Esc silences Jarvis
				return { consume: true };
			}
			if (isHeld && (data === "\x1b" || data === "\x03")) {
				isHeld = false;
				if (releaseTimer) clearInterval(releaseTimer);
				void stopRecording(ctx, true);
				return { consume: true };
			}
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
		} else ctx.ui.notify("jarvis: another extension owns the prompt editor, so dictated text is pasted at the end instead of typed live", "warning");
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
		if (!enabled || !cfg.speak || !ctx.hasUI) return;
		speak(ctx, spokenSummary((event as { aborted?: boolean }).aborted === true));
	});

	// ---- the command
	pi.registerCommand("jarvis", {
		description: "Switch Jarvis (voice in, voice out) on/off. Try: mute, say <words>, submit, info",
		handler: async (args, ctx) => {
			const [verb, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (verb === "mute") {
				cfg.speak = !cfg.speak;
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
			if (verb === "say") {
				if (rest.length) speak(ctx, rest.join(" "));
				return;
			}
			if (verb) {
				const up = await fetch(`${cfg.url}/v1/models`, { signal: AbortSignal.timeout(2500) }).then(
					async (r) => (r.ok ? (((await r.json().catch(() => ({}))) as { data?: { id: string }[] }).data?.some((m) => m.id === cfg.model) ? "ready" : "model not listed") : "no models API"),
					() => "down",
				);
				ctx.ui.notify(
					`jarvis: ${enabled ? "ON" : "off"}   voice: ${cfg.speak ? "on" : "muted"}   auto-send: ${cfg.autoSubmit ? `on (>= ${cfg.minWords} words)` : "off"}\nserver: ${cfg.url}  ${cfg.model}  [${up}]\nplayer: ${player}`,
					"info",
				);
				return;
			}
			enabled = !enabled;
			spaceRun = 0;
			if (!enabled) {
				stopSpeaking();
				if (rec) {
					isHeld = false;
					if (releaseTimer) clearInterval(releaseTimer);
					await stopRecording(ctx, true);
				}
			}
			indicator(ctx, "idle");
			ctx.ui.notify(enabled ? "jarvis: online. Hold Space and talk; I will tell you when I am done." : "jarvis: off. Space types normally again.", "info");
			if (enabled && cfg.speak) speak(ctx, "Jarvis online. Hold space and talk to me.");
		},
	});
}
