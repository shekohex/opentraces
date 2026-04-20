![opentraces](https://opentraces.pages.dev/og.png)

# opentraces

terminal UI for browsing and sharing your Claude Code, Codex, OpenCode, and Pi Coding Agent sessions.

```
npx opentraces
```

serve browser viewer on Node:

```
npm start
```

## what it does

- finds all your local Claude Code, Codex, OpenCode, and Pi Coding Agent sessions
- fuzzy search across everything
- `s` to share — encrypts the session (AES-256-GCM) and uploads ciphertext to opentraces server storage
- shared sessions are marked with a green indicator in TUI list
- browser viewer has theme switcher (`system`/`dark`/`light`) persisted in localStorage
- `o` to open in browser as a self-contained HTML viewer
- `enter` to export to a local HTML file
- `d` to delete previously shared session permalink
- you control the decryption key — it never leaves your clipboard

## keybindings

`j/k` up/down, `g/G` top/bottom, `/` search, `s` share, `c` copy public url, `d` delete share, `o` open, `q` quit

## sharing

when you press `s`, the session gets compressed, encrypted with a random 32-byte key, and uploaded as encrypted bytes to `OPENTRACES_PUBLIC_URL` server storage. permalink is stable: `/s/:id` and private share URL is `/s/:id#<key>`. key never hits server — decryption happens entirely in browser.

server stores encrypted payload up to 200MB per session. only public metadata is stored in plaintext (`title`, `agent`, `messageCount`, timestamps/size).

share state is persisted locally at `~/.opentraces/shares.jsonl` (share URL, key, delete token, hash). this lets you close TUI and still copy/delete previously shared sessions later.

duplicate prevention uses `sha256` hash of session content during upload. same session content reuses existing permalink instead of creating a new one.

viewer customization lives in `~/.opentraces/config.json`.

supported keys: `userLabel`, `userAvatarUrl`, `assistantFallbackLabel`, `githubUsername`.

example:

```json
{
  "githubUsername": "shekohex",
  "userLabel": "@shekohex"
}
```

when `githubUsername` is present, share metadata stores it and server resolves/stores `githubAvatarUrl` for client rendering.

set `OPENTRACES_PUBLIC_URL` to match whatever host serves `npm start`.

you can also press `c` to copy public URL without key and send key separately.

## requirements

- node 22.5+
- npm

## development

```
npm run dev
```

```
npm run dev:site
```

```
npm run vendor:font
```

downloads latest Nerd Font release via `gh` and vendors `IBMPlexNerdFontMono` into `public/assets/fonts`.
