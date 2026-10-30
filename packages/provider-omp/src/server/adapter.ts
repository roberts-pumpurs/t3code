import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { OmpSettings } from "../settings.ts";
import {
  makeOmpAcpRuntime,
  OMP_DEFAULT_MODEL,
  OMP_DRIVER_KIND,
  ompApprovalMode,
  resolveOmpDefaultModel,
} from "./acpSupport.ts";
import { extractOmpElicitationForm } from "./elicitation.ts";

const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});
const DEFAULT_MODEL_LOOKUP_TIMEOUT_MS = 5_000;

const OmpProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // The approval mode is a launch flag, so a mode change restarts the session.
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

const makeOmpAcpAdapterFlavor = (
  options: OmpAdapterV2Options,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): AcpAdapterV2Flavor => {
  const customModels = readCustomModelEntries(options.settings.customModels).map(
    (entry) => entry.slug,
  );
  // A resumed session keeps the model it last ran, so "default" must name omp's default role.
  const requestedModelId = (model: string) =>
    model !== OMP_DEFAULT_MODEL
      ? Effect.succeed<string | undefined>(model)
      : resolveOmpDefaultModel(options.settings, options.environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeoutOption(DEFAULT_MODEL_LOOKUP_TIMEOUT_MS),
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
  return {
    driver: OMP_DRIVER_KIND,
    runtimeHarness: "Oh My Pi",
    capabilities: OmpProviderCapabilitiesV2,
    customModels,
    supportsCompaction: true,
    // omp enforces the launch approval mode itself, and still asks in yolo for restricted
    // folders and critical commands. Every request that reaches T3 is for the user.
    permissionDisposition: () => "ask",
    extractElicitationForm: extractOmpElicitationForm,
    applyModelSelection: Effect.fn("OmpAdapter.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const option = findModelConfigOption(yield* runtime.getConfigOptions);
      const requested = yield* requestedModelId(modelSelection.model.trim());
      if (option === undefined || requested === undefined) return undefined;
      const offered =
        customModels.includes(requested) ||
        flattenSelectChoices(option.options).some((choice) => choice.value === requested);
      if (!offered) return undefined;
      if (option.currentValue !== requested) {
        yield* runtime.setConfigOption(option.id, requested);
      }
      return requested;
    }),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, ...input }) =>
        makeOmpAcpRuntime({
          ...input,
          ompSettings: options.settings,
          environment: options.environment,
          approvalMode: ompApprovalMode(runtimePolicy),
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
};

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeOmpAcpAdapterFlavor(options, spawner),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_DRIVER_KIND,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: OMP_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Oh My Pi ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
