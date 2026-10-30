import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { OmpSettings } from "../settings.ts";
import { OMP_DEFAULT_MODEL, runOmpCommand } from "./acpSupport.ts";

const OMP_TIMEOUT_MS = 180_000;

// Print mode with no tools, session, or project context: a plain completion.
const PRINT_ARGS = [
  "-p",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-lsp",
  "--no-title",
] as const;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runOmpJson: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.runOmpJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const model = modelSelection.model.trim();
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      const args = [
        ...PRINT_ARGS,
        ...(model && model !== OMP_DEFAULT_MODEL ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        prompt,
      ];
      const result = yield* runOmpCommand(settings, environment, args, cwd).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(OMP_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({ operation, detail: "Oh My Pi print mode failed.", cause }),
        ),
      );
      if (Option.isNone(result)) {
        return yield* new TextGenerationError({ operation, detail: "Oh My Pi timed out." });
      }
      const output = result.value.stdout.trim();
      if (result.value.code !== 0 || output.length === 0) {
        return yield* new TextGenerationError({
          operation,
          detail:
            result.value.code !== 0
              ? `Oh My Pi exited with code ${result.value.code}.`
              : "Oh My Pi returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Oh My Pi", output);
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "Oh My Pi text generation failed.",
                cause,
              }),
        ),
      ),
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("Oh My Pi", runOmpJson),
  );
});
