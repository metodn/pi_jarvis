/**
 * `/jarvis doctor`: are the audio tools installed, and does sound reach the machine the user sits at
 * (over SSH: through a forwarded PulseAudio port)? Read-only: it records and plays nothing.
 */
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { hostname } from "node:os";
import { onPath, pickRecorder } from "./recorder.ts";

export type Finding = { level: "ok" | "warn" | "fail"; text: string; fix?: string };

const PORT = 4713; // PulseAudio's TCP port, the one the README forwards
const forwardHint = (port: string | number) =>
	`on the machine you sit at, add to ~/.ssh/config for this host "RemoteForward ${port} 127.0.0.1:${PORT}", then reconnect (only the first session to a host holds the port)`;

/** The command that installs the PulseAudio client tools (pactl, paplay, parecord) on this Linux. */
function installPulseTools(): string {
	if (onPath("apt-get")) return "sudo apt install pulseaudio-utils";
	if (onPath("dnf")) return "sudo dnf install pulseaudio-utils";
	if (onPath("pacman")) return "sudo pacman -S libpulse";
	if (onPath("zypper")) return "sudo zypper install pulseaudio-utils";
	if (onPath("nixos-rebuild")) return "add pkgs.pulseaudio to environment.systemPackages";
	return "install pulseaudio-utils";
}

type Pulse = { host: string; sink: string; source: string };

/** What the audio server says about itself, or undefined when none answers. */
function pulseInfo(server?: string): Promise<Pulse | undefined> {
	const env = { ...process.env, LC_ALL: "C", ...(server ? { PULSE_SERVER: server } : {}) };
	return new Promise((resolve) => {
		execFile("pactl", ["info"], { env, timeout: 3000 }, (error, out) => {
			const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(String(out))?.[1]?.trim() ?? "";
			const host = field("Host Name"); // empty when nothing answered: pactl exits 0 when the timeout stops it
			resolve(error || !host ? undefined : { host, sink: field("Default Sink"), source: field("Default Source") });
		});
	});
}

function listening(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port, timeout: 1000 });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

async function audioServer(): Promise<Finding[]> {
	if (!onPath("pactl")) return [{ level: "warn", text: "pactl not found, so the audio server and the SSH tunnel cannot be checked", fix: installPulseTools() }];
	const out: Finding[] = [];
	const env = process.env.PULSE_SERVER;
	const ssh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY); // can be missing inside tmux
	// a PULSE_SERVER on this machine's loopback TCP port is how a forwarded SSH port looks
	const loop = /^(?:tcp6?:)?(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/.exec(env ?? "");
	const info = await pulseInfo();
	const away = info !== undefined && info.host !== hostname();

	if (info) {
		out.push({ level: "ok", text: `audio server answers (PULSE_SERVER=${env ?? "unset"}), it runs on ${info.host} (${away ? "another machine" : "this machine"})` });
		out.push(info.sink === "auto_null" ? { level: "warn", text: "speaker: only a dummy output, nothing will be heard" } : { level: "ok", text: `speaker: ${info.sink}` });
		out.push(
			!info.source || info.source.endsWith(".monitor")
				? { level: "warn", text: `microphone: none (default source is ${info.source || "empty"})` }
				: { level: "ok", text: `microphone: ${info.source}` },
		);
		if (away && (loop || ssh)) out.push({ level: "ok", text: `SSH audio: sound and microphone go through to ${info.host}` });
	} else if (loop) {
		const port = Number(loop[2] ?? PORT);
		out.push(
			(await listening(loop[1].replace(/[[\]]/g, ""), port))
				? { level: "fail", text: `SSH tunnel: port ${port} is open but no audio server answers behind it`, fix: `on the machine you sit at: pactl load-module module-native-protocol-tcp port=${PORT} listen=127.0.0.1 auth-anonymous=1` }
				: { level: "fail", text: `SSH tunnel: down, nothing listens on port ${port} (PULSE_SERVER=${env})`, fix: forwardHint(port) },
		);
	} else out.push({ level: "fail", text: `no audio server answers (PULSE_SERVER=${env ?? "unset"})` });

	if (!env && !away) {
		// a tunnel can be up while this pi was started without PULSE_SERVER
		const via = (await listening("127.0.0.1", PORT)) ? await pulseInfo(`tcp:127.0.0.1:${PORT}`) : undefined;
		if (via && via.host !== hostname())
			out.push({ level: "fail", text: `SSH tunnel to ${via.host} is up on port ${PORT}, but this pi does not use it`, fix: `export PULSE_SERVER=tcp:127.0.0.1:${PORT} in the shell, then start pi again from it` });
		else if (ssh) out.push({ level: "warn", text: "SSH session without forwarded audio: sound and microphone stay on this machine", fix: `${forwardHint(PORT)}; here: export PULSE_SERVER=tcp:127.0.0.1:${PORT}` });
	}
	return out;
}

/** Recorder, player and (on Linux) the audio server. `player` is the one the extension chose at load. */
export async function checkAudio(player: string): Promise<Finding[]> {
	const linux = process.platform === "linux";
	const picked = pickRecorder();
	const out: Finding[] = [
		"error" in picked ? { level: "fail", text: picked.error, ...(linux ? { fix: installPulseTools() } : {}) } : { level: "ok", text: `recorder: ${picked.backend.cmd}` },
	];
	if (process.platform === "win32") out.push({ level: "warn", text: "player: speaking is not supported on Windows yet" });
	else if (onPath(player)) out.push({ level: "ok", text: `player: ${player}` });
	else out.push({ level: "fail", text: `player: ${player} not found`, fix: linux ? installPulseTools() : "brew install sox" });
	if (!linux) return [...out, { level: "warn", text: "audio server and SSH tunnel are only checked on Linux" }];
	const alsa = [...("backend" in picked && picked.backend.cmd !== "parecord" ? [picked.backend.cmd] : []), ...(player === "aplay" ? [player] : [])];
	if (process.env.PULSE_SERVER && alsa.length) out.push({ level: "warn", text: `${alsa.join(" and ")} may not reach PULSE_SERVER without ALSA's pulse plugin`, fix: installPulseTools() });
	return [...out, ...(await audioServer())];
}
