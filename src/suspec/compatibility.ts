import { ContractSchema, SUPPORTED_CONTRACT_VERSION } from "./contract.ts";
import {
  invoke_suspec,
  type SuspecEnv,
  type SuspecResult,
} from "./invoke.ts";

export function require_supported_contract_result(result: SuspecResult): unknown {
  if (result.kind === "ok" && result.invocation.exitCode === 0) {
    return result.data;
  }
  const detail =
    result.kind === "launch-error"
      ? result.message
      : result.kind === "structured-error"
        ? `expected exit 0, received structured error at exit ${result.invocation.exitCode}: ${JSON.stringify(result.data)}`
        : `expected exit 0, received exit ${result.invocation.exitCode}`;
  throw new Error(
    `suspec CLI must implement checks contract ${SUPPORTED_CONTRACT_VERSION}: ${detail}`,
  );
}

export async function require_supported_contract(env: SuspecEnv): Promise<void> {
  const result = await invoke_suspec(env, "check", [], {
    bare: ["--contract"],
    schema: ContractSchema,
    output: "json",
  });
  require_supported_contract_result(result);
}
