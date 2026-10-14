import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for whatsync.app, so the whole CLI runs without touching WhatsApp.
const calls: { name: string; input: Record<string, unknown> }[] = [];
const grants: string[] = [];
let challenge = "";
let revoked = "";
let tokenCount = 0;
const device = { started: 0, polls: 0, answer: "approve" as "approve" | "deny" };
const prop = (type: string) => ({ type });
const tools = [
    { name: "get_account_context", description: "Account", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
    { name: "list_conversations", description: "List", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: prop("string"), limit: prop("integer"), cursor: prop("string") } } },
    { name: "get_conversation", description: "Read", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { conversationId: prop("string"), limit: prop("integer") }, required: ["conversationId"] } },
    { name: "send_message", description: "Send", annotations: {}, inputSchema: { type: "object", properties: { idempotencyKey: prop("string"), phoneNumber: prop("string"), conversationId: prop("string"), text: prop("string"), recipientOptInConfirmed: prop("boolean") }, required: ["idempotencyKey"] } },
    { name: "send_group_message", description: "Group", annotations: {}, inputSchema: { type: "object", properties: { idempotencyKey: prop("string"), jid: prop("string"), text: prop("string") }, required: ["idempotencyKey", "jid", "text"] } },
];
const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/oauth/register") return Response.json({ client_id: "client_1" }, { status: 201 });
        if (url.pathname === "/oauth/authorize") {
            challenge = url.searchParams.get("code_challenge")!;
            const back = new URL(url.searchParams.get("redirect_uri")!);
            back.search = new URLSearchParams({ code: "code_1", state: url.searchParams.get("state")! }).toString();
            return Response.redirect(back.toString(), 303);
        }
        if (url.pathname === "/oauth/token") {
            const form = await request.formData();
            grants.push(String(form.get("grant_type")));
            if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
                device.polls++;
                if (device.answer === "deny") return Response.json({ error: "access_denied" }, { status: 400 });
                if (device.polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
            }
            if (form.get("grant_type") === "authorization_code") {
                const verifier = String(form.get("code_verifier"));
                if (createHash("sha256").update(verifier).digest("base64url") !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            tokenCount++;
            return Response.json({ access_token: `at_${tokenCount}`, refresh_token: `rt_${tokenCount}`, expires_in: 3600, scope: "whatsapp.messages:read whatsapp.messages:send" });
        }
        if (url.pathname === "/oauth/device_authorization") {
            const form = await request.formData();
            if (form.get("client_id") !== "client_1") return Response.json({ error: "invalid_client" }, { status: 401 });
            device.polls = 0;
            return Response.json({ device_code: `dc_${++device.started}`, user_code: "BCDF-GHJK", verification_uri: `${url.origin}/device`, verification_uri_complete: `${url.origin}/device?code=BCDF-GHJK`, expires_in: 600, interval: 1 });
        }
        if (url.pathname === "/oauth/revoke") { revoked = String((await request.formData()).get("token")); return new Response(null); }
        if (!request.headers.get("authorization")?.startsWith("Bearer at_")) return Response.json({ error: "invalid_token" }, { status: 401 });
        if (url.pathname === "/api/agent/tools") return Response.json({ tools });
        const name = url.pathname.split("/").pop()!;
        const input = await request.json() as Record<string, unknown>;
        calls.push({ name, input });
        const data = name === "list_conversations" ? { conversations: [{ conversation_id: "919876543210@s.whatsapp.net", contact_name: "Ravi", last_message_at: "2026-10-13T05:00:00.000Z" }], has_more: false }
            : name === "get_conversation" ? { conversation_id: input.conversationId, messages: [{ direction: "inbound", contact_name: "Ravi", text: "Hi", sent_at: "2026-10-13T05:00:00.000Z" }] }
            : name === "get_account_context" ? { account_email: "test@example.com", connection: { status: "connected", type: "qr", phone_number: "15550000001" } }
            : { status: "accepted", intent_id: "intent_1" };
        return Response.json({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
    },
});

const configDir = mkdtempSync(join(tmpdir(), "whatsync-cli-test-"));
const env = { ...process.env, WHATSYNC_URL: `http://127.0.0.1:${server.port}`, WHATSYNC_CONFIG_DIR: configDir, NO_COLOR: "1", BROWSER: "none" };
delete (env as Record<string, string | undefined>).WHATSYNC_API_KEY;
// CLI_BIN=dist/whatsync.js runs the built file under Node, the way customers run it.
const runner = process.env.CLI_BIN ? ["node", join(import.meta.dir, "..", process.env.CLI_BIN)] : ["bun", join(import.meta.dir, "../src/index.ts")];

async function cli(args: string[]) {
    const child = Bun.spawn([...runner, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
}

beforeAll(async () => {
    // Plays the browser: open the printed sign-in address and follow it back to the CLI.
    const child = Bun.spawn([...runner, "login", "--browser"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const reader = child.stderr.getReader();
    let output = "";
    while (!output.includes("/oauth/authorize")  || !/authorize\?\S+\n/.test(output)) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
    }
    const address = output.match(/(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+)/)![1];
    // A forged callback (wrong state) is turned away and the real sign-in still completes.
    const callback = new URL(new URL(address).searchParams.get("redirect_uri")!);
    callback.search = "code=forged&state=wrong";
    expect((await fetch(callback)).status).toBe(400);
    const page = await fetch(address);
    expect(await page.text()).toContain("You are signed in");
    expect(await child.exited).toBe(0);
});
afterAll(() => server.stop(true));

test("login stores a private credential file", () => {
    const file = join(configDir, "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("rt_1");
    expect(grants).toEqual(["authorization_code"]);
});

test("status shows the account", async () => {
    const result = await cli(["status", "--json"]);
    expect(JSON.parse(result.stdout).account_email).toBe("test@example.com");
});

test("read resolves a name to its chat", async () => {
    const result = await cli(["read", "Ravi", "--limit", "5", "--json"]);
    expect(result.code).toBe(0);
    expect(calls.at(-1)).toEqual({ name: "get_conversation", input: { conversationId: "919876543210@s.whatsapp.net", limit: 5 } });
});

test("send writes a message with a fresh idempotency key", async () => {
    const result = await cli(["send", "+91 98765 43210", "Your", "order", "is", "ready", "--json"]);
    expect(result.code).toBe(0);
    const call = calls.at(-1)!;
    expect(call.name).toBe("send_message");
    expect(call.input).toMatchObject({ phoneNumber: "919876543210", text: "Your order is ready" });
    expect(String(call.input.idempotencyKey)).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
});

test("send to a group id uses the group tool", async () => {
    await cli(["send", "120363012345678901@g.us", "Received", "--json"]);
    expect(calls.at(-1)).toMatchObject({ name: "send_group_message", input: { jid: "120363012345678901@g.us", text: "Received" } });
});

test("any tool runs by name with schema-typed options", async () => {
    await cli(["send-message", "--phone-number", "15550000001", "--text", "hi", "--recipient-opt-in-confirmed"]);
    expect(calls.at(-1)?.input).toMatchObject({ phoneNumber: "15550000001", text: "hi", recipientOptInConfirmed: true });
    const bad = await cli(["send-message", "--colour", "red"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Unknown option --colour");
});

test("an expired sign-in refreshes itself", async () => {
    const file = join(configDir, "credentials.json");
    const store = JSON.parse(readFileSync(file, "utf8"));
    for (const profile of Object.values(store.profiles) as { session: { expiresAt: number } }[]) profile.session.expiresAt = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(store));
    const result = await cli(["chats", "--json"]);
    expect(result.code).toBe(0);
    expect(grants.at(-1)).toBe("refresh_token");
    expect(readFileSync(file, "utf8")).toContain("rt_2");
});

test("a plain http server address is refused so tokens never travel unencrypted", async () => {
    const child = Bun.spawn([...runner, "chats"], { env: { ...env, WHATSYNC_URL: "http://whatsync.example.com" }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("must start with https://");
});

test("on a server, login shows a code and finishes once it is approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "whatsync-cli-device-"));
    const child = Bun.spawn([...runner, "login", "--no-browser"], { env: { ...env, WHATSYNC_CONFIG_DIR: dir }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("BCDF-GHJK");
    expect(stderr).toContain("/device");
    expect(device.polls).toBe(2);
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toContain("at_");
});

test("a code cancelled on whatsync.app stops the login", async () => {
    device.answer = "deny";
    const dir = mkdtempSync(join(tmpdir(), "whatsync-cli-device-"));
    const child = Bun.spawn([...runner, "login", "--no-browser"], { env: { ...env, WHATSYNC_CONFIG_DIR: dir }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    device.answer = "approve";
    expect(code).toBe(1);
    expect(stderr).toContain("cancelled");
});

test("logout revokes the grant and forgets it", async () => {
    const result = await cli(["logout"]);
    expect(result.stderr).toContain("Signed out");
    expect(revoked).toBe("rt_2");
    const after = await cli(["chats"]);
    expect(after.code).toBe(1);
    expect(after.stderr).toContain("whatsync login");
});
