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
npm publish     # ships dist/ (files: ["dist"]); needs npm auth + 2FA
```

## Non-obvious decisions

- **Multipart via the legacy `this.helpers.request` helper** (publish + update
  only), with a scoped `eslint-disable @n8n/community-nodes/no-deprecated-workflow-functions`.
  n8n's modern `httpRequest` does not reliably build multipart FormData bodies;
  this is the same choice the shipstatic node made. Every JSON operation uses the
  modern `httpRequestWithAuthentication` instead.
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
