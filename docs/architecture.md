# Architecture and trust boundaries

CLI or stdio MCP → schema validation → deterministic host-check and optional fact-check evidence veto → process attempt/input budget → decision provider → validated signals → policy → advisory result.

The provider is replaceable through the narrow DecisionProvider interface. The mock implementation reads synthetic markers. Jev evaluates one question per requirement plus task fulfillment, evidence sufficiency and contradictions in one request. Internal question keys are independent of user IDs. Requests cannot redirect credentials: the selected route maps only to the fixed native TypeSafe endpoint or the fixed Vercel TypeSafe-compatible endpoint. No arbitrary base URL and no SDK retry layer are provided.

Completion policy version 0.1.2 evaluates each requirement separately; it does not average failures away. Artifact mode is the default and checks whether requested content appears in the supplied result; it does not authenticate external claims. `fact-check` mode requires supplied evidence and applies the Jev evidence signal as a veto, but cannot authenticate sources. The initial threshold is 0.85 for requirements/task and fact-check evidence, and 0.1 maximum contradiction signal. Transport errors, invalid responses and exhausted budgets produce review. Aborts terminate fetch; an injected provider which ignores AbortSignal may continue background work, so implementers must honor cancellation.

The `evidenceMode` and `trustedChecks` fields are caller-supplied policy claims, not authenticated attestations. Do not let an untrusted agent choose fact-check mode or manufacture check results where those decisions matter. No absence of checks proves tests ran. Model evaluation cannot authenticate evidence origins or browse sources independently.

No user-supplied string is executed. No file operation is exposed over MCP. The CLI reads only its explicitly supplied JSON file. Stdio transport is intended for a local host process. Do not expose it as an unauthenticated network service.

The product has no persistent state. Call and serialized-input-byte budgets apply per Supervisor instance/process. They do not measure monetary charges or protect across process restarts. The repeat grace is caller supplied and capped at two extra cycles, but an untrusted agent can still request that allowance. Hosts own loop deadlines, durable quotas, permissions, approvals and final actions.
