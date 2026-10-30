import type {
  CustomModelSetting,
  ModelCapabilities,
  ProviderOptionChoice,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { OmpSettings } from "../settings.ts";
import {
  OMP_DEFAULT_MODEL,
  OMP_DRIVER_KIND,
  OMP_SUPPORTED_RUNTIME_MODES,
  runOmpCommand,
} from "./acpSupport.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: OMP_SUPPORTED_RUNTIME_MODES,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `omp models` waits for background catalog discovery before printing.
const MODELS_PROBE_TIMEOUT_MS = 20_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const OMP_DEFAULT_MODEL_ENTRY: ServerProviderModel = {
  slug: OMP_DEFAULT_MODEL,
  name: "omp default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

const THINKING_LABELS: Record<string, string> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const OmpModelsOutput = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      id: Schema.String,
      kind: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      reasoning: Schema.optional(Schema.Boolean),
      // Models without reasoning report `thinking: null`.
      thinking: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});
const decodeOmpModelsOutput = Schema.decodeUnknownResult(Schema.fromJsonString(OmpModelsOutput));

// Option IDs match the values of omp's ACP `thinking` config option, so the shared ACP
// adapter applies the selection as-is. "auto" is omp's per-prompt thinking choice.
function thinkingCapabilities(levels: ReadonlyArray<string>): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: ["off", "auto", ...levels].map((level): ProviderOptionChoice => ({
          id: level,
          label: THINKING_LABELS[level] ?? level,
        })),
      },
    ],
  });
}

/** Parses `omp models --json`, which lists only models whose provider has credentials. */
export function parseOmpModels(output: string): ReadonlyArray<ServerProviderModel> | undefined {
  const decoded = decodeOmpModelsOutput(output);
  if (Result.isFailure(decoded)) return undefined;
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const model of decoded.success.models) {
    if (model.kind !== undefined && model.kind !== "chat") continue;
    const provider = model.provider.trim();
    const id = model.id.trim();
    const slug = `${provider}/${id}`;
    if (provider === "" || id === "" || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model.name?.trim() || slug,
      subProvider: provider,
      isCustom: false,
      capabilities:
        model.reasoning === true ? thinkingCapabilities(model.thinking ?? []) : EMPTY_CAPABILITIES,
    });
  }
  return models;
}

function ompModels(
  customModels: ReadonlyArray<CustomModelSetting>,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [OMP_DEFAULT_MODEL_ENTRY, ...discovered],
    customModels,
    EMPTY_CAPABILITIES,
  );
}

function snapshot(
  settings: OmpSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel> = ompModels(settings.customModels),
): ServerProviderDraft {
  return buildServerProvider({
    driver: OMP_DRIVER_KIND,
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    // omp handles /compact over ACP; the live session advertises the rest.
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe,
  });
}

const DISABLED_PROBE: ProviderProbeResult = {
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  message: "Oh My Pi is disabled in T3 Code settings.",
};

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProviderStatus.buildInitialOmpProviderSnapshot",
)(function* (settings: OmpSettings) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return snapshot(
    settings,
    checkedAt,
    settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Oh My Pi CLI availability...",
        }
      : DISABLED_PROBE,
  );
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return snapshot(settings, checkedAt, DISABLED_PROBE);

  const versionResult = yield* runOmpCommand(settings, environment, ["--version"]).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    yield* Effect.logWarning("Oh My Pi CLI health check failed.", {
      errorTag: versionResult.failure._tag,
    });
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Oh My Pi (`omp`) is not installed or not on PATH. Install it from https://github.com/can1357/oh-my-pi."
        : "Failed to execute the Oh My Pi CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Oh My Pi is installed but timed out while running `omp --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0 || version === null) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        versionOutput.code !== 0
          ? "Oh My Pi is installed but failed to run."
          : "T3 Code could not determine the Oh My Pi version.",
    });
  }

  const modelsResult = yield* runOmpCommand(settings, environment, ["models", "--json"]).pipe(
    Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const discovered = Result.isSuccess(modelsResult)
    ? Option.flatMap(modelsResult.success, (output) =>
        output.code === 0 ? Option.fromUndefinedOr(parseOmpModels(output.stdout)) : Option.none(),
      )
    : Option.none();
  if (Option.isNone(discovered)) {
    if (Result.isFailure(modelsResult)) {
      yield* Effect.logWarning("Oh My Pi model discovery failed.", {
        errorTag: modelsResult.failure._tag,
      });
    }
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "Oh My Pi is available, but T3 Code could not list its models. The live session uses omp's own model list.",
    });
  }

  const authenticated = discovered.value.length > 0;
  const profile = settings.profile ? ` --profile ${settings.profile}` : "";
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unauthenticated" },
      ...(authenticated
        ? {}
        : {
            message: `Oh My Pi has no usable models. Run \`omp${profile}\` in a terminal and use /login, or configure a provider API key.`,
          }),
    },
    ompModels(settings.customModels, discovered.value),
  );
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
