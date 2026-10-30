import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { OMP_APPROVALS_PROMPT } from "./input.ts";

export function assertOmpApprovalsOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [OMP_APPROVALS_PROMPT]);
  assertRuntimeRequestKinds(projection, ["command", "user_input"]);
  assertAllRuntimeRequestsResolved(projection);
  assertAssistantTextIncludes(projection, "omp approvals fixture complete");

  const question = projection.turnItems.find((item) => item.type === "user_input_request")
    ?.questions[0];
  assert.equal(question?.header, "Allow tool: write");
  assert.deepEqual(
    question?.options.map((option) => option.label),
    ["Approve", "Approve write for this session", "Deny"],
  );
}
