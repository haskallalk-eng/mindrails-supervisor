# Source and dependency provenance

All product source, fixtures and documentation were created independently for this repository. No existing customer application, private repository source, conversation export or competitor implementation was copied. Examples use synthetic release requirements and fake transport responses.

Apache-2.0 was selected for this original code to provide explicit patent-license terms and clear redistribution conditions. It does not license TypeSafe's service, model, trademarks or documentation. The complete Apache license is from https://www.apache.org/licenses/LICENSE-2.0.txt.

Runtime dependencies are installed from the npm registry with exact versions in package-lock.json; their license files remain in node_modules when installed. The release package does not bundle node_modules. The MCP server/client/core supplied LICENSE files describe a transition: new and relicensed code uses Apache-2.0; contributions without relicensing permission remain MIT; non-spec documentation uses CC-BY-4.0. npm metadata still reports MIT and is not the full licensing statement. Zod and Node types use MIT, TypeScript uses Apache-2.0. See the generated dependency inventory for package metadata; actual supplied licenses govern. No MCP documentation or implementation is copied into this package.

Public technical references checked 2026-09-23:

- https://docs.typesafe.ai/api — HTTP contract and Noul response.
- https://docs.typesafe.ai/models — pinned model.
- https://docs.typesafe.ai/confidence — signal interpretation.
- https://typesafe.ai/legal/mca — API integration and service terms.
- https://docs.typesafe.ai/legal — provider data policies.
- https://github.com/modelcontextprotocol/typescript-sdk — SDK packages.

No live Jev call or account modification was made. Mock transport tests are not live integration evidence. No measured savings, calibration, provider latency, SEO result or accuracy claim is made.
