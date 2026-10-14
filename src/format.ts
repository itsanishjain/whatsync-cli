import type { ToolResult } from "./api";

type Row = Record<string, unknown>;
/**
 * Message text comes from other people. Remove terminal control codes so a message cannot
 * recolour, hide or rewrite what is on screen, change the window title or write to the clipboard.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const clean = (text: string) => text.replace(CONTROL, "");
const str = (value: unknown) => (value === null || value === undefined ? "" : clean(String(value)));

const color = (code: number) => (text: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
export const dim = color(2);
export const bold = color(1);
export const green = color(32);

/** Short local time, e.g. "13 Oct, 11:42 am", in the computer's own time zone. */
export function when(iso: unknown) {
    if (typeof iso !== "string" || !iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit", hour12: true });
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;

/**
 * Columns a piece of text takes in a terminal, by the usual wcwidth rule: an emoji or CJK
 * character takes two, joining marks (like the Hindi virama) none, everything else one.
 */
function cells(text: string) {
    let total = 0;
    for (const { segment } of segmenter.segment(text)) {
        if (/\p{Extended_Pictographic}/u.test(segment)) { total += 2; continue; }
        for (const char of segment) total += ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
    }
    return total;
}

function oneLine(text: string, max: number) {
    const flat = text.replace(/\s+/g, " ").trim();
    if (cells(flat) <= max) return flat;
    let out = "";
    for (const { segment } of segmenter.segment(flat)) {
        if (cells(out + segment) > max - 1) break;
        out += segment;
    }
    return `${out}…`;
}

function pad(text: string, width: number) {
    return text + " ".repeat(Math.max(0, width - cells(text)));
}

function conversations(rows: Row[]) {
    if (!rows.length) return "No chats found.";
    const names = rows.map(r => str(r.contact_name) || str(r.conversation_id));
    const width = Math.min(32, Math.max(...names.map(cells)));
    return rows.map((r, i) => {
        const tag = r.is_group ? "group" : r.channel === "qr" ? "QR" : r.channel === "business" ? "Business" : "";
        const line = `${pad(oneLine(names[i], width), width)}  ${dim(pad(when(r.last_message_at), 22))}  ${dim([tag, str(r.conversation_id)].filter(Boolean).join("  "))}`;
        return r.last_inbound_text ? `${line}\n  ${dim(oneLine(str(r.last_inbound_text), 100))}` : line;
    }).join("\n");
}

function messages(rows: Row[]) {
    if (!rows.length) return "No messages found.";
    return rows.map(r => {
        const mine = r.direction === "outbound";
        const who = mine ? "You" : str(r.contact_name) || str(r.sender) || "Them";
        const where = r.group_name ? ` in ${str(r.group_name)}` : "";
        const attachment = r.attachment && typeof r.attachment === "object" ? `[${str((r.attachment as Row).file_name) || str(r.type) || "file"}] ` : "";
        const body = `${attachment}${str(r.text)}`.trim() || dim(`(${str(r.type) || "message"})`);
        return `${dim(when(r.sent_at))}  ${mine ? green(who) : bold(who)}${dim(where)}\n  ${body.replace(/\n/g, "\n  ")}`;
    }).join("\n\n");
}

/** One plain line for a send; the full details stay one --json away. */
function sendSummary(data: Row): string | undefined {
    if (!("intent_id" in data) || typeof data.status !== "string") return undefined;
    const to = str(data.recipient_phone) || "the recipient";
    if (data.status === "accepted") {
        const delivery = data.delivery_status === "read" ? "Read." : data.delivery_status === "delivered" ? "Delivered."
            : data.delivery_status === "failed" ? "WhatsApp reported it failed. Run with --json for the reason." : "Waiting for WhatsApp to confirm delivery.";
        return `${green("Sent")} to ${to}. ${delivery}`;
    }
    return str(data.note) || str(data.next_action) || undefined;
}

/** Readable output for people; agents and pipes get JSON (see printResult). */
export function humanize(data: Record<string, unknown>): string {
    const notes: string[] = [];
    let body: string | undefined;
    if (Array.isArray(data.conversations)) body = conversations(data.conversations as Row[]);
    else if (Array.isArray(data.messages)) body = messages(data.messages as Row[]);
    else body = sendSummary(data);
    // JSON.stringify already escapes control codes.
    if (body === undefined) return JSON.stringify(data, null, 2);
    if (data.has_more || data.has_older_messages) {
        const cursor = str(data.next_cursor);
        notes.push(dim(cursor ? `More available. Add --cursor ${cursor}` : "More available."));
    }
    return [body, ...notes].join("\n\n");
}

export function resultData(result: ToolResult): unknown {
    if (result.structuredContent) return result.structuredContent;
    const text = (result.content ?? []).map(c => c.text ?? "").join("\n");
    try { return JSON.parse(text); } catch { return text; }
}

export function printResult(result: ToolResult, json: boolean) {
    const data = resultData(result);
    if (json || !process.stdout.isTTY) {
        process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${typeof data === "string" ? clean(data) : humanize(data as Record<string, unknown>)}\n`);
}
