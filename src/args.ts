import { readFileSync } from "node:fs";
import type { JsonSchema, Tool } from "./api";
import { CliError } from "./errors";

export type ParsedArgs = { positionals: string[]; flags: Map<string, string[]> };

/** Splits argv into positionals and repeatable flags. A bare flag gets the value "true". */
export function parseArgs(argv: string[], booleanFlags: Set<string> = new Set()): ParsedArgs {
    const positionals: string[] = [];
    const flags = new Map<string, string[]>();
    const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
        if (arg.startsWith("--") && arg.length > 2) {
            const eq = arg.indexOf("=");
            const name = normalize(eq === -1 ? arg.slice(2) : arg.slice(2, eq));
            if (eq !== -1) add(name, arg.slice(eq + 1));
            else if (booleanFlags.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) add(name, "true");
            else add(name, argv[++i]);
        } else if (/^-[a-z]$/i.test(arg)) {
            add(normalize({ h: "help", y: "yes", j: "json", v: "version" }[arg[1]] ?? arg[1]), "true");
        } else {
            positionals.push(arg);
        }
    }
    return { positionals, flags };
}

/** phoneNumber, phone-number and phone_number all name the same flag. */
export function normalize(name: string) {
    return name.replace(/[-_]/g, "").toLowerCase();
}

export function kebab(name: string) {
    return name.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function schemaType(schema: JsonSchema): string {
    if (schema.anyOf) return schemaType(schema.anyOf.find(s => s.type !== "null") ?? {});
    if (Array.isArray(schema.type)) return schema.type.find(t => t !== "null") ?? "string";
    return schema.type ?? "string";
}

/**
 * Only --input reads a file (@path) or stdin (-). Ordinary options are always taken literally:
 * a message like "@Ravi call me" must never turn into the contents of a file on this computer.
 */
function readInput(raw: string) {
    if (raw === "-") return readFileSync(0, "utf8");
    if (raw.startsWith("@") && raw.length > 1) {
        try { return readFileSync(raw.slice(1), "utf8"); } catch { throw new CliError(`Could not read ${raw.slice(1)}.`); }
    }
    return raw;
}

function coerce(name: string, raw: string, schema: JsonSchema): unknown {
    const type = schemaType(schema);
    if (type === "boolean") {
        if (["true", "yes", "1"].includes(raw.toLowerCase())) return true;
        if (["false", "no", "0"].includes(raw.toLowerCase())) return false;
        throw new CliError(`--${kebab(name)} must be true or false.`);
    }
    if (type === "number" || type === "integer") {
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value)) throw new CliError(`--${kebab(name)} must be a number.`);
        return value;
    }
    if (type === "object") return parseJson(name, raw);
    return raw;
}

function parseJson(name: string, raw: string) {
    try { return JSON.parse(raw); } catch { throw new CliError(`--${kebab(name)} must be valid JSON.`); }
}

/** Turns flags into a tool input using the tool's own schema, so every tool works without custom code. */
export function buildToolInput(tool: Tool, flags: Map<string, string[]>, ignore: Set<string>): Record<string, unknown> {
    const properties = tool.inputSchema.properties ?? {};
    const byFlag = new Map(Object.keys(properties).map(key => [normalize(key), key]));
    let input: Record<string, unknown> = {};
    const raw = flags.get("input");
    if (raw) {
        const parsed = parseJson("input", readInput(raw[raw.length - 1]));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError("--input must be a JSON object.");
        input = { ...parsed };
    }
    for (const [flag, values] of flags) {
        if (flag === "input" || ignore.has(flag)) continue;
        const negated = flag.startsWith("no") && byFlag.has(flag.slice(2)) && !byFlag.has(flag);
        const key = byFlag.get(negated ? flag.slice(2) : flag);
        if (!key) {
            const known = Object.keys(properties).map(k => `--${kebab(k)}`).join(", ");
            throw new CliError(`Unknown option --${flag} for ${tool.name}.${known ? ` Options: ${known}` : " It takes no options."}`);
        }
        const schema = properties[key];
        if (negated) {
            if (schemaType(schema) !== "boolean") throw new CliError(`--no-${kebab(key)} only works for yes/no options.`);
            input[key] = false;
        } else if (schemaType(schema) === "array") {
            const items = schema.items ?? {};
            input[key] = values.length === 1 && values[0].trim().startsWith("[")
                ? parseJson(key, values[0])
                : values.map(v => schemaType(items) === "object" ? parseJson(key, v) : coerce(key, v, items));
        } else {
            input[key] = coerce(key, values[values.length - 1], schema);
        }
    }
    return input;
}

export function newIdempotencyKey() {
    return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function toolUsage(tool: Tool) {
    const properties = tool.inputSchema.properties ?? {};
    const required = new Set(tool.inputSchema.required ?? []);
    const lines = Object.entries(properties)
        .filter(([key]) => key !== "idempotencyKey")
        .map(([key, schema]) => {
            const type = schemaType(schema);
            const hint = schema.enum ? schema.enum.join("|") : type === "array" ? `${schemaType(schema.items ?? {})}, repeat the option` : type;
            return `  --${kebab(key)} <${hint}>${required.has(key) ? "  (required)" : ""}${schema.description ? `\n      ${schema.description}` : ""}`;
        });
    return [
        `whatsync ${kebab(tool.name)}${tool.annotations.readOnlyHint ? "" : "   (makes a change)"}`,
        "",
        tool.description,
        "",
        lines.length ? "Options:" : "Takes no options.",
        ...lines,
        ...(properties.idempotencyKey ? ["", "  --idempotency-key <string>  Reuse the same key to retry safely. One is created for you if omitted."] : []),
        "",
        "  --input <json|@file|->  Pass all options as one JSON object.",
        "  --json                  Print raw JSON.",
    ].join("\n");
}
