import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";

export const DEFAULT_BASE_URL = "https://whatsync.app";
// Fixed so one registered client keeps working; the first free one is used.
const CALLBACK_PORTS = [53682, 53683, 53684, 53685];
const SCOPES = [
    "whatsapp.messages:read", "whatsapp.messages:send", "whatsapp.messages:manage",
    "whatsapp.settings:manage", "whatsapp.groups:manage", "whatsapp.templates:manage",
    "whatsapp.campaigns:manage", "offline_access",
];

type Session = { accessToken: string; refreshToken: string; expiresAt: number; scope: string };
type Profile = { clientId?: string; session?: Session };
type Store = { profiles: Record<string, Profile> };

export function baseUrl() {
    const value = (process.env.WHATSYNC_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    let url: URL;
    try { url = new URL(value); } catch { throw new CliError(`WHATSYNC_URL is not a valid address: ${value}`); }
    // Sign-ins and messages must never travel unencrypted, except to a server on this computer.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
        throw new CliError("WHATSYNC_URL must start with https://");
    }
    return value;
}

export function configDir() {
    if (process.env.WHATSYNC_CONFIG_DIR) return process.env.WHATSYNC_CONFIG_DIR;
    if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "whatsync");
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "whatsync");
}

const storePath = () => join(configDir(), "credentials.json");

function readStore(): Store {
    try {
        const store = JSON.parse(readFileSync(storePath(), "utf8")) as Store;
        return store && typeof store.profiles === "object" ? store : { profiles: {} };
    } catch {
        return { profiles: {} };
    }
}

function writeStore(store: Store) {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(storePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
    // writeFileSync keeps the mode of an existing file, so tighten it explicitly.
    if (process.platform !== "win32") chmodSync(storePath(), 0o600);
}

function readProfile(): Profile {
    return readStore().profiles[baseUrl()] ?? {};
}

function saveProfile(change: (profile: Profile) => Profile) {
    const store = readStore();
    store.profiles[baseUrl()] = change(store.profiles[baseUrl()] ?? {});
    writeStore(store);
}

export function hasSession() {
    return Boolean(process.env.WHATSYNC_API_KEY || readProfile().session);
}

async function postForm(path: string, body: Record<string, string>) {
    const response = await fetch(`${baseUrl()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
        body: new URLSearchParams(body),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, data };
}

export function userAgent() {
    return `whatsync-cli/${process.env.WHATSYNC_CLI_VERSION || "dev"} node/${process.versions.node}`;
}

function toSession(data: Record<string, unknown>): Session {
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") throw new CliError("Sign-in failed: the server returned no token.");
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
        scope: String(data.scope || ""),
    };
}

/** Returns a usable bearer credential, refreshing the saved login when it is about to expire. */
export async function credential(forceRefresh = false): Promise<string> {
    if (process.env.WHATSYNC_API_KEY) return process.env.WHATSYNC_API_KEY;
    const profile = readProfile();
    if (!profile.session || !profile.clientId) throw new CliError("You are not signed in. Run: whatsync login");
    if (!forceRefresh && profile.session.expiresAt - Date.now() > 60_000) return profile.session.accessToken;
    const refreshed = await postForm("/oauth/token", { grant_type: "refresh_token", refresh_token: profile.session.refreshToken, client_id: profile.clientId });
    if (!refreshed.ok) {
        // Refresh tokens are single use. Another whatsync process may have just rotated it.
        const latest = readProfile().session;
        if (latest && latest.refreshToken !== profile.session.refreshToken && latest.expiresAt - Date.now() > 60_000) return latest.accessToken;
        if (refreshed.status === 400) throw new CliError("Your sign-in has expired. Run: whatsync login");
        throw new CliError(`Could not refresh your sign-in (HTTP ${refreshed.status}). Try again in a moment.`);
    }
    const session = toSession(refreshed.data);
    saveProfile(p => ({ ...p, session }));
    return session.accessToken;
}

async function ensureClient(): Promise<string> {
    const existing = readProfile().clientId;
    if (existing) return existing;
    const response = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
        body: JSON.stringify({
            client_name: "WhatSync CLI",
            redirect_uris: CALLBACK_PORTS.map(port => `http://127.0.0.1:${port}/callback`),
            token_endpoint_auth_method: "none",
        }),
    });
    const data = await response.json().catch(() => ({})) as { client_id?: string; error_description?: string };
    if (!response.ok || !data.client_id) throw new CliError(`Could not start sign-in: ${data.error_description || `HTTP ${response.status}`}`);
    saveProfile(p => ({ ...p, clientId: data.client_id }));
    return data.client_id;
}

function listen(port: number): Promise<Server | null> {
    return new Promise(resolve => {
        const server = createServer();
        server.once("error", () => resolve(null));
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

export function openBrowser(url: string) {
    // BROWSER=none is the usual way to say "print the link, don't open anything".
    if (process.env.BROWSER === "none") return;
    const [command, args] = process.platform === "darwin" ? ["open", [url]]
        : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
    try {
        const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
        child.on("error", () => undefined);
        child.unref();
    } catch { /* The URL is printed as well. */ }
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#f6f4ee;color:#16241d;display:grid;place-items:center;min-height:90vh;margin:0"><div style="max-width:420px;padding:24px;border:1px solid #d9d5c7;background:#fff"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p style="margin:0;line-height:1.5">${body}</p></div>`;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sign-in with a short code, for servers, containers and SSH sessions where a browser
 * cannot call back to this machine. The person approves the code on whatsync.app from
 * any phone or computer while this process waits.
 */
async function loginWithCode(clientId: string, log: (line: string) => void): Promise<Session> {
    const started = await postForm("/oauth/device_authorization", { client_id: clientId, scope: SCOPES.join(" "), resource: `${baseUrl()}/api/mcp` });
    if (!started.ok) {
        if (started.data.error === "invalid_client") saveProfile(p => ({ ...p, clientId: undefined }));
        if (started.status === 404) throw new CliError(`${new URL(baseUrl()).host} does not support sign-in with a code yet. Run whatsync login on a computer with a browser.`);
        throw new CliError(`Could not start sign-in: ${started.data.error_description || started.data.error || `HTTP ${started.status}`}`);
    }
    const device = started.data as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
    log(`On your phone or any computer, open:\n\n  ${device.verification_uri}\n\nand enter this code:\n\n  ${device.user_code}\n`);
    if (device.verification_uri_complete) log(`Or open ${device.verification_uri_complete} to fill it in for you.\n`);
    log(`Waiting for you to allow access. The code expires in ${Math.round((device.expires_in || 600) / 60)} minutes.`);
    let wait = Math.max(1, device.interval || 5) * 1000;
    const deadline = Date.now() + (device.expires_in || 600) * 1000;
    while (Date.now() < deadline) {
        await sleep(wait);
        let answer: Awaited<ReturnType<typeof postForm>>;
        try {
            answer = await postForm("/oauth/token", { grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: clientId });
        } catch {
            continue; // A dropped connection while waiting is harmless; ask again.
        }
        if (answer.ok) return toSession(answer.data);
        const error = String(answer.data.error || "");
        if (error === "authorization_pending") continue;
        if (error === "slow_down" || answer.status === 429) { wait += 5000; continue; }
        if (error === "access_denied") throw new CliError("Sign-in was cancelled on whatsync.app.");
        if (error === "expired_token") break;
        throw new CliError(`Sign-in failed: ${answer.data.error_description || error || `HTTP ${answer.status}`}`);
    }
    throw new CliError("The code expired before it was approved. Run whatsync login --no-browser again.");
}

/** Browser sign-in using the same OAuth flow as the Claude and ChatGPT connectors. */
export async function login(options: { noBrowser?: boolean; log: (line: string) => void }) {
    const clientId = await ensureClient();
    let server: Server | null = null;
    let port = 0;
    if (!options.noBrowser) {
        for (const candidate of CALLBACK_PORTS) {
            server = await listen(candidate);
            if (server) { port = candidate; break; }
        }
    }
    if (!server) {
        if (!options.noBrowser) options.log(`Ports ${CALLBACK_PORTS.join(", ")} are busy, so signing in with a code instead.\n`);
        const session = await loginWithCode(clientId, options.log);
        saveProfile(p => ({ ...p, session }));
        return session;
    }
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const authorizeUrl = new URL(`${baseUrl()}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        scope: SCOPES.join(" "),
        resource: `${baseUrl()}/api/mcp`,
    }).toString();

    const readCode = (address: string) => {
        const url = new URL(address, redirectUri);
        const error = url.searchParams.get("error");
        if (error) throw new CliError(error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${url.searchParams.get("error_description") || error}`);
        const code = url.searchParams.get("code");
        if (!code) throw new CliError("Sign-in failed: no authorization code was returned.");
        return code;
    };

    const fromBrowser = new Promise<string>((resolve, reject) => {
        server.on("request", (request, response) => {
            if (!request.url?.startsWith("/callback")) { response.writeHead(404).end(); return; }
            // Ignore anything that is not the answer to this sign-in, such as a web page poking
            // at the port, instead of letting it cancel the sign-in.
            if (new URL(request.url, redirectUri).searchParams.get("state") !== state) {
                response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Sign-in did not finish", "This link does not belong to the sign-in that is waiting in your terminal."));
                return;
            }
            try {
                const code = readCode(request.url);
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("You are signed in", "WhatSync is connected to your terminal. You can close this tab."));
                resolve(code);
            } catch (error) {
                response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Sign-in did not finish", "Go back to your terminal for details."));
                reject(error);
            }
        });
    });

    options.log(`Opening ${new URL(baseUrl()).host} to sign in. If it does not open, visit:\n\n  ${authorizeUrl}\n`);
    openBrowser(authorizeUrl.toString());
    options.log("Waiting for you to allow access in the browser... (on a server or over SSH, use whatsync login --no-browser)");
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new CliError("Sign-in timed out after 10 minutes. Run whatsync login again.")), 10 * 60_000).unref());
    try {
        const code = await Promise.race([fromBrowser, timeout]);
        const exchanged = await postForm("/oauth/token", { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier });
        if (!exchanged.ok) {
            if (exchanged.data.error === "invalid_client" || /client/i.test(String(exchanged.data.error_description))) saveProfile(p => ({ ...p, clientId: undefined }));
            throw new CliError(`Sign-in failed: ${exchanged.data.error_description || exchanged.data.error || `HTTP ${exchanged.status}`}`);
        }
        const session = toSession(exchanged.data);
        saveProfile(p => ({ ...p, session }));
        return session;
    } finally {
        server.close();
        server.closeAllConnections?.();
    }
}

export async function logout() {
    const profile = readProfile();
    if (profile.session) {
        // Revoking the refresh token ends the whole grant on the server.
        await postForm("/oauth/revoke", { token: profile.session.refreshToken, client_id: profile.clientId || "" }).catch(() => undefined);
    }
    saveProfile(p => ({ clientId: p.clientId }));
    rmSync(join(configDir(), "tools-cache.json"), { force: true });
    return Boolean(profile.session);
}
