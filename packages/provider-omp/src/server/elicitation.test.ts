import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { extractOmpElicitationForm } from "./elicitation.ts";

const form = (
  message: string,
  properties: Record<string, unknown>,
  required?: Array<string>,
): EffectAcpSchema.CreateElicitationRequest =>
  ({
    mode: "form",
    sessionId: "session-1",
    message,
    requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
  }) as EffectAcpSchema.CreateElicitationRequest;

// The shape omp 18.14.0's ACP askDialog sends for one single-select question.
const singleAsk = form("Approve this exact code-only commit command so I can continue?", {
  q0: {
    type: "string",
    title: "Approve this exact code-only commit command so I can continue?",
    description: "Safety-hook false positive",
    oneOf: [
      {
        const: "Approve the exact command",
        title: "Approve the exact command",
        description: "Commit the verified booking fix and sync staging.",
      },
      { const: "Hold the booking commit", title: "Hold the booking commit" },
    ],
    default: "Approve the exact command",
  },
  q0__other: { type: "string", title: "Other (type your own)" },
});

describe("extractOmpElicitationForm", () => {
  it("shows an ask question once, with its header, text, and options", () => {
    const extracted = extractOmpElicitationForm(singleAsk);
    expect(extracted?.questions).toEqual([
      {
        id: "q0",
        header: "Safety-hook false positive",
        question: "Approve this exact code-only commit command so I can continue?",
        options: [
          {
            label: "Approve the exact command",
            description: "Commit the verified booking fix and sync staging.",
            value: "Approve the exact command",
          },
          {
            label: "Hold the booking commit",
            description: "Hold the booking commit",
            value: "Hold the booking commit",
          },
        ],
      },
    ]);
    expect(extracted?.respond({ q0: "Hold the booking commit" })).toEqual({
      action: "accept",
      content: { q0: "Hold the booking commit" },
    });
    expect(extracted?.respond({ q0: "Neither, wait for me" })).toEqual({
      action: "accept",
      content: { q0__other: "Neither, wait for me" },
    });
  });

  it("keeps multi-select picks and routes extra text to the Other field", () => {
    const extracted = extractOmpElicitationForm(
      form("Answer 2 questions", {
        q0: {
          type: "array",
          title: "Which checks?",
          items: { anyOf: [{ const: "lint" }, { const: "test" }] },
        },
        q0__other: { type: "string", title: "Other (type your own)" },
        q1: { type: "string", title: "Ship it?", oneOf: [{ const: "Yes" }, { const: "No" }] },
        q1__other: { type: "string", title: "Other (type your own)" },
      }),
    );
    expect(extracted?.questions.map((question) => question.multiSelect)).toEqual([true, undefined]);
    expect(extracted?.respond({ q0: ["test", "typecheck"], q1: "Yes" })).toEqual({
      action: "accept",
      content: { q0: ["test"], q0__other: "typecheck", q1: "Yes" },
    });
  });

  it("titles a tool approval with its first line and returns only an offered choice", () => {
    const extracted = extractOmpElicitationForm(
      form(
        "Allow tool: edit\nFile: edit-me.txt",
        {
          value: { type: "string", enum: ["Approve", "Approve edit for this session", "Deny"] },
        },
        ["value"],
      ),
    );
    expect(extracted?.questions[0]).toMatchObject({
      header: "Allow tool: edit",
      question: "Allow tool: edit\nFile: edit-me.txt",
      allowCustomAnswer: false,
    });
    expect(extracted?.respond({ value: "Deny" })).toEqual({
      action: "accept",
      content: { value: "Deny" },
    });
    expect(extracted?.respond({ value: "something else" })).toEqual({ action: "cancel" });
  });

  it("answers a confirm dialog with a boolean", () => {
    const extracted = extractOmpElicitationForm(
      form("Delete branch?", { value: { type: "boolean" } }, ["value"]),
    );
    expect(extracted?.respond({ value: "false" })).toEqual({
      action: "accept",
      content: { value: false },
    });
  });

  it("leaves forms omp did not build to the generic mapping", () => {
    expect(
      extractOmpElicitationForm(
        form("Sign in", { token: { type: "string" }, remember: { type: "boolean" } }),
      ),
    ).toBeUndefined();
  });
});
