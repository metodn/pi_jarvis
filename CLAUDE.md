# pi_jarvis

## Local development: copy to pi after every change

pi loads Jarvis from `~/.pi/agent/extensions/`, not from this repo. After every edit to `extensions/pi-jarvis.ts` or `src/recorder.ts`, copy both files, then run `/reload` in pi (or restart it):

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/src
cp extensions/pi-jarvis.ts ~/.pi/agent/extensions/pi-jarvis.ts
cp src/recorder.ts ~/.pi/agent/src/recorder.ts
cmp extensions/pi-jarvis.ts ~/.pi/agent/extensions/pi-jarvis.ts && cmp src/recorder.ts ~/.pi/agent/src/recorder.ts && echo copy is latest
```

- The extension imports `../src/recorder.ts`, so both files must be copied, keeping the `extensions/` and `src/` layout.
- Do not also list `git:github.com/metodn/pi_jarvis` in `~/.pi/agent/settings.json`: Jarvis would load twice.
- Syntax check before copying: `bun build extensions/pi-jarvis.ts --target=node --external '@earendil-works/*' --outfile=/dev/null`.

## Version

The version lives in two places that must match: `"version"` in `package.json` and `const VERSION` in `extensions/pi-jarvis.ts`. When you bump it, change both, then copy the files to pi (see above) and check with `/jarvis version`. It prints the version plus a build hash of the loaded file, so you can tell whether the installed copy is the current source.

## Test rubric (run it like a normal user, in tmux pane %19)

Run after every behaviour change, then record result and version in the table. Never `clear` the pane. find the tmux socket with `tmux display-message -p '#{socket_path}'` and pass it with `-S`. Back up `~/.pi/agent/pi-jarvis.json` first (`cp` to `_tmp_test/pi-jarvis.json.orig`) and restore it at the end: tests change `release`, `active` and `speak`.

**Setup.** Copy the files to pi (see above), start `pi --no-session` in %19 with the installed extension, run `/jarvis`. Check `/jarvis version` shows the version you just set. No `--no-extensions -e`: a user runs plain `pi`, with `pi_dictate_asr` loaded too.

**Simulating a user (speaker to microphone loopback).** `_tmp_test/hold.sh "phrase"` starts `uv run --script <path to your lfm3_speak.py> "phrase"` in the background and sends a Space every 40 ms to the pane while it speaks, plus a 1.5 s tail. `_tmp_test/cmd.sh "/jarvis ..."` sends one line and shows what changed on screen. Both are git-ignored; recreate them if missing. Clear the editor between tests with `tmux send-keys C-a C-k`. Audible output check: `pactl list short sink-inputs | wc -l` rises by 1 while Jarvis speaks (baseline is 1 here).

**Caveat.** Voice commands depend on the ASR hearing the loopback voice: "Jarvis mute" came back as "Jarvis Newt", "Jarvis use banana" as "Jarvis used banana". Retry with another phrase from the same row before calling it a failure. A command that falls through becomes a prompt to the model.

Start state: `release send`, `speak on`, `active remote`. Last full run: 0.2.2, 2026-11-12.

| ID | Do | Expect | Last |
|----|----|--------|------|
| T01 | `/jarvis` | online line, version+build, "listening and speaking both go to: <server>", one row per server with state and `/jarvis use` hint, the `pi install` line, and the `pi update --extensions` line only when GitHub has a newer version (fake it by setting `VERSION` to 0.0.1 in the installed copy only) | pass |
| T02 | hold Space, say "What is two plus two? Answer in one short sentence." (release send) | exact transcript, sent without Enter, reply appears | pass |
| T03 | `/jarvis say <sentence>` | a second sink-input appears for the length of the sentence, status shows `♪ Jarvis` | pass |
| T04 | `/jarvis version`, `mute`, `mute off`, `release bogus`, `foo` | version line; status shows `(muted)` then clears; usage line for bogus; `foo` prints the info (no "unknown" message, minor) | pass |
| T05 | `/jarvis release type`, hold and say a sentence | text in editor, not sent, no stray leading spaces | pass (0.2.2) |
| T06 | voice "Jarvis status", "Jarvis version" | spoken status; version line on screen | pass |
| T07 | `/jarvis help`; `/jarvis foo`; voice "Jarvis, what can I say?" and "What can I say?" | typed help lists every slash command and every voice phrase; `foo` warns "unknown" then shows info; the voice help prints the same list and is not sent as a prompt | pass (0.2.2) |
| T08 | voice "Be quiet" then "Speak again" (also "Jarvis mute") | status `(muted)` then clears | pass (ASR heard "Jarvis mute" wrong once, right on retry) |
| T09 | voice "Send automatically", "Type only" | `/jarvis info` shows `send (from 3 words)` then `type only` | pass |
| T10 | voice "Use local", then "Switch to remote" | `jarvis: using <server>`, `/jarvis servers` moves the `*` | pass |
| T11 | Ctrl+R, speak, Enter; Ctrl+R, speak, Esc; Ctrl+R, speak, Ctrl+R | text lands; Esc discards and returns to idle; second Ctrl+R finishes | pass |
| T12 | `/jarvis release compose`, two dictations, voice "Send" | both texts in the editor, then sent as one prompt | pass |
| T13 | voice "Repeat"; hold Space or Esc while Jarvis speaks; voice "Stop" during a long run | last reply spoken again; speech stops and stays stopped; run aborted, "Stop" not sent as a prompt | pass |
| T14 | `/jarvis add dead http://localhost:9 lfm3-audio-2b`, `use dead`, dictate, then `use remote`, `remove dead` | error names the server ("cannot reach dead (...) to transcribe"), at most two messages; remove restores `remote` | pass (0.2.2) |
| T15 | `/jarvis key dead secret` | "key set", the key is never printed, `servers` shows `(key)`, config file mode 600 | pass |
| T16 | release send: say 2 words, then a full sentence | 2 words stay in the editor, the sentence is sent | pass |
| T17 | send a long request by voice, press Esc | run aborted, the prompt returns to the editor | pass |
| T18 | type "a b c" with Jarvis on | spaces typed normally, no recording | pass |
| T19 | `/jarvis release` (no argument); `submit` twice; `compose`, `compose on`, `compose off`; `mute on`, `mute off` | release shows the current mode; submit toggles "only typed" / "sent automatically"; compose toggles and prints the matching line; mute on/off as T04 | pass |
| T20 | voice "Compose", then "Direct mode", then "Jarvis version" | status shows `composing, say send`, then clears; version line printed | pass |

**Coverage rule.** Every line of `/jarvis help` needs a row here. When you add or rename a command, add it to the help text in `VOICE_HELP`, then add a row. Mapping: slash commands T01 T04 T05 T07 T10 T12 T14 T15 T19, `say` T03, Ctrl+R T11; voice phrases T06 T07 T08 T09 T10 T12 T13 T20.

Not covered, test by hand when touched: macOS (sox `play`/`rec`), cold-model retry, a real key hold (auto-repeat timing 300 ms then 30 ms), the 40 s segment commit, the 5-minute stop, Up-arrow history, `API key rejected` / `needs an API key` states, `/jarvis off` while transcribing. Seen once and not reproduced: extra speech about 2.5 s after "Stop" given during a `/jarvis say`.
