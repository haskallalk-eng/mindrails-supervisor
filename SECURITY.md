# Security

This is an advisory assessment utility. A finish result cannot authorize a purchase, deployment, data change or other action. Hosts must enforce permissions, approvals and authentic test results. Treat task data and model outputs as untrusted.

Use your host's secret environment for API keys. Never submit keys, personal data or proprietary traces in public issues. Raw provider errors and response bodies are not returned or logged. The Supervisor MCP assessment path does not persist the submitted content. The Jev app stores conversations, message text, activity and session identifiers locally in its state directory; plugins and panels also keep local state. Keep that directory private and exclude it from public repositories and shared backups. MCP hosts and configured model providers handle submitted data under their own policies.

For sensitive reports, use GitHub's private vulnerability reporting on this repository if available. Otherwise open an issue requesting a private reporting channel without including exploit details or secrets. Do not publish a credential. If one is exposed, revoke it at its provider.

Security reports should target the latest published repository revision (currently package version 0.8.0). This is a finished preview without a guaranteed maintenance schedule. Review dependencies and limits before production use. Do not expose stdio through an unauthenticated remote proxy.
