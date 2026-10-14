import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseUrl, configDir, credential, userAgent } from "./auth";
import { CliError } from "./errors";

export type JsonSchema = {
    type?: string | string[];
    description?: string;
    enum?: unknown[];
    format?: string;
    items?: JsonSchema;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    anyOf?: JsonSchema[];
    minimum?: number;
    maximum?: number;
    default?: unknown;
};
export type Tool = {
    name: string;
    title?: string;
    description: string;
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
    inputSchema: JsonSchema;
};
export type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cachePath = () => join(configDir(), "tools-cache.json");
const cacheKey = () => `${baseUrl()}|${process.env.WHATSYNC_API_KEY ? `key:${process.env.WHATSYNC_API_KEY.slice(-6)}` : "login"}`;

async function request(path: string, init: { method: string; body?: unknown }, retried = false): Promise<Response> {
    const token = await credential(retried);
    let response: Response;
    try {
        response = await fetch(`${baseUrl()}${path}`, {
            method: init.method,
            headers: {
                Authorization: `Bearer ${token}`,
                "User-Agent": userAgent(),
                Accept: "application/json",
                ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
    } catch (error) {
        throw new CliError(`Could not reach ${new URL(baseUrl()).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // An access token can be revoked or expire early; a fresh one fixes that once.
    if (response.status === 401 && !retried && !process.env.WHATSYNC_API_KEY) return request(path, init, true);
    return response;
}

async function failure(response: Response): Promise<never> {
    const body = await response.json().catch(() => ({})) as { error?: string | { code?: string; message?: string }; message?: string; details?: { path?: (string | number)[]; message?: string }[] };
    const code = typeof body.error === "object" ? body.error.code : body.error;
    if (response.status === 401) throw new CliError(process.env.WHATSYNC_API_KEY ? "WHATSYNC_API_KEY was rejected. Check that the key is correct and not revoked." : "Your sign-in is no longer valid. Run: whatsync login");
    if (response.status === 403) throw new CliError("Your sign-in does not allow this. Run whatsync login again and allow all permissions.");
    if (response.status === 429) throw new CliError(`Too many requests. Try again in ${response.headers.get("retry-after") || "60"} seconds.`);
    if (response.status === 400 && body.details?.length) {
        throw new CliError(`Invalid input:\n${body.details.map(d => `  ${d.path?.join(".") || "input"}: ${d.message}`).join("\n")}`);
    }
    const message = typeof body.error === "object" ? body.error.message : body.message;
    throw new CliError(message || code || `Request failed with HTTP ${response.status}.`);
}

export async function listTools(fresh = false): Promise<Tool[]> {
    if (!fresh) {
        try {
            const cached = JSON.parse(readFileSync(cachePath(), "utf8")) as { key: string; at: number; tools: Tool[] };
            if (cached.key === cacheKey() && Date.now() - cached.at < CACHE_TTL_MS && Array.isArray(cached.tools)) return cached.tools;
        } catch { /* No usable cache. */ }
    }
    const response = await request("/api/agent/tools", { method: "GET" });
    if (!response.ok) await failure(response);
    const { tools } = await response.json() as { tools: Tool[] };
    try {
        mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        writeFileSync(cachePath(), JSON.stringify({ key: cacheKey(), at: Date.now(), tools }), { mode: 0o600 });
    } catch { /* Caching is only a speed-up. */ }
    return tools;
}

export function clearToolCache() {
    rmSync(cachePath(), { force: true });
}

export async function findTool(name: string): Promise<Tool | undefined> {
    return (await listTools()).find(t => t.name === name) ?? (await listTools(true)).find(t => t.name === name);
}

export async function callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const response = await request(`/api/agent/tools/${encodeURIComponent(name)}`, { method: "POST", body: input });
    // 422 carries a normal tool result whose isError explains what went wrong.
    if (!response.ok && response.status !== 422) {
        if (response.status === 404) clearToolCache();
        await failure(response);
    }
    return await response.json() as ToolResult;
}
