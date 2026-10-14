import { existsSync, readFileSync } from "node:fs";
import { baseUrl, hasSession, login, logout } from "./auth";
import { callTool, clearToolCache, findTool, listTools, type Tool, type ToolResult } from "./api";
import { buildToolInput, kebab, newIdempotencyKey, normalize, parseArgs, toolUsage, type ParsedArgs } from "./args";
import { CliError } from "./errors";
import { bold, clean, dim, printResult, resultData, when } from "./format";

const VERSION = "0.2.0";
process.env.WHATSYNC_CLI_VERSION = VERSION;

const GLOBAL_FLAGS = new Set(["json", "help", "version", "nobrowser", "browser", "yes"]);
const log = (line = "") => process.stderr.write(`${line}\n`);

const HELP = `WhatSync CLI ${VERSION}
Use your WhatsApp from the terminal, or let Claude Code, Codex or any AI agent use it.

Get started
  whatsync login                     Sign in with your browser
  whatsync status                    Show the connected WhatsApp account

Everyday commands
  whatsync chats [name or number]    List recent chats
  whatsync read <name, number or id> Read the latest messages in a chat
  whatsync search <words>            Search all your messages
  whatsync unanswered                Chats waiting for your reply
  whatsync send <number or id> <message>
                                     Send a message (group ids end in @g.us)
  whatsync groups                    List your groups
  whatsync contacts [name or number] Find a contact

Every WhatSync tool is also a command
  whatsync tools                     List all tools (send images, polls, templates, campaigns...)
  whatsync help <tool>               Show a tool's options
  whatsync <tool> --option value     Run it, e.g. whatsync send-image --phone-number 919876543210 --url https://...

Options
  --json          Print raw JSON (this is automatic when output is piped)
  --no-browser    Sign in with a code (automatic on servers, containers and SSH)
  -h, --help      Show help

More: https://www.npmjs.com/package/whatsync
`;

/** Shortcut commands mapped onto tools, so the everyday ones read naturally. */
const SHORTCUTS: Record<string, { tool: string; usage: string; positional?: (args: string[], tool: Tool) => Promise<Record<string, unknown>> | Record<string, unknown> }> = {
    chats: { tool: "list_conversations", usage: "whatsync chats [name or number] [--limit 20]", positional: a => (a.length ? { query: a.join(" ") } : {}) },
    search: {
        tool: "search_messages", usage: "whatsync search <words> [--conversation-id <id>] [--limit 20]",
        positional: a => {
            if (!a.length) throw new CliError("What should I search for? Example: whatsync search invoice");
            return { query: a.join(" ") };
        },
    },
    unanswered: { tool: "list_unanswered_conversations", usage: "whatsync unanswered [--limit 20]" },
    groups: { tool: "list_groups", usage: "whatsync groups" },
    contacts: { tool: "list_contacts", usage: "whatsync contacts [name or number]", positional: a => (a.length ? { query: a.join(" ") } : {}) },
    read: { tool: "get_conversation", usage: "whatsync read <name, number or chat id> [--limit 20]", positional: a => resolveConversation(a.join(" ")) },
    send: {
        tool: "send_message", usage: "whatsync send <number or chat id> <message>   (use - as the message to read it from stdin)",
        positional: a => {
            const [to, ...words] = a;
            if (!to) throw new CliError("Who should I send to? Example: whatsync send 919876543210 \"Hi, your order is ready\"");
            const text = words.length === 1 && words[0] === "-" ? undefined : words.join(" ");
            const input: Record<string, unknown> = /@/.test(to) ? { conversationId: to } : { phoneNumber: to.replace(/[\s()+-]/g, "") };
            if (words.length) input.text = text ?? readStdin();
            return input;
        },
    },
};

/** No browser can open here: an SSH session, a container, or Linux with no screen. */
function likelyHeadless() {
    if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.CI) return true;
    if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
    return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function readStdin() {
    return readFileSync(0, "utf8").replace(/\n$/, "");
}

/** Lets people say "whatsync read Ravi" instead of copying a conversation id. */
async function resolveConversation(query: string): Promise<Record<string, unknown>> {
    if (!query) throw new CliError("Which chat? Example: whatsync read Ravi");
    if (/@/.test(query)) return { conversationId: query };
    const digits = query.replace(/[\s()+-]/g, "");
    const result = await callTool("list_conversations", { query: /^\d{7,}$/.test(digits) ? digits : query, limit: 10 });
    if (result.isError) failTool(result);
    const rows = ((resultData(result) as { conversations?: { conversation_id: string; contact_name?: string | null; last_message_at?: string }[] }).conversations ?? []);
    const exact = rows.find(r => r.conversation_id === query || r.conversation_id === digits || r.conversation_id.split("@")[0] === digits || r.contact_name?.toLowerCase() === query.toLowerCase());
    if (exact) return { conversationId: exact.conversation_id };
    if (rows.length === 1) return { conversationId: rows[0].conversation_id };
    if (!rows.length) {
        if (/^\d{7,}$/.test(digits)) return { conversationId: digits };
        throw new CliError(`No chat matches "${query}". Try: whatsync chats`);
    }
    throw new CliError(`More than one chat matches "${query}". Pick one by its id:\n${rows.map(r => `  ${r.contact_name || r.conversation_id}  ${dim(when(r.last_message_at))}  ${r.conversation_id}`).join("\n")}`);
}

function failTool(result: ToolResult): never {
    const data = resultData(result);
    const message = typeof data === "string" ? data
        : String((data as { error?: { message?: string } | string; message?: string }).message
            ?? ((data as { error?: { message?: string } }).error as { message?: string } | undefined)?.message
            ?? (data as { error?: string }).error
            ?? JSON.stringify(data, null, 2));
    throw new CliError(message);
}

async function runTool(tool: Tool, args: ParsedArgs, base: Record<string, unknown> = {}) {
    const input = { ...base, ...buildToolInput(tool, args.flags, GLOBAL_FLAGS) };
    if (tool.inputSchema.properties?.idempotencyKey && !input.idempotencyKey) input.idempotencyKey = newIdempotencyKey();
    if (tool.name === "send_message" && input.conversationId?.toString().endsWith("@g.us")) {
        // Groups have their own send tool on QR accounts.
        const group = await findTool("send_group_message");
        if (group) return runTool(group, { positionals: [], flags: new Map() }, { idempotencyKey: input.idempotencyKey, jid: input.conversationId, text: input.text });
    }
    const json = args.flags.has("json");
    let result: ToolResult;
    try {
        result = await callTool(tool.name, input);
    } catch (error) {
        // A dropped connection can hide a send that went through, so never retry blindly.
        if (error instanceof CliError && input.idempotencyKey && !tool.annotations.readOnlyHint) {
            throw new CliError(`${error.message}\nIt may still have gone through. To retry without sending twice, run the same command with --idempotency-key ${input.idempotencyKey}`);
        }
        throw error;
    }
    if (result.isError) {
        if (json) printResult(result, true);
        failTool(result);
    }
    printResult(result, json);
}

async function status(json: boolean) {
    if (!hasSession()) {
        log(`Not signed in to ${new URL(baseUrl()).host}. Run: whatsync login`);
        process.exitCode = 1;
        return;
    }
    const result = await callTool("get_account_context", {});
    if (result.isError || json || !process.stdout.isTTY) return result.isError ? failTool(result) : printResult(result, true);
    const data = resultData(result) as { account_email?: string; connection?: { type?: string; status?: string; phone_number?: string; display_name?: string }; history?: { message_count?: number; first_message_at?: string } };
    const c = data.connection ?? {};
    console.log(`Signed in as ${bold(data.account_email ?? "unknown")}`);
    console.log(c.status === "connected"
        ? `WhatsApp: ${[c.display_name, c.phone_number].filter(Boolean).join(" ")} (${c.type === "baileys" || c.type === "qr" ? "QR" : c.type === "dual" ? "QR and Business" : "Business"}), connected`
        : `WhatsApp: not connected. Link it at ${baseUrl()}/dashboard`);
    if (data.history?.message_count) console.log(`Messages: ${data.history.message_count.toLocaleString("en-US")} since ${when(data.history.first_message_at)}`);
}

async function printTools(filter: string | undefined, json: boolean) {
    const tools = (await listTools(true)).filter(t => !filter || t.name.includes(filter.replace(/-/g, "_")) || t.description.toLowerCase().includes(filter.toLowerCase()));
    if (json || !process.stdout.isTTY) {
        process.stdout.write(`${JSON.stringify(tools.map(t => ({ name: t.name, command: kebab(t.name), changes_something: !t.annotations.readOnlyHint, description: t.description, input_schema: t.inputSchema })), null, 2)}\n`);
        return;
    }
    const width = Math.max(...tools.map(t => kebab(t.name).length));
    for (const t of tools) console.log(`${kebab(t.name).padEnd(width)}  ${dim(t.title || t.description.split(". ")[0])}`);
    console.log(`\n${dim("Run whatsync help <tool> for options.")}`);
}

async function main(argv: string[]) {
    const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
    const rest = command ? argv.slice(1) : argv;
    const pre = parseArgs(rest, GLOBAL_FLAGS);
    const json = pre.flags.has("json");

    if (pre.flags.has("version") && !command) return console.log(VERSION);
    if (!command || command === "help" && !pre.positionals.length) return process.stdout.write(HELP);

    switch (command) {
        case "login": {
            if (pre.flags.has("help")) return console.log("whatsync login [--no-browser | --browser]\n\nSigns in through your browser. On a server, in a container or over SSH it shows a code\ninstead, which you approve at whatsync.app/device from any phone or computer.\n--no-browser forces the code; --browser forces the browser.");
            const session = await login({ noBrowser: pre.flags.has("nobrowser") || (!pre.flags.has("browser") && likelyHeadless()), log });
            clearToolCache();
            log(`\nSigned in. ${session.scope.includes("send") ? "Sending is allowed." : "Read-only access."}`);
            return status(false).catch(() => undefined);
        }
        case "logout":
            log(await logout() ? "Signed out. This computer can no longer use your WhatsApp." : "You were not signed in.");
            return;
        case "status":
        case "whoami":
            return status(json);
        case "tools":
            return printTools(pre.positionals[0], json);
        case "version":
            return console.log(VERSION);
    }

    if (command === "help") {
        const name = pre.positionals[0];
        const shortcut = SHORTCUTS[name];
        const tool = await findTool(shortcut?.tool ?? name.replace(/-/g, "_"));
        if (!tool) throw new CliError(`No command called "${name}". Run: whatsync tools`);
        if (shortcut) console.log(`${shortcut.usage}\n\nShortcut for "${kebab(tool.name)}". Its options also work here:\n`);
        return console.log(toolUsage(tool));
    }

    const shortcut = SHORTCUTS[command];
    const toolName = shortcut?.tool ?? command.replace(/-/g, "_");
    if (!/^[a-z][a-z0-9_]*$/.test(toolName)) throw new CliError(`Unknown command "${command}". Run: whatsync help`);
    const tool = await findTool(toolName);
    if (!tool) {
        const close = (await listTools()).map(t => t.name).filter(n => n.includes(toolName) || toolName.split("_").some(part => part.length > 3 && n.includes(part))).slice(0, 5);
        throw new CliError(`Unknown command "${command}".${close.length ? ` Did you mean: ${close.map(kebab).join(", ")}?` : ""} Run: whatsync tools`);
    }
    // Parse again now that the tool's yes/no options are known, so they never swallow a word.
    const booleans = new Set([...GLOBAL_FLAGS, ...Object.entries(tool.inputSchema.properties ?? {}).filter(([, s]) => s.type === "boolean").map(([k]) => normalize(k))]);
    const args = parseArgs(rest, booleans);
    if (args.flags.has("help")) {
        if (shortcut) console.log(`${shortcut.usage}\n`);
        return console.log(toolUsage(tool));
    }
    if (!shortcut && args.positionals.length) throw new CliError(`${command} takes options, not words. Run: whatsync help ${command}`);
    const base = shortcut?.positional ? await shortcut.positional(args.positionals, tool) : {};
    return runTool(tool, args, base);
}

main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof CliError) {
        log(clean(error.message));
        process.exitCode = error.exitCode;
        return;
    }
    log(`Unexpected error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
});
