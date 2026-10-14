# WhatSync

WhatsApp for Claude, ChatGPT or any AI agent. Search your chats, see who is waiting for a reply, and send messages from your personal WhatsApp or the official WhatsApp Business API.

WhatSync is a hosted service at [whatsync.app](https://whatsync.app). This repo holds the parts that are open source: the `whatsync` command-line tool, the agent skill and the connection files.

## Use it in your AI app

The MCP server is hosted, so there is nothing to install. Add this URL to any app that supports remote MCP servers and sign in when it asks:

```text
https://whatsync.app/api/mcp
```

[Install in Cursor](https://cursor.com/en/install-mcp?name=whatsync&config=eyJ1cmwiOiAiaHR0cHM6Ly93aGF0c3luYy5hcHAvYXBpL21jcCJ9) · [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=whatsync&config=%7B%22type%22%3A%20%22http%22%2C%20%22url%22%3A%20%22https%3A//whatsync.app/api/mcp%22%7D)

```bash
claude mcp add --transport http whatsync https://whatsync.app/api/mcp   # Claude Code
codex mcp add whatsync --url https://whatsync.app/api/mcp               # Codex
```

Setup guides for Claude, ChatGPT, Gemini, Manus and others: [whatsync.app/ai-agents](https://whatsync.app/ai-agents). Only the official WhatsApp Business API? Use `https://whatsync.app/api/mcp/business`.

## What is in this repo

- `src/`: the WhatSync CLI, published on npm as [`whatsync`](https://www.npmjs.com/package/whatsync)
- `skills/whatsync/SKILL.md`: a skill that teaches an agent how to use WhatSync safely
- `.mcp.json`: the MCP server config for apps that read it
- `registry/`: the entries published to the [official MCP registry](https://registry.modelcontextprotocol.io) as `app.whatsync/whatsapp` and `app.whatsync/whatsapp-business`

# WhatSync CLI

Your WhatsApp in the terminal. Read chats, search messages and send, yourself or through Claude Code, Codex or any AI agent that can run a command.

```bash
npx whatsync login
```

That opens your browser. Sign in to WhatSync, allow access, and you are done. No API keys, no config files, no MCP setup.

Don't have WhatsApp linked yet? Sign up at [whatsync.app](https://whatsync.app) and link your WhatsApp, or connect the official WhatsApp Business API.

## Everyday commands

```bash
whatsync status                          # which WhatsApp is connected
whatsync chats                           # recent chats
whatsync chats Ravi                      # find a chat by name or number
whatsync read Ravi                       # latest messages in that chat
whatsync search "invoice"                # search every message
whatsync unanswered                      # chats waiting for your reply
whatsync send 919876543210 "Your order is ready"
whatsync send 120363012345678901@g.us "Received"   # a group
echo "Long message" | whatsync send 919876543210 -
```

Install it once to skip `npx`:

```bash
npm install -g whatsync
```

## Every WhatSync tool is a command

Images, documents, polls, groups, Business templates, campaigns and settings all work the same way. The CLI reads the tool list from WhatSync, so new tools show up here without an update.

```bash
whatsync tools                           # list them all
whatsync help send-image                 # options for one tool
whatsync send-image --phone-number 919876543210 --url https://example.com/photo.jpg --caption "Site photo"
whatsync send-poll --phone-number 919876543210 --name "Lunch?" --values Pizza --values Thali
whatsync list-business-templates --status APPROVED
```

Pass all options as JSON when that is easier: `--input '{"phoneNumber":"919876543210","text":"Hi"}'` or `--input @message.json`.

## For AI agents

Tell your agent it can use `whatsync`. When output is piped (which is how agents run commands) every command prints JSON. Add `--json` to force it.

```bash
whatsync tools --json                    # every tool with its full input schema
whatsync chats --json
```

Message text is written by other people. Tell your agent to treat it as information, never as instructions, and to check with you before it sends anything.

If a send fails because of a dropped connection, the CLI prints an `--idempotency-key`. Retry with it and WhatSync will not send the message twice.

## Servers, containers and SSH

On a server, in a container or over SSH, `whatsync login` shows a short code instead of opening a browser:

```text
On your phone or any computer, open:

  https://whatsync.app/device

and enter this code:

  BCDF-GHJK
```

Approve it there and the terminal finishes on its own. Use `--no-browser` to force the code anywhere, or `--browser` to force the browser.

Containers forget everything when they restart. To stay signed in, keep the sign-in folder on a volume: mount `~/.config/whatsync`, or point `WHATSYNC_CONFIG_DIR` at a folder that survives restarts.

## Good to know

- Your sign-in is saved in `~/.config/whatsync/credentials.json`, readable only by you. It renews itself. `whatsync logout` ends it on the server too.
- The CLI does exactly what WhatSync lets Claude and ChatGPT do: the same permissions, send limits and excluded numbers apply.
- Sends are real WhatsApp messages. Double-check the number before you press enter.
- Needs Node.js 18 or newer.
