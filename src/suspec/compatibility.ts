import { ContractSchema, SUPPORTED_CONTRACT_VERSION } from "./contract.ts";
import { invoke_suspec, type SuspecEnv } from "./invoke.ts";

export async function require_supported_contract(env: SuspecEnv): Promise<void> {
  const result = await invoke_suspec(env, "check", [], {
    bare: ["--contract"],
    schema: ContractSchema,
    output: "json",
  });
  if (result.kind === "ok") {
    return;
  }
  const detail =
    result.kind === "launch-error"
      ? result.message
      : JSON.stringify(result.data);
  throw new Error(
    `suspec CLI must implement checks contract ${SUPPORTED_CONTRACT_VERSION}: ${detail}`,
  );
}
