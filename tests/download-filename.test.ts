import { describe, expect, it } from "vitest";
import {
  MAX_FILE_NAME_BYTES,
  fileNameFromUrlPath,
  parseContentDispositionName,
  sanitizeFileName,
} from "../src/booth/download.js";

const FALLBACK = "booth-42.bin";

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("sanitizeFileName", () => {
  it.each([
    ["../../evil.exe", "evil.exe"],
    ["..\\x", "x"],
    ["..\\..\\Windows\\system32\\evil.dll", "evil.dll"],
    ["/etc/passwd", "passwd"],
    ["C:\\Users\\me\\a.zip", "a.zip"],
    ["dir/..", FALLBACK],
    ["CON.txt", "_CON.txt"],
    ["con.tar.gz", "_con.tar.gz"],
    ["nul", "_nul"],
    ["Aux.unitypackage", "_Aux.unitypackage"],
    ["COM1.zip", "_COM1.zip"],
    ["lpt9", "_lpt9"],
    ["CONIN$", "_CONIN$"],
    ["conout$.txt", "_conout$.txt"],
    ["CONSOLE.txt", "CONSOLE.txt"],
    ["COM10.zip", "COM10.zip"],
    ["a\u0000b\u001fc\u007f\u0085.zip", "abc.zip"],
    ['a<b>c:d"e|f?g*h.zip', "abcdefgh.zip"],
    ["evil\u202Egpj.exe", "evilgpj.exe"],
    ["name. . .", "name"],
    ["archive.zip..", "archive.zip"],
    ["  spaced.zip  ", "spaced.zip"],
    ["衣装_しなの対応_v1.2.zip", "衣装_しなの対応_v1.2.zip"],
    ["Outfit (Ver.1.0).unitypackage", "Outfit (Ver.1.0).unitypackage"],
    ["", FALLBACK],
    ["...", FALLBACK],
    ["..", FALLBACK],
    ["   ", FALLBACK],
    ["\u0001\u0002", FALLBACK],
    ["<>:|", FALLBACK],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFileName(input, FALLBACK)).toBe(expected);
  });

  it("normalizes to NFC", () => {
    expect(sanitizeFileName("\u30AB\u3099.zip", FALLBACK)).toBe("\u30AC.zip");
  });

  it("caps long ASCII names by UTF-8 bytes and keeps the extension", () => {
    const result = sanitizeFileName(`${"a".repeat(300)}.unitypackage`, FALLBACK);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(result.endsWith(".unitypackage")).toBe(true);
    expect(result.startsWith("aaaa")).toBe(true);
  });

  it("caps long Japanese names by UTF-8 bytes without splitting characters", () => {
    const result = sanitizeFileName(`${"あ".repeat(150)}.zip`, FALLBACK);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(result).toMatch(/^あ+\.zip$/u);
  });

  it("does not split surrogate pairs when truncating", () => {
    const result = sanitizeFileName(`${"😀".repeat(100)}.zip`, FALLBACK);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(result).toMatch(/^(?:😀)+\.zip$/u);
  });

  it("caps an extension-less long name", () => {
    const result = sanitizeFileName("x".repeat(500), FALLBACK);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(result).toMatch(/^x+$/u);
  });

  it("keeps a reserved-name prefix within the byte cap", () => {
    const result = sanitizeFileName(`CON.${"b".repeat(400)}`, FALLBACK);
    expect(result.startsWith("_CON.")).toBe(true);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
  });
});

describe("parseContentDispositionName", () => {
  it("prefers RFC 5987 filename* over filename", () => {
    const header = "attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E8%A1%A3%E8%A3%85.zip";
    expect(parseContentDispositionName(header)).toBe("衣装.zip");
  });

  it("decodes an ISO-8859-1 filename*", () => {
    expect(parseContentDispositionName("attachment; filename*=iso-8859-1'en'%A3%20rates.txt")).toBe("£ rates.txt");
  });

  it("falls back to filename when filename* is malformed", () => {
    expect(parseContentDispositionName("attachment; filename*=UTF-8''%E8%A1; filename=ok.zip")).toBe("ok.zip");
  });

  it.each([
    ['attachment; filename="plain.zip"', "plain.zip"],
    ["attachment; filename=token.zip", "token.zip"],
    ['attachment; filename="a \\"quoted\\".zip"', 'a "quoted".zip'],
    ['attachment; filename="semi;colon.zip"', "semi;colon.zip"],
    ['attachment; filename="%E8%A1%A3.zip"', "衣.zip"],
    ['attachment; filename="100%.zip"', "100%.zip"],
  ])("parses %s", (header, expected) => {
    expect(parseContentDispositionName(header)).toBe(expected);
  });

  it("recovers raw UTF-8 bytes that fetch exposes as Latin-1", () => {
    const mojibake = Buffer.from("衣装.zip", "utf8").toString("latin1");
    expect(parseContentDispositionName(`attachment; filename="${mojibake}"`)).toBe("衣装.zip");
  });

  it.each([null, undefined, "", "inline", "attachment", 'attachment; filename=""', "attachment; name=x.zip"])(
    "returns null for %j",
    (header) => {
      expect(parseContentDispositionName(header)).toBeNull();
    },
  );
});

describe("fileNameFromUrlPath", () => {
  it("returns the decoded last path segment without the query", () => {
    const url = new URL("https://s6.booth.pm/abc/i/1/%E8%A1%A3%E8%A3%85_v1.zip?X-Amz-Signature=secret");
    expect(fileNameFromUrlPath(url)).toBe("衣装_v1.zip");
  });

  it("keeps the raw segment when it is not valid percent-encoding", () => {
    expect(fileNameFromUrlPath(new URL("https://s6.booth.pm/files/bad%E8.zip"))).toBe("bad%E8.zip");
  });

  it("returns null for a trailing slash or root path", () => {
    expect(fileNameFromUrlPath(new URL("https://s6.booth.pm/files/"))).toBeNull();
    expect(fileNameFromUrlPath(new URL("https://s6.booth.pm/"))).toBeNull();
  });
});
