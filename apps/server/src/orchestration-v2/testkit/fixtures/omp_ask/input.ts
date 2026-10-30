import type { OrchestratorFixtureInput } from "../shared.ts";

export const OMP_ASK_PROMPT =
  "Use your ask tool to ask me exactly one single-choice question. Its header is: Fixture color. Its question is: Which color should the fixture use? Its options are: Red, Blue. Do not use any other tool. After I answer, reply exactly: omp ask fixture chose <the color I picked>";

export function ompAskInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OMP_ASK_PROMPT },
      { type: "answer_next_user_input_request", answers: { q0: "Blue" } },
    ],
  };
}
