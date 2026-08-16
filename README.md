# n8n-nodes-stacktree

An [n8n](https://n8n.io) community node for [Stacktree](https://stacktr.ee) — the publish primitive for the HTML your agents make. Publish a page to a private, unguessable URL, gate it behind a password or a client's email domain, expire or burn it, and read the feedback viewers leave on it.

Works as a regular workflow node and as a tool inside n8n AI Agent workflows (`usableAsTool`).

## Why this over a generic static host

Stacktree is private by default and built for agent-made deliverables:

- **Private-by-default** unguessable link, `X-Robots-Tag: noai` on every page. Opt into a public slug only when you want one.
- **Gating** a passcode, or an email-domain gate where the viewer proves they own an `@yourclient.com` address via a magic link, no account. The passcode works on an anonymous publish and on a paid plan; the email-domain gate is paid-plan only.
- **Lifetime control** expiry, or burn-after-read (the page deletes itself after the first open).
- **A pre-flight secret scan** that can block a publish carrying a leaked API key.
- **The feedback loop** viewers annotate the page in place; you read the annotations and resolve them. No competitor in this category exposes this.

## Installation

In n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-stacktree`.

## Credentials

Publishing works with **no credentials** — the link is anonymous, expires in 24 hours, and the response includes a `claim_token` you can use to adopt the page into an account later.

Add a **Stacktree API** credential (an API key from [app.stacktr.ee](https://app.stacktr.ee)) for every other operation: update, get, list, delete, gating, and feedback.

## What the account's plan changes

The node sends what you configure; the API applies the account's plan on top:

| | Anonymous | Free | Paid, from $19/mo |
| --- | --- | --- | --- |
| Pages | — | 3 in total | 25 active, or unlimited |
| Page lifetime | 24 hours | 7 days | permanent unless you set an expiry |
| Passcode | ✓ | — | ✓ |
| Email-domain gate | — | — | ✓ |

Free's 3 is a lifetime count: deleting a page does not give the slot back. Expiry is **clamped, not refused**: `"never"` on a free account comes back as 7 days from now, so read `expires_at` off the node output rather than assuming. Everything else that a plan does not cover fails loudly with an HTTP 402 and a `plan_*` error code (`plan_lifetime_limit_exceeded`, `plan_password_not_available`, `plan_viewer_gate_not_available`), which surfaces as a node error you can branch on. Current plans: <https://stacktr.ee/pricing>.

## Operations

### Site

| Operation | What it does |
| --- | --- |
| **Publish** | Upload HTML (text) or a file/zip (binary) and get back a private URL. Options: password, public slug, expiry, burn-after-read, feedback toolbar, PII scan. |
| **Update** | Replace the content at an existing URL in place. The URL does not change. |
| **Set Options** | Change gating, lifetime and filing: password, email-domain gate, expiry, public slug, feedback toolbar, title, and the client space this page is filed under (or Detach to unfile it). Only the fields you add are changed. |
| **Get** | Fetch a site's metadata. |
| **Get Content** | Return the exact stored HTML, so you can edit it and Update in place. |
| **List** | List sites owned by the API key. Return All follows the API's keyset cursor across pages; filter by Client Space to list one client's deliverables. |
| **Delete** | Permanently delete a site. |

### Client Space

A client space groups everything you publish for one client. Filing is free on every plan; on a paid plan the space can take the client's own address (`acme.youragency.com`), serve a generated portal, and carry one passcode that opens every page in it. Publishing with a Client Space creates the space on first use, so these operations are for managing spaces, never a prerequisite for filing.

| Operation | What it does |
| --- | --- |
| **Create** | Set a client up before any work is published for them. Idempotent with the auto-create: an existing space of the same name comes back rather than a duplicate. |
| **Update** | Rename, archive or unarchive, or set the space-wide viewer gate (passcode or email domain) that every page in the space inherits. |
| **Get** | One space with its pages, portal state, and connected address. |
| **List** | Every space on the account, most recently active first, with page counts and hostname. |
| **Delete** | Remove the space. Its pages are **not** deleted, they detach and keep their URLs — but the space-wide gate goes with it, so gate those pages first. Prefer Update → Archived when a client is simply finished. |

### Feedback

| Operation | What it does |
| --- | --- |
| **List** | Read the annotations viewers left via the on-page toolbar (unresolved first). |
| **Resolve** | Mark a feedback item addressed after fixing the page, with an optional note. |

The full loop, entirely in n8n: **Publish** with the feedback toolbar on → viewer annotates → **Feedback: List** → **Update** the page → **Feedback: Resolve**.

## Example: publish a Claude artifact privately

1. A previous node produces HTML (e.g. from an AI model).
2. **Stacktree → Site → Publish**, Content Source `HTML Text`, map the HTML in.
3. Under Options, set Expiry `168` (and a passcode, if the account's plan includes one).
4. The node outputs `{ url, id, unlisted_token, expires_at, ... }` — send `url` on to Slack, email, wherever.

## Development

```bash
npm install
npm run dev     # hot-reload against a local n8n
npm run build   # emit dist/
npm run lint
```

Built with [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli).

## Changes in 0.2.0

- **Client Space resource** (create, get, list, update, delete), plus filing and detaching from **Site → Set Options** and a Client Space filter on **Site → List**.
- **Fixed: the "Site ID or Slug" field did not render on any screen in 0.1.2.** A `displayOptions.hide` block with two keys hides on *either* one, so Site Get / Get Content / Update / Set Options / Delete and Feedback List had no field to type the id into. If you are on 0.1.2, upgrade.
- **Breaking: `Site → List` now emits one item per site.** It previously emitted a single item holding the whole `{ sites, has_more, … }` envelope. Remove any Split Out node you added to work around that.

## License

MIT
