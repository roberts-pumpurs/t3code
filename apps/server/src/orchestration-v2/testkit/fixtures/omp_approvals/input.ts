import type { OrchestratorFixtureInput } from "../shared.ts";

const OMP_APPROVED_TARGET = "omp-approved.txt";
export const OMP_DENIED_TARGET = "omp-denied.txt";

export const OMP_APPROVALS_PROMPT = `Use the bash tool once to run exactly: echo approved > ${OMP_APPROVED_TARGET}. Then use the write tool once to create ${OMP_DENIED_TARGET} containing exactly: denied. If a tool is denied, do not retry or use another tool. Finally reply exactly: omp approvals fixture complete`;

// omp asks for bash through session/request_permission and for writes through a form.
export function ompApprovalsInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: OMP_APPROVALS_PROMPT },
      { type: "approve_next_runtime_request", decision: "accept" },
      { type: "answer_next_user_input_request", answers: { value: "Deny" } },
    ],
  };
}
