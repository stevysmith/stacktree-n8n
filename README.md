# n8n-nodes-stacktree

An [n8n](https://n8n.io) community node for [Stacktree](https://stacktr.ee) — the publish primitive for the HTML your agents make. Publish a page to a private, unguessable URL, gate it behind a password or a client's email domain, expire or burn it, and read the feedback viewers leave on it.

Works as a regular workflow node and as a tool inside n8n AI Agent workflows (`usableAsTool`).

## Why this over a generic static host

Stacktree is private by default and built for agent-made deliverables:

- **Private-by-default** unguessable link, `X-Robots-Tag: noai` on every page. Opt into a public slug only when you want one.
- **Gating** a password, or an email-domain gate where the viewer proves they own an `@yourclient.com` address via a magic link, no account.
- **Lifetime control** expiry, or burn-after-read (the page deletes itself after the first open).
- **A pre-flight secret scan** that can block a publish carrying a leaked API key.
- **The feedback loop** viewers annotate the page in place; you read the annotations and resolve them. No competitor in this category exposes this.

## Installation

In n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-stacktree`.

## Credentials

Publishing works with **no credentials** — the link is anonymous, expires in 24 hours, and the response includes a `claim_token` you can use to adopt the page into an account later.

Add a **Stacktree API** credential (an API key from [app.stacktr.ee](https://app.stacktr.ee)) to make links permanent and unlock every other operation: update, get, list, delete, gating, and feedback.

## Operations

### Site

| Operation | What it does |
| --- | --- |
| **Publish** | Upload HTML (text) or a file/zip (binary) and get back a private URL. Options: password, public slug, expiry, burn-after-read, feedback toolbar, PII scan. |
| **Update** | Replace the content at an existing URL in place. The URL does not change. |
| **Set Options** | Change gating and lifetime: password, email-domain gate, expiry, public slug, feedback toolbar, title. Only the fields you add are changed. |
| **Get** | Fetch a site's metadata. |
| **Get Content** | Return the exact stored HTML, so you can edit it and Update in place. |
| **List** | List every site owned by the API key. |
| **Delete** | Permanently delete a site. |

### Feedback

| Operation | What it does |
| --- | --- |
| **List** | Read the annotations viewers left via the on-page toolbar (unresolved first). |
| **Resolve** | Mark a feedback item addressed after fixing the page, with an optional note. |

The full loop, entirely in n8n: **Publish** with the feedback toolbar on → viewer annotates → **Feedback: List** → **Update** the page → **Feedback: Resolve**.

## Example: publish a Claude artifact privately

1. A previous node produces HTML (e.g. from an AI model).
2. **Stacktree → Site → Publish**, Content Source `HTML Text`, map the HTML in.
3. Under Options, set a password and Expiry `168`.
4. The node outputs `{ url, id, unlisted_token, expires_at, ... }` — send `url` on to Slack, email, wherever.

## Development

```bash
npm install
npm run dev     # hot-reload against a local n8n
npm run build   # emit dist/
npm run lint
```

Built with [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli).

## License

MIT
