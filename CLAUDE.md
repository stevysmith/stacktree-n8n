# CLAUDE.md — n8n-nodes-stacktree

Context for working on the Stacktree n8n community node.

## What this is

An n8n community node that publishes agent-made HTML to a private stacktr.ee URL
and manages it (gate, expire, burn, read/resolve viewer feedback). Mirrors the
operation set of the Stacktree MCP server. Registered for n8n AI Agent workflows
via `usableAsTool: true`.

## Source of truth

This repo is the **public mirror**. Development happens in the Stacktree monorepo
at `packages/n8n`; changes are copied here (source only, no `dist`/`node_modules`)
for the public GitHub presence and the npm `repository` link. Same pattern as
`stacktree-mcp`. Keep the two in sync when editing.

## Layout

- `nodes/Stacktree/Stacktree.node.ts` — the node. Two resources (Site, Feedback),
  nine operations. Icon: `stacktree.svg` (same file also in `credentials/`).
- `credentials/StacktreeApi.credentials.ts` — optional API-key credential
  (Bearer), with a `GET /sites` credential test.
- Built with `@n8n/node-cli` (`n8n-node build|dev|lint`).

## Workflow

```bash
npm install
npm run dev     # local n8n with the node hot-linked (N8N_DEV_RELOAD)
npm run build   # emit dist/ (also runs on prepublishOnly)
npm run lint    # n8n community-node lint (must be 0 errors)
```

## Publishing (provenance required)

The n8n registry requires an npm **provenance** statement, which npm only
generates from CI via OIDC — a local `npm publish` cannot produce it and its
submission is blocked. Publish through `.github/workflows/publish.yml` instead:

1. Bump `version` in `package.json` (both this monorepo copy and the mirror repo).
2. Push to the `stacktree-n8n` mirror; trigger the **Publish** workflow (Actions
   tab → Run workflow, or push a `vX.Y.Z` tag).
3. Needs one repo secret `NPM_TOKEN` — a **Classic → Automation** npm token
   (the Automation type bypasses 2FA in CI; a Publish/granular token throws EOTP).
4. The workflow runs `npm publish --provenance --access public`.
5. Verify: `npx @n8n/scan-community-package n8n-nodes-stacktree` should pass, then
   resubmit at n8n's Submit Node Package form.

## Non-obvious decisions

- **Multipart built as a raw Buffer body, sent via the modern
  `httpRequest` (anonymous publish) / `httpRequestWithAuthentication` (authed)**,
  in the `multipartRequest` helper. Do NOT use the legacy `this.helpers.request`
  helper for this: the `@n8n/scan-community-package` security scanner (which the
  n8n registry runs before approval) lints the COMPILED `dist`, where source
  `eslint-disable` comments are gone, so a deprecated `this.helpers.request` call
  cannot be suppressed and fails the scan. Hand-building the multipart body
  (boundary + field parts + the file Buffer) avoids the deprecated helper
  entirely. Verified against the live API (special chars, binary, burn all pass).
- **Ship `.js` + `.svg` only.** `tsconfig` has `declaration: false` and
  `sourceMap: false` so `dist` carries no `.d.ts`/`.map`. The scanner lints every
  file in the tarball, and a shipped `StacktreeApi.credentials.d.ts` trips
  `n8n-nodes-base/cred-filename-against-convention`.
- **No `eslint-disable` anywhere.** Because the scanner may run with
  `--no-inline-config` and lints compiled output, every rule is satisfied for
  real (the catch reconstructs a `NodeOperationError`/`NodeApiError` rather than
  re-throwing a bare `error`).
- **Credential is optional.** Publishing works anonymously (24h link + a
  `claim_token` in the response). All other operations call `requireAuth` and
  error clearly without a key.
- **`NodeConnectionTypes` (plural)** is the runtime value in current n8n-workflow;
  `NodeConnectionType` (singular) is type-only and is `undefined` at runtime.
  Using the singular as a value crashes the node at load.
- Lint enforces: alphabetized options/collections, sentence-case actions,
  option descriptions with **no** trailing period (parameter descriptions **do**
  end with one), and `NodeApiError`/`NodeOperationError` for thrown errors.

## Testing

The compiled node's `execute()` can be driven through a mock `IExecuteFunctions`
to smoke-test against the live API (anonymous publish is safe: 24h TTL). The
mock-capture pattern (stub `httpRequestWithAuthentication` / `request`, assert the
outgoing method+url+body) covers every authed operation without a real key.
