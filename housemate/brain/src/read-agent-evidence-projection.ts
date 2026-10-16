import type { ReadAgentEvidence } from "./read-agent-contracts.js";

/**
 * The exact evidence projection serialized into both read-agent model calls.
 * Raw tool payloads stay inside trusted code and must not consume the model
 * context budget.
 */
export function projectReadAgentEvidenceForModel(
  evidence: ReadAgentEvidence,
): Readonly<Record<string, unknown>> {
  return {
    evidence_id: evidence.evidenceId,
    tool: evidence.tool,
    status: evidence.status,
    source: evidence.source,
    observed_at: evidence.observedAt,
    privacy: evidence.privacy,
    entity_ids: evidence.entityIds,
    source_labels: evidence.sourceLabels,
    cached: evidence.cached,
    truncated: evidence.truncated,
    // Only this safe completeness bit crosses the trust boundary. Detailed
    // adapter diagnostics remain in the private payload.
    source_complete: evidence.tool !== "search_media"
      || evidence.payload.complete === true,
    state_revision: evidence.stateRevision,
    registry_revision: evidence.registryRevision,
    software_facts: evidence.facts.map((fact) => ({
      fact_id: fact.factId,
      kind: fact.kind,
      text: fact.text,
    })),
    error_code: evidence.errorCode,
  };
}
