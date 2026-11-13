import { describe, expect, it } from "vitest";
import { cleanMachineName, joinCode, randomHex, sha256Hex } from "../src/keys";

describe("keys", () => {
  it("randomHex gives the requested length", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });

  it("sha256Hex matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("joinCode avoids look-alikes", () => {
    const re = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/;
    for (let i = 0; i < 200; i++) expect(joinCode()).toMatch(re);
  });

  it("cleanMachineName rules", () => {
    expect(cleanMachineName("  my-laptop ")).toBe("my-laptop");
    for (const bad of ["", "x".repeat(65), "café", "a‮b", "a\nb", 42]) {
      expect(cleanMachineName(bad)).toBeNull();
    }
    expect(cleanMachineName("x".repeat(64))).toBe("x".repeat(64));
  });
});
