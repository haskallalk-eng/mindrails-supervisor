# Architecture and trust boundaries

CLI or stdio MCP → schema validation → deterministic host-check/evidence veto → process attempt/input budget → decision provider → validated signals → policy → advisory result.

The provider is replaceable through the narrow DecisionProvider interface. The mock implementation reads synthetic markers. Jev evaluates one question per requirement plus task fulfillment, evidence sufficiency and contradictions in one request. Internal question keys are independent of user IDs. Requests cannot redirect credentials and have no configurable endpoint. No SDK retry layer is used.

Completion policy version 0.1.0 evaluates each requirement separately; it does not average failures away. Transport errors, invalid responses and exhausted budgets produce review. Aborts terminate fetch; an injected provider which ignores AbortSignal may continue background work, so implementers must honor cancellation.

The `trustedChecks` field is a host-supplied claim, not an authenticated attestation. Do not let an untrusted agent manufacture those results. No absence of checks is proof tests ran. The evidence gate only requires supplied evidence; model evaluation cannot authenticate its origin or browse its sources.

No user-supplied string is executed. No file operation is exposed over MCP. The CLI reads only its explicitly supplied JSON file. Stdio transport is intended for a local host process. Do not expose it as an unauthenticated network service.

The product has no persistent state. Call and serialized-input-byte budgets apply per Supervisor instance/process. They do not measure monetary charges or protect across process restarts. Hosts own loop deadlines, durable quotas, permissions, approvals and final actions.
