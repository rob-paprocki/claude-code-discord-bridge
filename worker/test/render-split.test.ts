import { describe, expect, it } from "vitest";
import { outcomeLine, renderRequest, split, tickedLabels, withOutcome } from "../src/render";
import type { Question, RequestRecord } from "../src/types";

const fenceCount = (s: string) => s.split("\n").filter((l) => /^\s*```/.test(l)).length;

describe("split", () => {
  it("split keeps fences balanced", () => {
    const text = `${"p".repeat(1500)}\n\`\`\`ts\n${"c".repeat(1500)}\n\`\`\``;
    const parts = split(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(fenceCount(p) % 2).toBe(0);
      expect(p.length).toBeLessThanOrEqual(2000);
    }
    expect(parts[1].startsWith("```ts\n")).toBe(true);
  });

  it("split reopens a fence cut mid-line with its info string", () => {
    const text = `\`\`\`py\n${"x".repeat(5000)}\n\`\`\``;
    const parts = split(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(fenceCount(p) % 2).toBe(0);
      expect(p.length).toBeLessThanOrEqual(2000);
    }
    expect(parts[1].startsWith("```py\n")).toBe(true);
  });

  it("split never cuts a surrogate pair", () => {
    const parts = split(`${"a".repeat(1989)}${"😀".repeat(400)}`);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(p.length).toBeLessThanOrEqual(2000);
    }
    expect(parts.join("")).toBe(`${"a".repeat(1989)}${"😀".repeat(400)}`);
  });
});

const q: Question = { question: "Go?", multiSelect: true, options: [{ label: "Yes, do it" }, { label: "No" }, { label: "Later" }] };

describe("tickedLabels", () => {
  it("ticks match whole labels", () => {
    expect([...tickedLabels(q, "Yes, do it")]).toEqual(["Yes, do it"]);
    expect([...tickedLabels(q, "No, Later")]).toEqual(["No", "Later"]);
    expect([...tickedLabels(q, "Yes, do it, Later")]).toEqual(["Yes, do it", "Later"]);
  });
});

describe("tickedLabels backtracks", () => {
  const mk = (...labels: string[]): Question => ({ question: "Go?", multiSelect: true, options: labels.map((label) => ({ label })) });
  it("a label that is a prefix of a longer one does not hide it", () => {
    const qq = mk("Fix it", "Fix it, then add a test", "Update docs");
    expect([...tickedLabels(qq, "Fix it, then add a test")]).toEqual(["Fix it, then add a test"]);
  });
  it("A and A, B", () => {
    expect([...tickedLabels(mk("A", "A, B"), "A, B")]).toEqual(["A, B"]);
  });
  it("the select option default follows the ticks", () => {
    const qq = mk("Fix it", "Fix it, then add a test", "Update docs");
    const r = {
      id: "i", kind: "question", machine: "m", project: "p", session: "s", status: "pending", created: 0, expires: 1, messageIds: [],
      questions: [qq], partial: { "Go?": "Fix it, then add a test" },
    } as unknown as RequestRecord;
    const sel = (renderRequest(r).at(-1)!.components as any[])[0].components[0];
    expect(sel.options.map((o: any) => !!o.default)).toEqual([false, true, false]);
  });
});

describe("split fences and cuts", () => {
  const emptyBlock = (p: string) => /^\s*```[^\n]*\n\s*```\s*$/m.test(p);

  it("a cut right after an opening fence line moves before it", () => {
    const text = `${"a".repeat(1000)}\n\`\`\`ts\n${"c".repeat(3000)}\n\`\`\``;
    const parts = split(text);
    expect(parts[0]).toBe("a".repeat(1000));
    expect(parts[1].startsWith("```ts\n")).toBe(true);
    for (const p of parts) {
      expect(emptyBlock(p)).toBe(false);
      expect(fenceCount(p) % 2).toBe(0);
      expect(p.length).toBeLessThanOrEqual(2000);
    }
  });

  it("a cut right before a closing fence line moves after it", () => {
    const text = `\`\`\`ts\n${"c".repeat(1984)}\n\`\`\`\n${"z".repeat(100)}`;
    const parts = split(text);
    expect(parts).toEqual([`\`\`\`ts\n${"c".repeat(1984)}\n\`\`\``, "z".repeat(100)]);
    for (const p of parts) expect(emptyBlock(p)).toBe(false);
  });

  it("a one-line ```npm test``` is not a fence", () => {
    const text = `\`\`\`npm test\`\`\`\n${"x".repeat(2500)}`;
    const parts = split(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].endsWith("\n```")).toBe(false);
    expect(parts[1].startsWith("```")).toBe(false);
  });

  it("a cut never separates a backslash from the character it escapes", () => {
    // esc() output: every special character carries a backslash.
    const text = `a${"\\*".repeat(1500)}`;
    const parts = split(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const m = /\\+$/.exec(p);
      expect(m ? m[0].length % 2 : 0).toBe(0);
    }
    expect(parts.join("")).toBe(text);
  });

  it("the info string cap never splits a surrogate pair", () => {
    const text = `\`\`\`${"a".repeat(99)}😀tail\n${"x".repeat(4000)}\n\`\`\``;
    const parts = split(text);
    expect(parts.length).toBeGreaterThan(1);
    const reopen = parts[1].split("\n")[0];
    expect(/[\uD800-\uDBFF]$/.test(reopen)).toBe(false);
  });
});

describe("withOutcome clipping", () => {
  it("closes a fence the clip leaves open, surrogate-safe, within 2000", () => {
    const body = `intro\n\`\`\`\n${"😀".repeat(990)}\n\`\`\``;
    expect(body.length).toBeGreaterThan(1980);
    const out = withOutcome(body, "Back at the terminal.");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.split("\n").filter((l) => /^\s*```/.test(l)).length % 2).toBe(0);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(out).toMatch(/\nBack at the terminal\.$/);
  });
});

describe("answer order", () => {
  it("answered line follows question order", () => {
    const questions: Question[] = [
      { question: "First?", options: [{ label: "a" }] },
      { question: "Second?", options: [{ label: "b" }] },
    ];
    const r: RequestRecord = {
      kind: "question", machine: "m", project: "p", session: "s", id: "abcde", status: "answered",
      created: 0, expires: 1, messageIds: [], questions,
      answer: { type: "answers", answers: { "Second?": "b", "First?": "a" } },
    };
    expect(outcomeLine(r)).toBe("Answered: First? → a; Second? → b");
  });
});
