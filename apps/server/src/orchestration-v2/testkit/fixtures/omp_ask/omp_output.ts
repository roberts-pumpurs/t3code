import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { OMP_ASK_PROMPT } from "./input.ts";

export function assertOmpAskOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [OMP_ASK_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["user_input"]);
  assertAllRuntimeRequestsResolved(projection);
  assertAssistantTextIncludes(projection, "omp ask fixture chose Blue");

  // One question with its own header and both choices, not a second "Other" step.
  const questions = projection.turnItems.find(
    (item) => item.type === "user_input_request",
  )?.questions;
  assert.deepEqual(
    questions?.map((question) => ({
      header: question.header,
      question: question.question,
      options: question.options.map((option) => option.label),
    })),
    [
      {
        header: "Fixture color",
        question: "Which color should the fixture use?",
        options: ["Red", "Blue"],
      },
    ],
  );
}
