import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import type { OmpSettings } from "../settings.ts";

export const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

/** Picks omp's own `modelRoles.default`. Never send this ID to omp. */
export const OMP_DEFAULT_MODEL = "default";

export const OMP_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

type OmpApprovalMode = "always-ask" | "write" | "yolo";

type OmpCommandSettings = Pick<OmpSettings, "binaryPath" | "profile">;

/**
 * argv overrides `tools.approvalMode` in the user's omp config, so Supervised cannot
 * inherit a configured yolo. Explicit T3 policy overrides launch in ask mode.
 */
export function ompApprovalMode(
  runtimePolicy: Pick<
    ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    "runtimeMode" | "approvalPolicy" | "sandboxPolicy"
  >,
): OmpApprovalMode {
  if (runtimePolicy.approvalPolicy !== undefined || runtimePolicy.sandboxPolicy !== undefined) {
    return "always-ask";
  }
  switch (runtimePolicy.runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "write";
    default:
      return "always-ask";
  }
}

function ompCommand(settings: OmpCommandSettings): string {
  return settings.binaryPath || "omp";
}

/** Every omp subcommand (acp, models, config, print mode) honors `OMP_PROFILE`. */
function ompEnvironment(
  settings: OmpCommandSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return settings.profile ? { ...environment, OMP_PROFILE: settings.profile } : environment;
}

export const runOmpCommand = Effect.fn("OmpCli.run")(function* (
  settings: OmpCommandSettings,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const command = ompCommand(settings);
  const env = ompEnvironment(settings, environment);
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env,
      shell: spawnCommand.shell,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
});

const decodeModelRoles = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      value: Schema.Struct({ default: Schema.optional(Schema.String) }),
    }),
  ),
);

/** `provider/id` of omp's default role, without its `:thinking` suffix. */
export function parseOmpDefaultModelRole(output: string): string | undefined {
  const role = Option.getOrUndefined(decodeModelRoles(output))?.value.default?.trim();
  if (!role) return undefined;
  const model = role.replace(/:[a-z]+$/, "");
  return model.includes("/") ? model : undefined;
}

export const resolveOmpDefaultModel = Effect.fn("OmpCli.resolveDefaultModel")(function* (
  settings: OmpCommandSettings,
  environment: NodeJS.ProcessEnv,
) {
  const result = yield* runOmpCommand(settings, environment, [
    "config",
    "get",
    "modelRoles",
    "--json",
  ]);
  return result.code === 0 ? parseOmpDefaultModelRole(result.stdout) : undefined;
});

function ompAcpSpawnArgs(approvalMode: OmpApprovalMode): ReadonlyArray<string> {
  return ["acp", "--approval-mode", approvalMode];
}

interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly ompSettings: OmpCommandSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly approvalMode: OmpApprovalMode;
}

export const makeOmpAcpRuntime = Effect.fn("OmpAcpSupport.makeOmpAcpRuntime")(function* ({
  ompSettings,
  environment,
  processEnvironment,
  approvalMode,
  ...input
}: OmpAcpRuntimeInput): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const processGroupPlatform = yield* HostProcess.Platform.pipe(Effect.provide(NodeServices.layer));
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: {
        command: ompCommand(ompSettings),
        args: [...ompAcpSpawnArgs(approvalMode)],
        cwd: input.cwd,
        env: { ...ompEnvironment(ompSettings, environment), ...processEnvironment },
      },
      // omp advertises only "agent": the credentials already stored under ~/.omp.
      authMethodId: "agent",
      ownDetachedProcessGroup: true,
      processGroupPlatform,
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});
