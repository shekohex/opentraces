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
- `s` to share — encrypts the session (AES-256-GCM) and uploads to a private GitHub gist
- `o` to open in browser as a self-contained HTML viewer
- `enter` to export to a local HTML file
- you control the decryption key — it never leaves your clipboard

## keybindings

`j/k` up/down, `g/G` top/bottom, `/` search, `s` share, `c` copy public url, `o` open, `q` quit

## sharing

when you press `s`, the session gets compressed, encrypted with a random key, and uploaded as a GitHub gist. the private URL (with the key in the fragment) is copied to your clipboard. the key never hits any server — decryption happens entirely in the browser at `OPENTRACES_PUBLIC_URL` or `http://localhost:3000`.

set `OPENTRACES_PUBLIC_URL` to match whatever host serves `npm start`.

you can also press `c` to copy just the public URL without the key, and send the key separately.

## requirements

- node 22.5+
- npm
- `gh` CLI (for sharing via gists)

## development

```
npm run dev
```

```
npm run dev:site
```
