# pi-jarvis

Talk to the [pi](https://pi.dev) coding agent, and let it talk back. Hold **Space** and speak: your
words are typed into the prompt and sent. When pi finishes, a calm voice tells you the outcome in one
sentence, so you can look away from the screen while it works.

Everything runs on **one local llama-swap server** and its audio model. No audio and no text is sent
to any cloud speech service, and there is nothing else to run.

```
you:    (hold Space) "How many python files are in this folder? Use the bash tool."
pi:     runs find ... | wc -l
Jarvis: "There are three Python files in this folder."
```

## What it does

- **Ears.** Hold Space, speak, release. The words appear in the prompt at the caret while you talk
  (start, middle or end of text you already wrote) and are sent when you let go, if they are at least
  three words. Spoken while pi is busy, they are queued for after the current step.
- **Voice.** When pi finishes, Jarvis speaks a short report. pi's own model writes it: while Jarvis is
  on, a short note in pi's system prompt asks the agent to end its final reply with one line,
  `VOICE: <one or two plain sentences>`. The audio model then reads exactly that line aloud. If the
  agent leaves it out, Jarvis falls back to the start of the reply plus what happened (files changed,
  commands run, failures).
- **Interrupt.** Esc, or holding Space to talk, cuts him off at once.
- **Spoken commands.** Say **"stop"** to abort the running task, **"repeat that"** to hear the last
  sentence again. These are never sent to the agent as prompts.

## Requirements

- **pi** (developed and tested on 1.5.0, Linux).
- **PulseAudio or PipeWire**: `parecord` to listen, and `paplay` (or `aplay`) to speak.
- **A llama-swap server** (default `http://localhost:8181`) with an audio model that offers both:
  - `POST /v1/chat/completions` with `input_audio` content, for transcription, and
  - the OpenAI-Realtime-style WebSocket `/v1/realtime` with `output_modalities: ["text","audio"]`,
    for speech (24 kHz PCM16 out).

  It was built and tested with **LFM3-Audio-2B** (`lfm3-audio-2b`) served by llama.cpp behind
  llama-swap. Another model works if it speaks these two routes; change `model` in the config.

## Install

Pick one.

**From GitHub (recommended).** Installs for your user; update with `pi update --extensions`:

```bash
pi install git:github.com/metodn/pi_jarvis
```

Pin a release instead by adding a tag: `pi install git:github.com/metodn/pi_jarvis@v0.1.0`.

**Try it for one session, without installing:**

```bash
pi -e git:github.com/metodn/pi_jarvis
```

**Manual copy.** Put the single file where pi discovers extensions, then restart pi or run `/reload`:

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/metodn/pi_jarvis/main/extensions/pi-jarvis.ts \
  -o ~/.pi/agent/extensions/pi-jarvis.ts
```

**Conflicts.** Do not load this together with another extension that also reacts to the Space key
(for example a separate dictation extension): the two would fight. Disable the other one with
`pi config`, or load only this one with `pi --no-extensions -e git:github.com/metodn/pi_jarvis`.

To remove it: `pi remove git:github.com/metodn/pi_jarvis` (or delete the copied file).

## Use

Jarvis is **off at the start of every session**, so Space types normally until you switch it on.

| Command | What it does |
| --- | --- |
| `/jarvis` | Switch Jarvis on or off. Switching on, he says "Jarvis online." |
| `/jarvis mute` | Stop or resume the speaking. Listening stays on. |
| `/jarvis submit` | Toggle sending spoken prompts automatically. Off: they are only typed and you press Enter. |
| `/jarvis say <words>` | Speak the given words. |
| `/jarvis info` (any other argument) | Show state, the server and whether it serves the model. Changes nothing. |

With Jarvis on:

1. **Hold Space.** A normal tap still types a space. Recording starts after the terminal's key-repeat
   delay (about half a second); the footer shows `● REC`.
2. **Speak.** The words are typed at the caret as the model refines them.
3. **Release.** The text is finalized; if it is at least three words (and auto-send is on) it is sent.
4. **Esc or Ctrl+C while holding** cancels and removes what was typed.

## Configuration

Optional file `~/.pi/agent/pi-jarvis.json` (created when you use `/jarvis mute` or `/jarvis submit`):

```json
{ "url": "http://localhost:8181", "model": "lfm3-audio-2b", "speak": true, "autoSubmit": true, "minWords": 3 }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | `http://localhost:8181` | llama-swap base URL |
| `model` | `lfm3-audio-2b` | model name for both transcription and speech |
| `speak` | `true` | spoken reports (what `/jarvis mute` toggles) |
| `autoSubmit` | `true` | send spoken prompts automatically (what `/jarvis submit` toggles) |
| `minWords` | `3` | fewest spoken words that are sent automatically |

## How it works

- **Space hold** is detected from the terminal's key auto-repeat (terminals send no key release):
  three spaces in quick succession are a hold, and 150 ms without one is a release. The repeats are
  swallowed before the editor sees them, so the cursor does not move. The one or two spaces typed
  before the hold is recognised are deleted again through the editor, wherever the caret is.
- **Transcription.** Audio is recorded with `parecord` (16 kHz mono) and re-sent about once a second
  as a growing WAV, so the text refines while you speak. Leading silence is trimmed to stop the model
  inventing words from room noise. Long dictation is committed in 40 second segments; one hold ends
  by itself after five minutes.
- **Speech.** The report text goes to `/v1/realtime` and the model's audio is streamed to the speakers
  as it arrives. A plain "text to speech reader" instruction is used because a persona made the model
  improvise; the summary itself is written by pi's model, not by the audio model, because the audio
  model summarised long replies at far too great a length.
- **Watching the run** uses pi's events (`before_agent_start`, `tool_call`, `tool_execution_end`,
  `agent_end`, `agent_settled`) to count files changed and commands run for the fallback report.

## Privacy and safety

- Audio is recorded locally and sent only to the `url` you configure (default `localhost`). The only
  file written is the optional config.
- While Jarvis is on, each run's system prompt gains one short paragraph asking for the `VOICE:` line.
  That line is visible in the transcript.
- Spoken text is sent to pi exactly as a typed prompt would be, including command and template
  expansion, so a mis-transcribed `/something` at the start of the prompt behaves like typing it.
  Turn auto-send off (`/jarvis submit`) if you want to review every spoken prompt first.
- The speech model only reads text it is given; it has no tools.

## Limitations

- Linux with `parecord` only; tested in tmux with PipeWire.
- In terminals that report keys with the kitty keyboard protocol, Esc and Ctrl+C are not recognised
  by the interrupt handling (Space-hold itself is unaffected).
- Recording starts about half a second after Space goes down (the key-repeat delay), so a word spoken
  the instant you press is lost. For that first half second one or two spaces appear and are removed.
- The dictated words cannot be dimmed while provisional: the editor cannot style typed text.
- Very short phrases ("stop", "repeat that") are sometimes misheard by the speech recognizer.
- Jarvis does not replace another extension's prompt editor: if one is installed, dictated text is
  pasted on release instead of typed live (this path is implemented but has not been tested).
- The first sentence after the audio model has been unloaded waits for it to load again.

## License

MIT
