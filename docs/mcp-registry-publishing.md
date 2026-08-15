# Publishing to the MCP Registry

This is the canonical operator guide for publishing the hosted Expense Budget
Tracker MCP server to the official MCP Registry. The Registry manifest is the
root [`server.json`](../server.json). Publication is intentionally manual and
independent of the ordinary application deploy.

The server uses the DNS-owned Registry name
`com.expense-budget-tracker/expense-budget-tracker` and the hosted Streamable
HTTP endpoint `https://mcp.expense-budget-tracker.com/mcp`. The DNS namespace is
authenticated by an Ed25519 ownership proof at `expense-budget-tracker.com`.

The MCP Registry is preview software. Recheck the official
[authentication](https://modelcontextprotocol.io/registry/authentication),
[remote-server](https://modelcontextprotocol.io/registry/remote-servers), and
[versioning](https://modelcontextprotocol.io/registry/versioning) requirements
before credential setup or publication.

## What is published

`server.json` publishes metadata only. It points clients to the existing remote
server and does not package or deploy application code. The manifest includes:

- the domain-owned Registry name and shared product version;
- the public GitHub repository and stable repository identifier;
- the hosted Streamable HTTP MCP endpoint;
- first-party website, [MCP connector guide](https://expense-budget-tracker.com/docs/mcp-connector/),
  API documentation, support, privacy, and terms links;
- SVG and PNG icons; and
- publisher metadata describing categories, authentication, and the four tools.

The publisher-provided metadata must remain below the Registry's 4,096-byte
limit. Keep detailed operational documentation in the linked pages instead of
expanding the manifest indefinitely.

## Pull-request validation

The required `PR Quality Gate` runs the shared version-alignment checker on
every pull request. When `server.json` or either Registry workflow changes, the
same required job also downloads the pinned 2025-12-11 schema and validates the
manifest. These checks do not use `MCP_PRIVATE_KEY` and cannot publish.

Do not create a separate version checker or Registry validation workflow. Keep
the shared version in `server.json` aligned by following
[`version-bump.md`](version-bump.md).

## Prerequisites

Complete credential setup and first publication only after this workflow and
manifest have been promoted to `main` and an operator has approved the external
writes.

The setup operator needs:

- repository-admin access through an authenticated GitHub CLI session;
- `curl`, `dig`, `gh`, `openssl`, `python3`, and `base64`;
- `scripts/cloudflare/.env` with `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ZONE_ID`; and
- a Cloudflare token that can read the zone and create DNS records for
  `expense-budget-tracker.com`.

The setup script verifies that the current checkout resolves to
`kirill-markin/expense-budget-tracker` and that the configured Cloudflare zone
is exactly `expense-budget-tracker.com` before it writes anything.

## One-time credential setup

From the repository root on `main`, run:

```sh
bash scripts/cloudflare/setup-mcp-registry-credential.sh
```

The script reads the existing gitignored Cloudflare credentials, inspects all
root TXT records and the GitHub secret list, and changes state only when both the
MCP ownership proof and `MCP_PRIVATE_KEY` are absent. It then:

1. generates one Ed25519 keypair in a restricted temporary directory;
2. adds one root TXT record in the form
   `v=MCPv1; k=ed25519; p=<PUBLIC_KEY>` without replacing unrelated TXT records;
3. re-reads Cloudflare state and stores the 64-character private key as the
   `MCP_PRIVATE_KEY` GitHub Actions secret;
4. verifies the exact proof through Cloudflare and Google public DNS resolvers;
   and
5. removes local key material without printing the private key.

When both the valid TXT proof and GitHub secret already exist, the script
verifies public DNS and exits without rotating the credential. It fails on a
malformed, duplicate, or one-sided state and prints the corresponding recovery
action.

## Manual publication

Before dispatching, confirm every URL in `server.json` is public and returns the
intended content or authentication response. In particular, verify the MCP
guide, API guide, support, privacy, terms, three icon URLs, and the hosted MCP
endpoint.

Confirm that the exact manifest version is still absent. Read the version from
`server.json`, require a valid SemVer string, and URL-encode it so the preflight
always targets the manifest being published. The `&&` prevents `curl` from
running when extraction or validation fails:

```sh
encoded_server_version="$(
python3 <<'PY'
import json
import re
from pathlib import Path
from urllib.parse import quote

semver_pattern = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
manifest = json.loads(Path("server.json").read_text(encoding="utf-8"))
if not isinstance(manifest, dict):
    raise TypeError("server.json must contain a JSON object")
version = manifest.get("version")
if not isinstance(version, str) or semver_pattern.fullmatch(version) is None:
    raise ValueError("server.json version must be a valid SemVer string")
print(quote(version, safe=""))
PY
)" && curl -i \
  "https://registry.modelcontextprotocol.io/v0.1/servers/com.expense-budget-tracker%2Fexpense-budget-tracker/versions/${encoded_server_version}"
```

HTTP 404 is the publishable state. HTTP 200 means the immutable version already
exists and must not be republished with changed metadata.

Dispatch the workflow explicitly from `main`:

```sh
gh workflow run mcp-registry-publish.yml \
  --repo kirill-markin/expense-budget-tracker \
  --ref main
```

The workflow rejects every non-`main` ref. Before reading the private key, it
validates `server.json`, runs the shared version checker, and confirms that the
exact name/version returns 404. It then downloads the current official
`mcp-publisher`, authenticates the DNS namespace, publishes, retries exact
version verification, and writes a secret-free GitHub job summary.

## Successful verification

Read the exact published record:

```sh
server_version="$(jq -r '.version' server.json)"
curl -fsS \
  "https://registry.modelcontextprotocol.io/v0.1/servers/com.expense-budget-tracker%2Fexpense-budget-tracker/versions/${server_version}"
```

Also check the Registry's latest search result:

```sh
curl -fsS \
  'https://registry.modelcontextprotocol.io/v0.1/servers?search=com.expense-budget-tracker%2Fexpense-budget-tracker&version=latest'
```

Confirm the returned name, version, remote URL, repository identity, website,
documentation, support, privacy, terms, and icon URLs. A successful workflow
summary records the published commit and exact verification endpoint without
including credentials.

## Immutable-version behavior

Registry name/version pairs are immutable. The manual workflow treats:

- HTTP 404 from the exact version endpoint as permission to continue; and
- HTTP 200 as a hard duplicate error requiring a later shared product version.

Do not edit and retry an already published version. Do not switch back to the
abandoned `io.github.kirill-markin/expense-budget-tracker` identity.

## Publication after a version bump

Use this order for every later release:

1. Follow [`version-bump.md`](version-bump.md) so every product, runtime,
   lockfile, and `server.json` version is identical.
2. Merge and promote the release to `main` through the normal reviewed flow.
3. Confirm the deployed remote and every public manifest URL are healthy.
4. Confirm the new exact Registry name/version returns 404.
5. Dispatch `mcp-registry-publish.yml` from `main`.
6. Verify the exact record and latest search response.

Application deployment does not publish Registry metadata automatically.

## Credential recovery and rotation

The GitHub secret value cannot be read back. The setup script therefore refuses
to guess whether a one-sided state matches and never rotates credentials
silently.

- TXT proof present, secret missing: restore the original matching private key
  as `MCP_PRIVATE_KEY`. If it is unavailable, remove only that MCP ownership TXT
  record, verify its public disappearance, and rerun the setup script.
- Secret present, TXT proof missing: restore the matching public proof if the
  private key is recoverable. Otherwise delete `MCP_PRIVATE_KEY` and rerun after
  confirming that no MCP ownership TXT record remains.
- Multiple or malformed MCP proofs: determine which key is intended, then
  remove only the duplicate or malformed records beginning with `v=MCPv1;`.
  Preserve SPF, DKIM, site-verification, and every other unrelated TXT record.
- Ambiguous GitHub secret update: inspect whether `MCP_PRIVATE_KEY` exists. For
  a clean rotation, delete both the secret and only its matching MCP ownership
  TXT proof before rerunning.

Credential deletion and DNS changes are deliberate operator actions. Perform
them only with explicit approval and never as part of ordinary deployment or
pull-request validation.
