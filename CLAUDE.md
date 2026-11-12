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
