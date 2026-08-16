# Version bumps

All deployed workspace packages, exact internal dependency pins, lockfile metadata, the MCP runtime and its integration assertion, the MCP Registry manifest, and current operational submission fields share one SemVer version. MCP Registry versions are immutable after publication, so the repository must be aligned before publication.

The root `package.json` and the root `package-lock.json` package entry are orchestration metadata and remain unversioned.

## Managed fields

Update each `version` field in these workspace manifests:

- `apps/auth/package.json`
- `apps/sql-api/package.json`
- `apps/web/package.json`
- `apps/worker/package.json`
- `infra/aws/package.json`
- `packages/agent-shared/package.json`

Update the matching `packages["<workspace path>"].version` fields in `package-lock.json` for all six workspaces.

Keep the exact `@expense-budget-tracker/agent-shared` dependency pin equal to the shared version in these manifests and their matching `package-lock.json` workspace entries:

- `apps/auth/package.json`
- `apps/sql-api/package.json`
- `apps/web/package.json`
- `infra/aws/package.json`

Update these MCP surfaces to the same version:

- `server.json`: `version`
- `apps/sql-api/src/mcp/server.ts`: the literal `SERVER_VERSION`
- `apps/sql-api/src/mcp/server.test.ts`: the `getServerVersion()` assertion's `version`

Update only these current operational fields in `docs/openai-mcp-submission.md`:

- Public listing package: `Version under evaluation`
- Public URL verification inventory: the G01 exact Registry version URL and the G02 expected exact record
- MCP server identity: `version`
- Evidence record: `Runtime version` and `Registry manifest identity/version`

Other live publication instructions derive or reference a managed field instead of repeating its version:

- `docs/openai-mcp-submission.md`: immutable-version safety and the pending publication checklist refer to G01
- `docs/mcp-registry-publishing.md`: the exact-version preflight validates and URL-encodes the SemVer read from `server.json` before calling `curl`

Do not replace those references with a version literal. Do not bulk-replace version literals in the dossier. Its only unmanaged product-version literals are fixed evidence labels: the historical Item 04 `server.json` summary attached to commit `8f0b330098fb8829f9f340a27501d73eb4b1860b`, the named `tools-list-v1.2.0-promotion-candidate-v1` snapshot wherever referenced, and the completed base-alignment checklist item. Keep those labels unchanged and add new evidence for a later version when needed.

## Procedure

1. Read the current aligned version from `packages/agent-shared/package.json` and calculate the requested SemVer increment:
   - Patch: `x.y.z` becomes `x.y.(z + 1)`.
   - Minor: `x.y.z` becomes `x.(y + 1).0`.
   - Major: `x.y.z` becomes `(x + 1).0.0`.
2. Treat “bump the minor version” as the normal request. For example, `1.2.0` becomes `1.3.0`.
3. Update every managed manifest version, exact internal pin, lockfile field, MCP runtime and test assertion, `server.json`, and current operational dossier field together in one pull request.
4. Let the required `PR Quality Gate` run `scripts/checks/pr/check-version-alignment.mjs` and confirm that every managed value is the same valid SemVer version.
5. Review and merge the version-bump pull request before manually dispatching the MCP Registry publication workflow for that version.

Never attempt to republish a version already present in the MCP Registry. Publish another version for any metadata correction, including a correction that does not change application behavior.
