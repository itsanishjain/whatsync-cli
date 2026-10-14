import { expect, test } from "bun:test";
import { clean, humanize } from "../src/format";

// Colour depends on whether the tests run in a real terminal; compare plain text either way.
process.env.NO_COLOR = "1";

test("terminal control codes in messages are removed", () => {
    const evil = "Hi\u001b]52;c;ZXZpbA==\u0007\u001b[2J‮boss";
    expect(clean(evil)).toBe("Hi]52;c;ZXZpbA==[2Jboss");
    const out = humanize({ messages: [{ direction: "inbound", contact_name: "A\u001b[31m", text: evil, sent_at: "2026-10-13T05:00:00.000Z" }] });
    expect(out).not.toContain("\u001b]");
    expect(out).not.toContain("‮");
});

test("rows with emoji and Hindi names stay lined up", () => {
    const out = humanize({ conversations: [
        { conversation_id: "1@lid", contact_name: "Dj😎💥", channel: "qr", last_message_at: "2026-10-12T15:21:00.000Z" },
        { conversation_id: "2@lid", contact_name: "प्रियल", channel: "qr", last_message_at: "2026-10-11T05:59:00.000Z" },
        { conversation_id: "3@lid", contact_name: "Neha", channel: "qr", last_message_at: "2026-10-11T06:07:00.000Z" },
    ] });
    // Every row's date starts in the same terminal column.
    // wcwidth: emoji 2, joining marks 0, the rest 1 (प्रियल = 5 columns).
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const col = (line: string) => { let n = 0; for (const { segment } of seg.segment(line.slice(0, line.search(/\d{1,2} Oct/)))) n += /\p{Extended_Pictographic}/u.test(segment) ? 2 : [...segment].filter(c => !/[\p{Mn}\p{Me}\p{Cf}]/u.test(c)).length; return n; };
    const cols = out.split("\n").map(col);
    expect(new Set(cols).size).toBe(1);
});

test("a send prints one plain line", () => {
    expect(humanize({ intent_id: "x", status: "accepted", recipient_phone: "919399460214", delivery_status: "delivered" })).toBe("Sent to 919399460214. Delivered.");
    expect(humanize({ intent_id: "x", status: "accepted", recipient_phone: "1555", delivery_status: null })).toBe("Sent to 1555. Waiting for WhatsApp to confirm delivery.");
});
