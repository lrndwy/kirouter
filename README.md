# kirouter

[![npm version](https://img.shields.io/npm/v/@lrnd/kirouter.svg)](https://www.npmjs.com/package/@lrnd/kirouter)
[![license](https://img.shields.io/npm/l/@lrnd/kirouter.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@lrnd/kirouter.svg)](https://nodejs.org)

CLI proxy lokal **Kiro-only** (mirip 9router, tanpa multi-provider).

- Endpoint OpenAI/Claude-compatible: `/v1/chat/completions`, `/v1/messages`, `/v1/models`
- Request ke Kiro lewat jalur minimal (tanpa RTK / session replay / integrity gate)
- Install ke CLI Tools agent (Claude Code, Claude Cowork/Desktop, Codex, OpenCode, Droid, Cline) seperti sidebar 9router

## Install

Dari npm (disarankan):

```bash
npm install -g @lrnd/kirouter
```

Perintah CLI tetap `kirouter`. Atau sekali jalan tanpa install:

```bash
npx @lrnd/kirouter
```

Dari source:

```bash
git clone https://github.com/lrndwy/kirouter.git
cd kirouter
npm install -g .
```

## Quick start

Jalankan saja — proxy + live dashboard otomatis start:

```bash
kirouter
```

Dashboard default **minimal** (logo + status + activity box). Log panjang tidak menggulung layar.

Keys saat proxy jalan:
- `L` — buka / tutup **frame log scrollable** (`↑↓` / `PgUp` `PgDn` / `g` `G` · `Esc` tutup)
- `m` menu · `h` help · `u` usage · `s` stats · `a` accounts · `t` tools · `c` refresh · `q` quit

Setiap request menyimpan **input/output tokens** + **max context**; lihat detail di frame `L`.

### Hemat token (v0.2, default on)

Sebelum request ke Kiro, kirouter memangkas `tool_result` besar dan (jika context ≥ **70%** window) merangkum history lama secara lokal — **tanpa** panggilan model ekstra. Status muncul sebagai `saved` / `compact` di Activity & log.

```bash
kirouter config
kirouter config set tokenSaver.maxToolResultChars 8000
kirouter config set contextCompact.thresholdPct 70
```

v0.2.1+ juga **canonicalize** conversation Kiro (tool pair orphan/duplikat/nama tool hilang) agar Claude Code / Desktop tidak kena `REQUEST_BODY_INVALID`.

### Multi-akun (disarankan): `kiro_keys.txt`

Format per baris: `email|refreshToken`

```text
dng153@geusil.com|aorAAAAAG...Ckc0:MGQC...
dng151@geusil.com|aorAAAAAG...Ckc0:MGYC...
dng163@geusil.com|
```

Baris tanpa token (setelah `|` kosong) diabaikan.

```bash
# Login multi-akun (disarankan) — import + verifikasi sample
kirouter login
# pilih 1) Import kiro_keys.txt

# Atau langsung:
kirouter accounts import ./kiro_keys.txt
kirouter accounts verify 5
kirouter accounts
kirouter start
```

File keys juga bisa di `~/.kirouter/kiro_keys.txt` atau `./kiro_keys.txt` (cwd).

Saat request kena `429` / `401` / `403`, kirouter otomatis ganti ke akun berikutnya (round-robin + cooldown).

### Single akun

```bash
kirouter login
kirouter start
```

### Install ke Claude Code

```bash
kirouter tools claude --model claude-sonnet-4.5
```

Token/context di Claude Code & Cowork dibaca dari `usage` pada `/v1/messages` (+ `/v1/messages/count_tokens`).
OpenCode membutuhkan `limit.context` di config — `kirouter tools opencode` menulisnya otomatis.

### Install ke Claude Desktop (Cowork)

Third-party inference di Claude Desktop (mode Cowork / 3p):

```bash
# pastikan Claude Desktop sudah pernah dibuka sekali
kirouter tools cowork --model claude-sonnet-4.5
# alias yang sama:
kirouter tools desktop --model claude-sonnet-4.5
```

Lalu **Quit & reopen Claude Desktop**. Pastikan Developer mode / third-party inference aktif
(Help → Troubleshooting).

Endpoint:

```
http://127.0.0.1:20129/v1
```

API key lokal ada di `~/.kirouter/config.json` (`localApiKey`), atau lihat dengan:

```bash
kirouter status
```

## Perintah

| Command | Fungsi |
|---------|--------|
| `kirouter` / `start` | Start proxy + live log/dashboard |
| `kirouter menu` | Menu setup interaktif |
| `kirouter usage` | Kuota Kiro + stats lokal |
| `kirouter login` / `logout` | Auth Kiro (single) |
| `kirouter accounts` | List semua akun + usage per akun |
| `kirouter accounts import <file>` | Import/merge multi-akun |
| `kirouter accounts verify [n]` | Verify token (default: semua) |
| `kirouter status` | Endpoint + status login |
| `kirouter tools` | Status CLI tools |
| `kirouter tools models` | Daftar model yang bisa di-apply |
| `kirouter tools <name>` | Apply config ke tool (pilih model interaktif) |
| `kirouter tools <name> --model <id>` | Apply dengan model tertentu |
| `kirouter tools reset <name>` | Reset config tool |
| `kirouter config` | Lihat token-saver / context-compact |
| `kirouter config set <k> <v>` | Ubah setting hemat token |

Flags: `-p/--port`, `-H/--host`, `--no-auth`, `--model`.

Saat apply (menu atau `kirouter tools <name>` tanpa `--model`), muncul daftar model dari Kiro (Sonnet / Opus / Haiku / dll).

## CLI Tools

Auto-apply:

- `claude` → `~/.claude/settings.json` (Claude Code)
- `cowork` / `desktop` → Claude Desktop Cowork 3p
  (`~/Library/Application Support/Claude-3p/configLibrary/` + `deploymentMode=3p`)
- `codex` → `~/.codex/config.toml` + `auth.json`
- `opencode` → `~/.config/opencode/opencode.json`
- `droid` → `~/.factory/settings.json`
- `cline` → `~/.cline/data/*`

Guide-only:

- `cursor` → tampilkan langkah manual (+ base URL & API key)

Alias: `claude-code` → `claude` · `desktop` / `claude-desktop` / `claude-cowork` → `cowork`

Marker config memakai prefix `kirouter` agar bisa berdampingan dengan 9router.

## Data

```
~/.kirouter/config.json
~/.kirouter/credentials.json
~/.kirouter/kiro_keys.txt
```

Override:
- `KIROUTER_DATA_DIR=/path`
- `KIROUTER_KEYS_FILE=/path/to/kiro_keys.txt`

## Contoh curl

```bash
export KEY=$(node -e "console.log(require(process.env.HOME+'/.kirouter/config.json').localApiKey)")

curl http://localhost:20129/v1/models -H "Authorization: Bearer $KEY"

curl http://localhost:20129/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "stream": false,
    "messages": [{"role":"user","content":"ping"}]
  }'
```

## Catatan

- Port default **20129** (9router memakai 20128).
- Hanya provider Kiro.
- Translate wire format OpenAI/Claude → Kiro tetap ada (wajib); pengolahan berat 9router tidak diikutkan.

## Publish (maintainers)

```bash
# 1) GitHub
git init
git add .
git commit -m "Initial release"
gh repo create lrndwy/kirouter --public --source=. --remote=origin --push

# 2) npm (sekali: npm login)
npm run pack:dry    # pastikan kiro_keys.txt TIDAK ikut
npm publish --access public

# 3) Release berikutnya
npm version patch   # atau minor / major
git push && git push --tags
# Buat GitHub Release → workflow publish.yml otomatis publish ke npm
# (set secret NPM_TOKEN di repo Settings → Secrets)
```
