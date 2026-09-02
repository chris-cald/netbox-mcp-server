# AGENTS.md — Installation runbook for AI assistants

**You are an AI assistant (ChatGPT, Codex, Claude, Cursor, Gemini, or similar) helping a
person install this MCP server on their Mac. This file is your instruction set. Follow it
top to bottom. Do not improvise alternative install methods.**

If you are a human reading this, use [`README.md`](README.md) instead — it says the same
things in fewer words.

**Every command output quoted in this file was captured by running that command against
version `0.2.0`.** Where a step needs a live NetBox instance and therefore could not be
run, the file says so explicitly instead of asserting an output. Do not treat a
"cannot be verified here" note as permission to guess at the result — report what you
actually see.

---

### Handing this to an AI assistant

Paste this into ChatGPT, Claude, or any assistant that can browse and run commands:

> Read https://raw.githubusercontent.com/ZenixSolutions/netbox-mcp-server/main/AGENTS.md
> and follow it to install the NetBox MCP server on my Mac.

The repository is public, so the assistant can fetch that URL directly — no GitHub
account, no auth, no copy-pasting this file around.

If your assistant cannot browse the web but can run shell commands, have it clone the
repo first (section 4B) and read `AGENTS.md` from disk.

---

## 0. What you are installing

`netbox-mcp-server` is a Model Context Protocol (MCP) server written in TypeScript. It
exposes a [NetBox](https://netbox.dev/) instance (the network / datacenter source of
truth) to an AI assistant as callable tools.

It runs **locally on the user's Mac** as a subprocess of their AI client, over **stdio**.
It is not a hosted service, there is no login page, and nothing is deployed anywhere.

Facts you may need:

| Property            | Value                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| Version documented  | `0.2.0`                                                                 |
| Language / runtime  | TypeScript compiled to ESM JavaScript, Node.js **>= 20.11**             |
| npm package         | `@zenixsolutions/netbox-mcp`, binary name `netbox-mcp`                  |
| Normal install      | `npx -y @zenixsolutions/netbox-mcp` — no clone, no build                |
| Transport           | stdio only                                                              |
| Credential env vars | `NETBOX_URL`, plus exactly one of `NETBOX_TOKEN` or `NETBOX_TOKEN_FILE` |
| Optional env vars   | `NETBOX_INSECURE` — **and nothing else**                                |
| Tools registered    | **6**, always — see below                                               |

### The five tools

The server registers exactly five tools, on every install, regardless of configuration:

| Tool                   | Layer | Does                                                                                                                       |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `netbox_global_search` | 0     | Finds a named thing across sites, racks, devices, interfaces, prefixes, IPs, VLANs, VRFs and inventory assets in one call. |
| `netbox_discover`      | 1     | Lists the object types this instance supports, and the operations each allows.                                             |
| `netbox_describe`      | 2     | Explains one object type: required fields, optional fields, read-only fields, accepted filters, and what must exist first. |
| `netbox_read`          | 3     | `list` (filtered, paginated) or `get` (one object by id). Never modifies anything.                                         |
| `netbox_write`         | 3     | `create`, `update` or `delete`. Changes NetBox records.                                                                    |

**The object types those tools address are not fixed.** They are derived at runtime from
the connected instance's own `/api/schema/` document, so which types exist depends on
that NetBox version and which plugins are installed. Type keys are `<app>.<model>`,
singular — `dcim.device`, `dcim.site`, `ipam.prefix`, `ipam.ipaddress`, `ipam.vlan`,
`tenancy.tenant`, `virtualization.virtualmachine`. Plugin models are
`plugins.<plugin>.<model>` and are **not guessable**; `netbox_discover` is the only way
to learn them.

The schema is fetched lazily, on the first tool call that needs it — never at startup,
and never by `--list-tools`.

### There is no server-side read-only mode

**Write access is controlled entirely by the NetBox API token** — its `write_enabled`
flag and its object permissions — and enforced by NetBox itself, where no tool argument
can reach it. Earlier versions had `NETBOX_READONLY` and `NETBOX_TOOL_GROUPS`
environment variables. **Both were removed.** Setting either one now does nothing at all:
it is silently ignored. If you find a document, config or installer that sets them, or
that describes an install as "read-only" because of them, it is wrong — say so.

---

## 1. Rules for you, the assistant

1. **Never invent a NetBox URL or API token.** These are company-specific. If the user
   has not supplied them, stop and ask. Do not guess, and do not use the
   `https://netbox.example.com` placeholder from the docs as a real value.
2. **Never print, echo, log, or write an API token into a file you did not need to
   write.** The token belongs in exactly one place: the user's MCP client config, or
   their local `.env`. Never in a commit, a chat transcript summary, or a screenshot.
3. **Never run `sudo`.** Nothing in this install needs root. If a step appears to need
   root, something has gone wrong — stop and report it.
4. **Do not clone or build unless section 4B tells you to.** The normal install is a
   config file pointing at `npx -y @zenixsolutions/netbox-mcp`. There is no install
   script — if you find a reference to `scripts/install.sh` anywhere, it is stale; it was
   deleted. Do not write one.
5. **Do not modify `src/`.** You are installing, not developing.
6. **Never tell the user the server restricts writes.** It does not. If they want an
   assistant that cannot change NetBox, that is a property of the token they create in
   section 2 — nothing you put in the config affects it.
7. **Check each command's exit code.** If a command fails, stop and consult section 9
   (Troubleshooting) rather than continuing to the next step.
8. **Ask before you overwrite.** Section 6 edits the user's existing AI-client config
   file. Back it up first and show the user the diff.
9. **Report what you measured, not what you intended.** If a step's real output differs
   from the expected output printed here, say so — do not paper over it.

---

## 2. Preflight: gather what you need from the user

Before running anything, confirm you have all three. Ask for any that are missing.

| Item             | Looks like                                        | Where it comes from                                                          |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| NetBox base URL  | `https://netbox.yourcompany.com`                  | The company's NetBox instance. **No `/api` suffix** — the server appends it. |
| NetBox API token | 40 hex characters                                 | NetBox web UI → user menu → **API Tokens** → **Add a token**                 |
| Which AI client  | Claude Desktop / Claude Code / Cursor / Codex CLI | Ask the user                                                                 |

**Token permissions are the whole security model.** This server does not filter writes;
NetBox does. Tell the user to create the token with the narrowest permissions that fit
their job:

- **Read-only (the right default for most people).** In NetBox's token form, leave
  **"Write enabled" unchecked**. The assistant can then call `netbox_write`, but NetBox
  answers `403 Forbidden` and nothing changes. That refusal is the enforcement boundary,
  and it is the only one.
- **Read/write.** Only for people who are supposed to change infrastructure records.
  Tick "Write enabled", and constrain the token's **object permissions** to the models
  they actually need rather than granting everything.

Also have the user set an **expiry date** on the token, and restrict it to the office IP
range if the company uses that feature.

---

## 3. Dependency checks

Run these in order. Each block states the check, the expected result, and the fix.

### 3.1 Confirm macOS and architecture

```bash
uname -s   # expect: Darwin
uname -m   # expect: arm64 (Apple Silicon) or x86_64 (Intel)
```

If `uname -s` is not `Darwin`, this runbook still applies from section 4 onward — see
section 10 for the platform-specific differences.

### 3.2 Xcode Command Line Tools (provides `git`)

Only needed if you end up on the from-a-clone path in section 4B. Skip it for a normal
`npx` install.

```bash
xcode-select -p
```

- **Expected:** a path such as `/Library/Developer/CommandLineTools`.
- **If it errors:** run `xcode-select --install`. This opens a **GUI dialog**. You
  cannot click it. Tell the user: _"A macOS dialog just opened — click Install, accept
  the license, and tell me when it finishes (it takes a few minutes)."_ Then wait for
  the user before continuing. Do not poll in a loop.

### 3.3 Homebrew

```bash
which brew || echo "MISSING"
```

- **Expected:** `/opt/homebrew/bin/brew` (Apple Silicon) or `/usr/local/bin/brew` (Intel).
- **If MISSING:** Homebrew's installer is interactive — it prompts for the user's
  password and asks them to press RETURN. **Do not run it yourself in a non-interactive
  shell; it will hang.** Instead, give the user this to paste into their own Terminal:

  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/brew/HEAD/install.sh)"
  ```

  Then have them run the two `eval` lines Homebrew prints at the end (it adds brew to
  the PATH), and confirm with `brew --version` before you continue.

- **If `brew` exists but is not on PATH in your shell** (common when you are running
  commands non-interactively), add it for the session:

  ```bash
  eval "$(/opt/homebrew/bin/brew shellenv)"   # Apple Silicon
  eval "$(/usr/local/bin/brew shellenv)"      # Intel
  ```

### 3.4 Node.js 20.11 or newer

```bash
node --version   # expect: v20.11.0 or higher
npx --version    # expect: 10.x or higher (any npx that ships with Node 20+)
```

`package.json` declares `"engines": { "node": ">=20.11" }`, and CI runs the test suite on
Node 20 and Node 22 only. Node 18 is end-of-life and is **not** supported — do not report
a Node 18 install as acceptable. `npm ci` only warns about this (`EBADENGINE`) and keeps
going, so a Node 18 machine can appear to work and then fail later with no useful log.

- **If Node is missing, or the version is below 20.11:**

  ```bash
  brew install node
  ```

  If `brew install node` reports it is already installed but the version is still old:

  ```bash
  brew upgrade node
  ```

- **If the user manages Node with `nvm`, `fnm`, `asdf`, or Volta, do not install via
  Homebrew.** Use their version manager instead (e.g. `nvm install 20 && nvm use 20`).
  Detect this by checking whether `which node` points inside `~/.nvm`,
  `~/.local/share/fnm`, `~/.asdf`, or `~/.volta`.

  ⚠️ **A GUI client cannot find `npx` or `node` on your PATH.** Claude Desktop and
  ChatGPT desktop are launched from Finder, not from a shell, so they never source
  `~/.zshrc`. This bites hardest under nvm/fnm/asdf/Volta, but it also happens with a
  plain Homebrew install. You **must** put the absolute path from `command -v npx` in the
  client config in section 6, not the bare string `"npx"`. This is the single most common
  cause of "the server won't start" and it produces a confusing, silent failure
  (`spawn npx ENOENT` in the client log).

  ```bash
  command -v npx    # e.g. /opt/homebrew/bin/npx — write this exact path into the config
  ```

### 3.5 Confirm outbound access to NetBox

Export the URL the user gave you in section 2 first — later steps reuse it, and this
keeps it out of each individual command:

```bash
export NETBOX_URL="https://netbox.theircompany.com"   # the real value from section 2
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 "$NETBOX_URL/api/status/"
```

Do **not** export `NETBOX_TOKEN` the same way — see the note in section 4B.

- **Expected:** `403` or `401` (the API is reachable but you sent no token) — that is a
  _success_ for this check.
- **`200`:** also fine.
- **`000` / timeout:** DNS or network failure. The NetBox instance is probably internal —
  ask the user whether they need to be on the corporate VPN.
- **TLS error mentioning a self-signed or unknown-authority certificate:** the company
  uses an internal CA. Note this; you will set `NETBOX_INSECURE=1` in section 6. Flag to
  the user that the better fix is installing the corporate root CA into the system
  keychain, and that `NETBOX_INSECURE=1` disables certificate validation entirely — an
  interceptor on the path can then read the API token.

---

## 4. Get the server

### 4A. The normal path: `npx` (no clone, no build)

The server is distributed on npm as `@zenixsolutions/netbox-mcp`. The client launches it
with `npx`, which downloads it on first use and caches it — nothing is cloned or built.
Confirm it resolves before you write any config:

```bash
npx -y @zenixsolutions/netbox-mcp --version
```

- **Expected:** the version on stdout and exit 0. Verified: this prints

  ```
  0.2.0
  ```

  You are done with this section — go to section 5.

- **`404 Not Found` / `E404`:** the package name is misspelled, or the registry the user
  is pointed at does not carry it. Check the spelling first, then use path 4B.
- **`ETIMEDOUT`, `ECONNREFUSED`, `self-signed certificate in certificate chain`, or a
  proxy error:** the user's network blocks or intercepts the npm registry. Do not disable
  TLS verification to work around it. Use path 4B, or ask the user for their corporate
  proxy settings.

Record the absolute path you will put in the config:

```bash
command -v npx   # e.g. /opt/homebrew/bin/npx
```

**Note the version-floating trade-off, and tell the user.** Unpinned, `npx` resolves the
newest release whenever its cache misses, so behaviour can change between client
restarts. Pin it in the config — `"@zenixsolutions/netbox-mcp@0.2.0"` — if the user wants
a fixed version. Use whatever `--version` just printed, not the literal string above.

### 4B. From a clone (contributors, blocked registry)

The repository is **public** — no GitHub account or authentication is required to clone
it.

```bash
mkdir -p ~/mcp-servers
cd ~/mcp-servers
git clone https://github.com/ZenixSolutions/netbox-mcp-server.git
cd netbox-mcp-server
npm ci
npm run build
```

- **Run these in a shell with no `NETBOX_TOKEN` exported.** `npm ci` executes the install
  scripts of every package in the dependency tree, and each one inherits your
  environment. Do not export the token until section 7.3, and never write it into
  `~/.zshrc` or any other shell profile.
- **If `git` is not installed**, see step 3.2.
- **If the clone fails with a proxy or TLS error**, the user is likely behind a corporate
  proxy. Ask them for the proxy URL and set `git config --global http.proxy <url>`, or
  have them download the ZIP from the repository's **Code → Download ZIP** button and
  unpack it to `~/mcp-servers/netbox-mcp-server`.
- **If the clone prompts for credentials**, something is wrong — a public repo over HTTPS
  never prompts. Check the URL for typos.
- `npm ci` installs exactly the versions in `package-lock.json`. Use it rather than
  `npm install`. If it fails because there is no lockfile, fall back to `npm install`.
- `npm run build` runs `tsc` and writes `dist/`. **On success it prints only the two npm
  banner lines and nothing else** — verified:

  ```
  > @zenixsolutions/netbox-mcp@0.2.0 build
  > tsc
  ```

  If it reports TypeScript errors, the checkout is broken or modified; re-clone rather
  than trying to fix `src/`.

- **`NODE_ENV=production` breaks the build.** `npm ci` honours it and omits
  devDependencies — `typescript` is one of them. Verified: with `NODE_ENV=production`,
  `npm ci` still **exits 0**, so it looks like it worked, but `node_modules/typescript`
  is not installed and the only binary linked into `node_modules/.bin/` is `node-which`.
  `npm run build` then has no local `tsc`. Re-run as `NODE_ENV=development npm ci`, then
  `npm run build`. (The exact failure text `npm run build` prints in that state could not
  be captured here, because the verification machine had an unrelated global `tsc` on its
  PATH that masked it. Report whatever you actually see.)

Confirm the build produced a working entry point, and note the absolute paths — you need
both in section 6:

```bash
test -f dist/index.js && echo "BUILD OK"
node dist/index.js --version    # verified: prints 0.2.0
pwd                             # e.g. /Users/alice/mcp-servers/netbox-mcp-server
command -v node                 # e.g. /opt/homebrew/bin/node
```

If `node dist/index.js --version` prints `Cannot find module`, the build did not produce
that file — re-run `npm run build` and read its output.

To update a clone later: `git pull && npm ci && npm run build`, then restart the AI
client. On the `npx` path there is nothing to update unless the config pins a version, in
which case edit the pin and restart the client.

---

## 5. The command-line surface

The binary is normally launched by a client, but it has four verbs. **These are your only
verification tools — use them instead of hand-rolling a JSON-RPC pipe.**

Write `npx -y @zenixsolutions/netbox-mcp` where the table says `netbox-mcp`, or
`node dist/index.js` from a clone.

| Command                   | Does                                                                                      | Exit code                       |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| `netbox-mcp --help`       | Prints usage and every environment variable the server reads. Reads no configuration.     | 0                               |
| `netbox-mcp --version`    | Prints the version. Verified: `0.2.0`.                                                    | 0                               |
| `netbox-mcp --check`      | Validates configuration; names the first missing or invalid variable. Contacts nothing.   | **0** usable, **78** not usable |
| `netbox-mcp --list-tools` | Prints the 5 tool names to stdout, `5 tools registered.` to stderr. Needs no credentials. | 0                               |

Any other argument, or no argument at all, starts the server on stdio. There is no
`--verbose`, no `--config`, and no `--port`; do not pass flags that are not in this table.

### 5.1 `--help`

Verified output, in full:

```
netbox-mcp-server v0.2.0

MCP server exposing the NetBox REST API to an AI assistant.

Usage:
  netbox-mcp                Run the server on stdio (the normal mode).
  netbox-mcp --check        Validate configuration and exit. 0 = usable, 78 = not.
  netbox-mcp --list-tools   Print every registered tool name and exit.
  netbox-mcp --version      Print the version and exit.
  netbox-mcp --help         Print this message and exit.

Required environment variables and credential source:
  NETBOX_URL         Base URL of the NetBox instance, e.g. https://netbox.example.com
  NETBOX_TOKEN       Inline NetBox API token (set exactly one token source)
  NETBOX_TOKEN_FILE  Readable regular file containing the token (set exactly one token source)

Optional environment variables:
  NETBOX_INSECURE     Set to 1/true/yes to disable TLS certificate verification.
                      This exposes the token to anyone able to intercept the
                      connection. Prefer installing your internal root CA.

NETBOX_TOKEN_FILE is read before every NetBox request so token rotation takes
effect without restart. File paths and token values are never reported.

Write access is controlled by the NetBox token, not by this server. Create
the token with 'write enabled' unchecked, and constrain its object
permissions, if the assistant should not be able to change anything. That
is enforced by NetBox, where no tool argument can reach it.

Transport: stdio only. This binary is launched as a subprocess by an
MCP-aware client (Claude Desktop, Claude Code, Cursor, Codex, ...).
```

Note what that list does **not** contain: there is no `NETBOX_READONLY` and no
`NETBOX_TOOL_GROUPS`. `--help` is the authoritative list of variables the server reads.

**`--help` cannot diagnose a configuration problem.** It returns before any configuration
is read, so it prints the identical text whether the credentials are correct, wrong, or
absent. Prefixing it with `NETBOX_URL=... NETBOX_TOKEN=...` changes nothing. Use
`--check` — that is the verb that reads the configuration.

### 5.2 `--check`

```bash
NETBOX_URL="$NETBOX_URL" NETBOX_TOKEN="$NETBOX_TOKEN" \
  npx -y @zenixsolutions/netbox-mcp --check      # clone path: node dist/index.js --check
echo "exit=$?"
```

All four outcomes below were produced by running the command:

- **Exit 0** — the configuration is usable. With `NETBOX_URL=https://x.invalid` and
  `NETBOX_TOKEN=x`, it printed on stdout:

  ```
  ok: netbox-mcp-server v0.2.0 configured for https://x.invalid
  ```

  Note that `https://x.invalid` does not resolve and the token is nonsense, and `--check`
  still passed. **`--check` does not contact NetBox and does not validate the token.** It
  checks that `NETBOX_URL` and exactly one credential source are present, that a token file is readable and non-empty when used, and that the URL parses. Section 7.3 is what
  proves the credentials work.

- **Exit 78**, with `NETBOX_URL` unset:

  ```
  Missing required environment variable NETBOX_URL. Set it to the base URL of your NetBox instance, e.g. https://netbox.example.com
  ```

- **Exit 78**, with both token sources unset:

  ```
  Missing NetBox credential. Set exactly one of NETBOX_TOKEN or NETBOX_TOKEN_FILE.
  ```

- **Exit 78**, with both token sources set:

  ```
  NETBOX_TOKEN and NETBOX_TOKEN_FILE are mutually exclusive. Set exactly one.
  ```

- **Exit 78**, with an unreadable, non-file, or empty `NETBOX_TOKEN_FILE`: the error names `NETBOX_TOKEN_FILE` and the condition without printing its path or contents.

- **Exit 78**, with `NETBOX_URL=notaurl`:

  ```
  NETBOX_URL is not a valid URL. Expected a base URL like https://netbox.example.com without userinfo, a query, or a fragment.
  ```

  Fix the value; it must look like `https://netbox.theircompany.com`.

All configuration failure messages go to **stderr**; the `ok:` line goes to stdout.

With `NETBOX_INSECURE=1` also set, `--check` still exits 0 and additionally prints to
stderr:

```
warning: NETBOX_INSECURE is set — TLS certificate verification is disabled.
```

Report that warning to the user. It is not an error, but it is a security downgrade they
should have chosen deliberately.

### 5.3 `--list-tools`

Verified, with no `NETBOX_URL` or `NETBOX_TOKEN` in the environment at all:

```
netbox_global_search
netbox_discover
netbox_describe
netbox_read
netbox_write
```

on stdout, plus `5 tools registered.` on stderr, exit 0.

**The count is always 6.** It does not vary with the environment, the NetBox version, or
the plugins installed — the five tools are registered statically, and the instance schema
is only consulted when a tool is _called_. If you ever see a number other than 6, you are
not running `0.2.0`.

### 5.4 Running the server directly

Starting it with no arguments and no configuration exits **78** with the same
`Missing required environment variable NETBOX_URL` message. With configuration present it
prints `netbox-mcp-server v0.2.0 running on stdio` to stderr and then waits for JSON-RPC
on stdin — both verified. Do not leave a bare server running in your shell; it is the
client's job to launch it.

---

## 6. Configure the AI client

This step is a **hand edit of a JSON or TOML file**. There is no installer to do it for
you; the one that existed was deleted because it told users the install was "read-only"
when nothing enforced that, and left a world-readable copy of the token behind. Do not
recreate it, and do not repeat any claim of that shape.

**Rules that apply to every client:**

- Use the absolute path to `npx` — or to `node`, on the clone path (see 6.0 below).
- On the clone path, use the **absolute** path to `dist/index.js` too. Tildes (`~`) are
  **not** expanded by MCP clients.
- **Set `NETBOX_URL` and exactly one of `NETBOX_TOKEN` or `NETBOX_TOKEN_FILE`, plus — if section 3.5 found an internal CA — `NETBOX_INSECURE`.** The file source must be a readable regular file and is read before every request, so rotation takes effect without restart. Anything else in the `env` block is ignored by the server. In particular, do not write `NETBOX_READONLY` or `NETBOX_TOOL_GROUPS`: they do nothing, and their presence misleads the next person who reads the file into thinking writes are restricted.
- **Never write the token into a shell profile**, a script, or any file other than this
  config or a dedicated token file. Never write the token-file contents into the client config.
- **This is a MERGE, not an overwrite.** The user almost certainly has other MCP servers
  configured. Read the existing file, add one key, write it back. Never write one of the
  templates below verbatim over an existing file — you would silently delete every other
  server they have.
- **Back it up first**, then validate before you consider the step done. A malformed
  config makes the client drop _all_ MCP servers, not just this one, which is a
  maddening failure to debug.

```bash
# Set this once to the config path for the user's client, from the section below.
CONFIG_PATH="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
BACKUP="$CONFIG_PATH.bak"

# 1. Back up (only if it already exists), and lock the copy down: it contains
#    every token in the user's config, and the default mode is world-readable.
[ -f "$CONFIG_PATH" ] && cp "$CONFIG_PATH" "$BACKUP" && chmod 600 "$BACKUP"

# 2. ... make your edit ...

# 3. Validate
python3 -m json.tool < "$CONFIG_PATH" > /dev/null && echo "JSON OK"

# 4. The file now contains an API token. The client created it world-readable.
chmod 600 "$CONFIG_PATH"

# 5. Once step 3 has printed JSON OK, delete the backup — it is a second copy of
#    the token that nothing will ever clean up.
rm -f "$BACKUP"
```

If step 3 fails, restore the backup immediately (`cp "$BACKUP" "$CONFIG_PATH"`) and try
again — do not leave a broken config in place, and do not delete the backup until the
validation passes.

### 6.0 Which `command` path to use

```bash
command -v npx    # npx path (section 4A) — e.g. /opt/homebrew/bin/npx
command -v node   # clone path (section 4B) — e.g. /opt/homebrew/bin/node
```

Use that **exact absolute path** as `command` in every template below. It is typically
under `/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin` on Intel, but under a
version manager it will be something under `~/.nvm`, `~/.volta`, etc. — and in that case
the absolute path is mandatory, not merely preferred (see 3.4). Do not copy the example
paths in the templates below; substitute what the command actually returned.

### 6.1 Claude Desktop (macOS)

Config path:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

On Windows it is `%APPDATA%\Claude\claude_desktop_config.json`.

Create it if it does not exist. Add **only** this one entry inside the existing
`mcpServers` object, leaving every other server in place.

**`npx` path (section 4A):**

```json
"netbox": {
  "command": "ABSOLUTE_PATH_FROM_COMMAND_V_NPX",
  "args": ["-y", "@zenixsolutions/netbox-mcp"],
  "env": {
    "NETBOX_URL": "https://netbox.theircompany.com",
    "NETBOX_TOKEN": "PASTE_TOKEN_HERE"
  }
}
```

To pin the version, use `"@zenixsolutions/netbox-mcp@0.2.0"` as the second argument,
substituting the version `--version` printed in section 4A.

**Clone path (section 4B):**

```json
"netbox": {
  "command": "ABSOLUTE_PATH_FROM_COMMAND_V_NODE",
  "args": ["/Users/USERNAME/mcp-servers/netbox-mcp-server/dist/index.js"],
  "env": {
    "NETBOX_URL": "https://netbox.theircompany.com",
    "NETBOX_TOKEN": "PASTE_TOKEN_HERE"
  }
}
```

Add `"NETBOX_INSECURE": "1"` to the `env` block **only** if section 3.5 hit an internal
CA, and tell the user what it turns off.

So a file that previously held one server ends up looking like:

```json
{
  "mcpServers": {
    "their-existing-server": { "command": "...", "args": ["..."] },
    "netbox": { "command": "...", "args": ["..."], "env": { "...": "..." } }
  }
}
```

If the file does not exist yet, create it with `{"mcpServers": {"netbox": { ... }}}`.

Then tell the user to **fully quit and reopen Claude Desktop** — Cmd-Q, not just closing
the window. The config is read once at launch.

### 6.2 Codex CLI (OpenAI)

Config path: `~/.codex/config.toml`

```toml
[mcp_servers.netbox]
command = "ABSOLUTE_PATH_FROM_COMMAND_V_NPX"
args = ["-y", "@zenixsolutions/netbox-mcp"]
# Clone path instead:
#   command = "ABSOLUTE_PATH_FROM_COMMAND_V_NODE"
#   args = ["/Users/USERNAME/mcp-servers/netbox-mcp-server/dist/index.js"]

[mcp_servers.netbox.env]
NETBOX_URL = "https://netbox.theircompany.com"
NETBOX_TOKEN = "PASTE_TOKEN_HERE"
```

Note the key is `mcp_servers` (underscore) in TOML, unlike the JSON clients. As with
JSON, add this table to the existing file — do not replace it.

### 6.3 Cursor

Config path: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project). Same JSON
shape as Claude Desktop in 6.1.

### 6.4 Claude Code (CLI)

Have the user paste the token into a variable without echoing it, register the server,
then clear the variable. Do not put the token in `~/.zshrc`.

```bash
read -rs NETBOX_TOKEN                        # user pastes and presses Enter; nothing is shown
claude mcp add netbox \
  --env NETBOX_URL="https://netbox.theircompany.com" \
  --env NETBOX_TOKEN="$NETBOX_TOKEN" \
  -- "$(command -v npx)" -y @zenixsolutions/netbox-mcp
unset NETBOX_TOKEN
```

On the clone path, replace the last line with
`-- "$(command -v node)" /Users/USERNAME/mcp-servers/netbox-mcp-server/dist/index.js`.

Verify with `claude mcp list` — the `netbox` entry should be listed. Claude Code is
launched from a shell, so it inherits the user's PATH and a bare `npx` would also work
here, but the absolute path stays correct if they later switch Node versions.

### 6.5 ChatGPT and other HTTP-only clients

**This server is stdio-only.** A client that can only reach MCP servers over HTTP or SSE
— which includes ChatGPT's hosted connectors — cannot use it as-is. Say that plainly
rather than improvising a tunnel or a proxy, and offer Claude Desktop, Claude Code,
Cursor or Codex CLI (6.1–6.4) as working alternatives on the same machine.

The ChatGPT **desktop app**'s support for locally-launched stdio servers has changed
repeatedly and differs by plan and OS, so this runbook cannot pin a file format for it.
**Do not guess at one, and do not invent a config file path.** Instead:

1. Have the user open **ChatGPT → Settings** and look for **Connectors**, **Developer
   mode**, or **MCP servers**. Ask them to read you what they see.
2. If there is a UI for adding a local/stdio server, fill it in with the three values you
   already have — they are the same for every client: the absolute `npx` (or `node`)
   path, the arguments, and the `NETBOX_URL` / `NETBOX_TOKEN` environment pair.
3. If the settings offer **only** remote servers, stop, and see the paragraph above.
4. If you have web access and the user wants current support confirmed, consult OpenAI's
   official documentation. Report what it says; do not extrapolate.

---

## 7. Verify the install

### 7.1 Tool registration test (needs neither the client nor NetBox)

`--list-tools` performs a real MCP handshake in-process and prints what a client would
receive. It contacts nothing and **needs no credentials at all** — do not put the user's
token on a command line, where it lands in shell history and is visible in `ps` to every
process on the machine.

```bash
npx -y @zenixsolutions/netbox-mcp --list-tools
```

**Expect exactly the six names from section 5.3, and `5 tools registered.` on stderr.**
From a clone, run `node dist/index.js --list-tools` in the repository directory instead.

- **A count other than 5:** you are running a different version than this file documents.
  Check `--version` before going further.
- **An error instead of a list:** on the `npx` path, re-read section 4A — this is a
  registry or network problem, not a configuration one. On the clone path,
  `Cannot find module` means the build is missing; go back to section 4B.

This says nothing about whether the credentials work. Sections 7.2 and 7.3 do that.

### 7.2 Configuration test

```bash
NETBOX_URL="$NETBOX_URL" NETBOX_TOKEN="$NETBOX_TOKEN" \
  npx -y @zenixsolutions/netbox-mcp --check; echo "exit=$?"
```

Expect `ok: netbox-mcp-server v0.2.0 configured for <their URL>` and `exit=0`. Exit 78
means the configuration is unusable and the message names the variable — see section 5.2
for all four outcomes.

Two limits, both verified in 5.2: this validates the variables **in your shell**, not the
config file you wrote in section 6, and it does not contact NetBox, so a bad token still
passes.

### 7.3 Live credential test

This is the first step that proves the token works. Have the user paste it into a shell
variable without echoing it, so it stays out of history. Do not add it to any shell
profile, and unset it when you are done.

```bash
read -rs NETBOX_TOKEN && export NETBOX_TOKEN      # user pastes, presses Enter; nothing is shown
curl -sS -H "Authorization: Token $NETBOX_TOKEN" \
  "$NETBOX_URL/api/dcim/sites/?limit=1" | head -c 300
```

Expect JSON with a `count` field. (The exact response depends on the user's instance and
could not be captured while writing this file — report what you see.)

- `{"detail":"Invalid token."}` — bad, expired, or revoked token.
- `{"detail":"Authentication credentials were not provided."}` — the variable is empty;
  the paste did not take.
- HTML instead of JSON — `NETBOX_URL` points at something that is not NetBox, or at a
  login portal / SSO proxy in front of it.

Also confirm the token can read the schema document, since every tool except
`netbox_global_search` depends on it:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Token $NETBOX_TOKEN" \
  "$NETBOX_URL/api/schema/?format=json"
```

Expect `200`. A `401`/`403` means the token was rejected for the schema endpoint; a `404`
means the NetBox is too old to expose `/api/schema/` and this server cannot work against
it. Those are the server's own diagnoses of those status codes.

### 7.4 End-to-end test in the client

Have the user restart their AI client and ask it: **"Using the netbox tools, list the
first 5 sites."** A correct install returns real site names from the company's NetBox.

Then `unset NETBOX_TOKEN` in your shell — it is in the client config now and does not
need to live anywhere else.

---

## 8. Using the five tools correctly

This section is for the assistant that will _use_ the server after you install it, and
for you if you are verifying it in 7.4. The five tools are layered; calling them out of
order is the main way this server gets used badly.

### 8.1 The shortcut: when the user named a _thing_

If the request contains a specific identifier — a hostname, a partial name, an IP, a
prefix, a VLAN name, a serial — start with **`netbox_global_search`**. One call searches
sites, racks, devices, interfaces, prefixes, IP addresses, VLANs, VRFs and inventory
assets at once, and returns each hit's numeric id, which is exactly what `netbox_read`
(`operation='get'`) and `netbox_write` need. Going discover → describe → read to look up
one named object costs three calls and answers the same question.

If you already know the type key and just want a filtered list, call **`netbox_read`**
directly. A wrong key comes back with near-misses, so guessing a plausible one costs no
more than looking it up first.

### 8.2 The layer order, and when you actually need it

1. **`netbox_discover`** — when you do not know the object type key. Required for plugin
   models: `plugins.<plugin>.<model>` keys cannot be guessed. Optional otherwise.
2. **`netbox_describe`** — before any write, and whenever you need filter or field names
   you cannot guess. It reports required fields, optional fields with their exact enum
   values, the read-only fields you must not send, and the object types that must already
   exist.
3. **`netbox_read`** — `list` (with `filters`, `limit`, `offset`) or `get` (by `id`).
4. **`netbox_write`** — `create`, `update` or `delete`.

`netbox_describe` before `netbox_write` is not optional courtesy — `netbox_write`
validates `data` against the instance's schema locally and refuses to send a call that
does not match, returning the same description you would have got from `describe`. You
pay for it either way; paying first is cheaper.

### 8.3 Writes cost several calls. Say so.

**A single write is realistically three to five tool calls**, not one:

- find or confirm the object type (`discover`, or skip if you know it),
- learn the fields (`describe`),
- resolve every reference to a numeric id — a device needs its site, device type and role
  to exist and be looked up (`read` or `global_search`, once per reference),
- then `write`.

Do not promise the user a one-step change, and do not batch-create a rack full of devices
without warning them how many calls that is. References are **ids**, never display names.

### 8.4 Filters are slugs or ids, not display names

Filter devices by `site='dc1'` (the slug) or `site_id=3`, not `site='DC 1'`. An unknown
filter _name_ is rejected by the server before anything is sent — deliberately, because
NetBox silently ignores query parameters it does not recognise and would return the whole
unfiltered collection as though the filter had applied. A known filter with a bad _value_
is NetBox's to judge, and it answers 400 naming the valid choices.

Lists are paginated: default page size 50, maximum 1000. The `total` is reported whatever
the limit, so `limit=1` is enough to count something. Long responses are truncated with
the offset to resume from — paginate or filter rather than raising `limit`.

### 8.5 Deleting requires echoing the object's `display`

`netbox_write` with `operation='delete'` requires a `confirm` argument **equal to the
object's current `display` value**. The flow is:

1. `netbox_read` with `operation='get'` and the id;
2. copy the `display` field from the response verbatim;
3. **confirm with the human**, in words, naming the object;
4. `netbox_write` with `operation='delete'`, the id, and `confirm="<that display value>"`.

Calling delete without `confirm` returns the object's current display value and refuses.
A mismatch also refuses and shows both values — that usually means the id is wrong or the
object changed, so re-read it rather than retrying with a guess.

**Deletes cascade and cannot be undone.** Removing a site can remove its racks, devices
and prefixes. The `confirm` gate exists to force a read-then-delete, not to make deleting
safe.

### 8.6 What happens when the token cannot write

Nothing in the server prevents a write attempt. If the token has `write_enabled` off, or
lacks the object permission, **NetBox** answers `403 Forbidden` and the tool surfaces
that error. That is the intended, correct behaviour — not a bug and not a
misconfiguration. Report it to the user as "your token is not permitted to change this",
and do not attempt to work around it.

---

## 9. Troubleshooting

| Symptom                                                                | Cause                                                        | Fix                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client shows no netbox tools at all                                    | Client not restarted                                         | Fully quit (Cmd-Q) and reopen                                                                                                                                                   |
| Client shows no netbox tools; other MCP servers also vanished          | Malformed JSON in the config                                 | Validate with `python3 -m json.tool`                                                                                                                                            |
| `spawn npx ENOENT` / `spawn node ENOENT` in client logs                | GUI app can't find `npx`/`node` on your PATH                 | Use the absolute path from `command -v npx` in the config — see 3.4                                                                                                             |
| `E404 Not Found - @zenixsolutions/netbox-mcp`                          | Name misspelled, or a registry that does not carry it        | Check the spelling; otherwise build from a clone — section 4B                                                                                                                   |
| `Cannot find module '.../dist/index.js'`                               | Clone path: not built, or wrong path in config               | `npm run build`; confirm path with `pwd`                                                                                                                                        |
| `npm run build` cannot find `tsc`                                      | `NODE_ENV=production` made `npm ci` skip devDependencies     | `NODE_ENV=development npm ci && npm run build` — see 4B                                                                                                                         |
| `Missing required environment variable NETBOX_URL`                     | Env block absent or misspelled in config                     | Check the `env` object; names are case-sensitive. Reproduce with `--check`, which names the variable and exits 78                                                               |
| `{"detail":"Invalid token."}`                                          | Wrong/expired/revoked token                                  | Create a new one in NetBox                                                                                                                                                      |
| `403 Forbidden` on a create/update/delete                              | Token has write disabled, or lacks the object permission     | This is NetBox enforcing the token. Expected if intentional; otherwise widen the token's permissions in NetBox. There is no server-side setting to change                       |
| A write "should have been blocked" but went through                    | The token permits it. The server has no read-only mode       | Fix the token in NetBox (untick "Write enabled", or narrow object permissions). Do not add env vars — none of them gate writes                                                  |
| Tool errors mentioning `/api/schema/`, or `401`/`403` on schema fetch  | Token rejected for the schema document                       | Confirm with the second `curl` in 7.3; the schema is needed by every tool except `netbox_global_search`                                                                         |
| Tool errors saying NetBox is too old to expose `/api/schema/`          | `404` on the schema endpoint                                 | This server derives its whole object surface from that document and cannot work without it. Report the NetBox version to the user                                               |
| A filter was rejected with "has no such filter"                        | That name is not accepted by this instance                   | Call `netbox_describe` with `operation="list"` for the accepted names. The request was deliberately not sent — see 8.4                                                          |
| `ETIMEDOUT` / `ENOTFOUND`                                              | NetBox is internal-only                                      | Connect to the corporate VPN                                                                                                                                                    |
| `unable to verify the first certificate` / `SELF_SIGNED_CERT_IN_CHAIN` | Internal CA                                                  | Install the corporate root CA (best), or set `NETBOX_INSECURE=1` (weakens security — see section 11)                                                                            |
| `git clone` fails behind a proxy                                       | Corporate proxy intercepting TLS                             | Set `git config --global http.proxy <url>`, or download the ZIP from the repo's Code button                                                                                     |
| `npm ci` fails with `EACCES`                                           | A previous `sudo npm` left root-owned files in the npm cache | **Stop and hand this to the user** — it needs root, which you must not use. Tell them to run `sudo chown -R "$(whoami)" ~/.npm` in their own Terminal, then say when it is done |

**Reading client logs.** Claude Desktop writes per-server logs to
`~/Library/Logs/Claude/mcp-server-netbox.log`. Read that file first when a server fails
to appear — the actual Node error is almost always in it.

---

## 10. Non-macOS

The server itself is cross-platform; only the dependency steps differ.

- **Windows:** `winget install OpenJS.NodeJS.LTS` (and `winget install Git.Git` only for
  the clone path). Claude Desktop config lives at
  `%APPDATA%\Claude\claude_desktop_config.json`. Paths in the config must use escaped
  backslashes (`"C:\\Users\\..."`) or forward slashes. The `command` is the absolute path
  to `npx.cmd`, from `where npx`.
- **Linux:** install Node 20.11+ from NodeSource or your distro (`apt install nodejs npm`,
  `dnf install nodejs`); verify with `node --version`, since distro packages are often
  older than 20.11. There is no official Claude Desktop build for Linux; use Claude Code
  (6.4), Cursor (6.3), or Codex CLI (6.2). **Never create
  `~/Library/Application Support/` on Linux** — that is a macOS-only path, and a config
  written there is read by nothing.

Sections 3.1–3.3 are macOS-specific. Everything from section 4 onward is cross-platform
apart from those config paths; the commands in sections 4, 5, 7 and 8 are identical.

---

## 11. Environment variable reference

This is the complete list. `--help` (section 5.1) is the authoritative source, and it
names these four and no others.

| Variable            | Required | Default | Meaning                                                                                                                     |
| ------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NETBOX_URL`        | **yes**  | —       | Base URL, no `/api` suffix. A trailing `/` or `/api` is stripped automatically. Must parse as a URL, or `--check` exits 78. |
| `NETBOX_TOKEN`      | one of   | —       | Inline NetBox API token. Its permissions are the only thing that limits what the assistant can do.                          |
| `NETBOX_TOKEN_FILE` | one of   | —       | A readable regular file containing the token. It is mutually exclusive with `NETBOX_TOKEN` and read before every request.   |
| `NETBOX_INSECURE`   | no       | off     | Disables TLS certificate verification for every call to NetBox, including the token-bearing ones. See the warning below.    |

Boolean variables are true for `1`, `true`, `yes`, `y`, or `on` (case-insensitive, after
trimming whitespace). Every other value, including an empty string, is false.

`NETBOX_TOKEN_FILE` is for a server-side secret mount, not a tool argument or result. Its path and contents are never reported. Missing, unreadable, non-file, and empty token files fail closed; normal line-ending whitespace is trimmed. The file is read on each NetBox request, so a secret-manager rotation is used without restart.

⚠️ **`NETBOX_INSECURE=1` turns off certificate verification entirely.** Anyone able to
intercept the connection can present their own certificate and read the API token. Use it
only for an on-prem NetBox behind an internal CA, only when the user has chosen it
knowingly, and tell them the correct fix is installing the corporate root CA into the
system trust store.

**`NETBOX_READONLY` and `NETBOX_TOOL_GROUPS` no longer exist.** Setting them has no
effect whatsoever — no error, no warning, nothing. Do not set them, do not suggest them,
and do not describe an install as restricted because one of them is present.

---

## 12. Safety notes to pass on to the user

- **The token is the security boundary, and the only one.** This server does not filter,
  gate, or downgrade writes. If the assistant should not be able to change NetBox, create
  the token with "Write enabled" unchecked and constrain its object permissions. NetBox
  enforces that, and no tool argument can reach past it.
- **Deletes cascade.** Deleting a site can remove its racks, devices and prefixes. NetBox
  has no undo. `netbox_write` requires the caller to echo the object's `display` value as
  `confirm` before it will delete anything (section 8.5), which forces a read first — but
  that is a guard against deleting the _wrong_ object, not a reason to delete casually.
  Confirm with the human first, in words, naming the object.
- **NetBox is a source of truth, not the network.** Writing to it changes documentation,
  not device configuration — but downstream automation may read it and act on it.
- **The tool surface follows the instance.** Which object types exist depends on the
  connected NetBox and its plugins, because it is derived from that instance's own
  schema. Two installs pointed at different instances do not offer the same object types.
- **Tokens must not be committed.** `.env` is gitignored. Config files under
  `~/Library/Application Support/` are outside the repo. They are plaintext, so keep them
  at mode `600` and do not leave `.bak` copies of them lying around.

---

## 13. Done

The install is complete when section 7.4 returns real data from the company's NetBox.
Report back to the user:

- which install path you used (`npx`, pinned or unpinned, or a clone and its path);
- which config file you edited, and that you deleted the backup after validating it;
- the tool count you measured in section 7.1 — it should be 5;
- **whether the token they created can write**, and how you know. If you did not test a
  write, say you did not test a write. Never describe an install as read-only on the
  strength of a config value; nothing in the config makes it so.

You cannot see the client's own view of the tool list — do not claim a number you did not
measure.

If something in this runbook was wrong or out of date, tell the user — the repository is
public and accepts issues at
https://github.com/ZenixSolutions/netbox-mcp-server/issues.
