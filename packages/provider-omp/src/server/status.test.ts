import { describe, expect, it } from "@effect/vitest";

import { ompApprovalMode, parseOmpDefaultModelRole } from "./acpSupport.ts";
import { parseOmpModels } from "./status.ts";

describe("parseOmpModels", () => {
  it("keys models by provider/id and offers each model's own thinking levels", () => {
    const models = parseOmpModels(
      JSON.stringify({
        models: [
          {
            provider: "anthropic",
            kind: "chat",
            id: "claude-haiku-5-5",
            name: "Claude Haiku 5.5",
            reasoning: true,
            thinking: ["minimal", "low", "high"],
          },
          { provider: "anthropic", kind: "chat", id: "claude-haiku-5-5", name: "Duplicate" },
          { provider: "local", kind: "speech", id: "kokoro", name: "Kokoro" },
          {
            provider: "rec",
            id: "flint",
            name: "Recursive Flint",
            reasoning: false,
            thinking: null,
          },
        ],
      }),
    );
    expect(models?.map((model) => model.slug)).toEqual(["anthropic/claude-haiku-5-5", "rec/flint"]);
    expect(
      models?.[0]?.capabilities?.optionDescriptors?.[0]?.type === "select" &&
        models[0].capabilities.optionDescriptors[0].options.map((option) => option.id),
    ).toEqual(["off", "auto", "minimal", "low", "high"]);
    expect(models?.[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("rejects output that is not omp's model list", () => {
    expect(parseOmpModels("Working...")).toBeUndefined();
  });
});

describe("parseOmpDefaultModelRole", () => {
  it("drops the thinking suffix from the default role", () => {
    expect(
      parseOmpDefaultModelRole(
        JSON.stringify({ key: "modelRoles", value: { default: "anthropic/claude-opus-5-5:high" } }),
      ),
    ).toBe("anthropic/claude-opus-5-5");
  });

  it("ignores fuzzy role patterns that are not provider/id", () => {
    expect(
      parseOmpDefaultModelRole(JSON.stringify({ key: "modelRoles", value: { default: "opus" } })),
    ).toBeUndefined();
  });
});

describe("ompApprovalMode", () => {
  it("launches each T3 permission mode with the omp mode that enforces it", () => {
    const mode = (runtimeMode: Parameters<typeof ompApprovalMode>[0]["runtimeMode"]) =>
      ompApprovalMode({ runtimeMode });
    expect([
      mode("approval-required"),
      mode("auto-accept-edits"),
      mode("full-access"),
      mode("auto"),
    ]).toEqual(["always-ask", "write", "yolo", "always-ask"]);
    expect(ompApprovalMode({ runtimeMode: "full-access", approvalPolicy: "on-request" })).toBe(
      "always-ask",
    );
  });
});
