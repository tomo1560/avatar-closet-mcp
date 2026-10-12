import { BoothError } from "../errors.js";

export type FlagType = "boolean" | "integer" | "string" | "list";
export type FlagValue = boolean | number | string | string[];

export interface ArgSpec {
  /** Flag names without the leading `--`. */
  readonly flags: Readonly<Record<string, FlagType>>;
  readonly minPositionals: number;
  readonly maxPositionals: number;
  /** Usage line shown on any parse error. */
  readonly usage: string;
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
}

/** `--flag value`, `--flag=value`, repeatable `list` flags, and positionals. Unknown flags are errors. */
export function parseArgs(args: readonly string[], spec: ArgSpec): ParsedArgs {
  const positionals: string[] = [];
  let flags: Record<string, FlagValue> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = splitFlag(arg);
    const type = spec.flags[name];
    if (type === undefined) throw usageError(`不明なオプションです: --${name}`, spec);
    if (type === "boolean") {
      if (inline !== undefined) throw usageError(`--${name} は値を取りません。`, spec);
      flags = withFlag(flags, name, true, spec);
      continue;
    }
    const value = inline ?? args[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw usageError(`--${name} には値が必要です。`, spec);
    }
    if (inline === undefined) index += 1;
    flags = withFlag(flags, name, convert(name, type, value, spec), spec);
  }
  if (positionals.length < spec.minPositionals || positionals.length > spec.maxPositionals) {
    throw usageError(positionals.length < spec.minPositionals ? "引数が足りません。" : `不明な引数です: ${positionals.join(" ")}`, spec);
  }
  return { positionals, flags };
}

export function usageError(message: string, spec: Pick<ArgSpec, "usage">): BoothError {
  return new BoothError("INVALID_INPUT", `${message}\n使い方: avatar-closet-mcp ${spec.usage}`);
}

export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function integerFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = parsed.flags[name];
  return typeof value === "number" ? value : undefined;
}

export function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function listFlag(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags[name];
  return Array.isArray(value) ? value : [];
}

function splitFlag(arg: string): [string, string | undefined] {
  const body = arg.slice(2);
  const equals = body.indexOf("=");
  return equals < 0 ? [body, undefined] : [body.slice(0, equals), body.slice(equals + 1)];
}

function convert(name: string, type: Exclude<FlagType, "boolean">, value: string, spec: ArgSpec): FlagValue {
  if (type === "integer") {
    const parsed = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed)) throw usageError(`--${name} には整数を指定してください。`, spec);
    return parsed;
  }
  return type === "list" ? [value] : value;
}

function withFlag(flags: Record<string, FlagValue>, name: string, value: FlagValue, spec: ArgSpec): Record<string, FlagValue> {
  const existing = flags[name];
  if (existing === undefined) return { ...flags, [name]: value };
  if (Array.isArray(existing) && Array.isArray(value)) return { ...flags, [name]: [...existing, ...value] };
  throw usageError(`--${name} が複数回指定されています。`, spec);
}
