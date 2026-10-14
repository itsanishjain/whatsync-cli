import { describe, expect, test } from "bun:test";
import { buildToolInput, kebab, parseArgs } from "../src/args";
import type { Tool } from "../src/api";

const tool: Tool = {
    name: "send_poll",
    description: "Send a poll",
    annotations: {},
    inputSchema: {
        type: "object",
        properties: {
            idempotencyKey: { type: "string" },
            phoneNumber: { type: "string" },
            name: { type: "string" },
            values: { type: "array", items: { type: "string" } },
            selectableCount: { type: "integer" },
            voiceNote: { type: "boolean" },
            contacts: { type: "array", items: { type: "object" } },
        },
        required: ["idempotencyKey", "phoneNumber", "name", "values"],
    },
};

describe("parseArgs", () => {
    test("splits flags, values and positionals", () => {
        const { positionals, flags } = parseArgs(["919876543210", "hello", "--limit", "5", "--json", "--x=a=b"], new Set(["json"]));
        expect(positionals).toEqual(["919876543210", "hello"]);
        expect(flags.get("limit")).toEqual(["5"]);
        expect(flags.get("json")).toEqual(["true"]);
        expect(flags.get("x")).toEqual(["a=b"]);
    });
    test("known yes/no flags never swallow the next word", () => {
        expect(parseArgs(["--json", "Ravi"], new Set(["json"])).positionals).toEqual(["Ravi"]);
    });
    test("everything after -- is a positional", () => {
        expect(parseArgs(["--", "--not-a-flag"]).positionals).toEqual(["--not-a-flag"]);
    });
});

describe("buildToolInput", () => {
    const build = (argv: string[]) => buildToolInput(tool, parseArgs(argv, new Set(["voicenote"])).flags, new Set(["json"]));
    test("maps any spelling of an option to the schema key and coerces types", () => {
        expect(build(["--phone-number", "9198", "--name", "Lunch?", "--values", "Yes", "--values", "No", "--selectable_count", "1", "--voice-note"]))
            .toEqual({ phoneNumber: "9198", name: "Lunch?", values: ["Yes", "No"], selectableCount: 1, voiceNote: true });
    });
    test("accepts JSON arrays, object arrays and --no- options", () => {
        expect(build(["--values", '["a","b"]', "--contacts", '{"name":"A"}', "--no-voice-note"]))
            .toEqual({ values: ["a", "b"], contacts: [{ name: "A" }], voiceNote: false });
    });
    test("--input supplies a whole object that flags override", () => {
        expect(build(["--input", '{"name":"x","values":["1"]}', "--name", "y"])).toEqual({ name: "y", values: ["1"] });
    });
    test("rejects unknown options and bad numbers with a helpful message", () => {
        expect(() => build(["--nope", "1"])).toThrow(/Unknown option --nope/);
        expect(() => build(["--selectable-count", "two"])).toThrow(/must be a number/);
    });
});

test("kebab turns tool and option names into command spelling", () => {
    expect(kebab("send_group_message")).toBe("send-group-message");
    expect(kebab("phoneNumber")).toBe("phone-number");
});

describe("safety", () => {
    test("a message starting with @ is sent as written, never as a file's contents", () => {
        const input = buildToolInput(tool, parseArgs(["--name", "@/etc/hosts"]).flags, new Set());
        expect(input.name).toBe("@/etc/hosts");
    });
});
