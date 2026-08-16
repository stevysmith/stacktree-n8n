import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { randomBytes } from 'node:crypto';

// Multipart upload for publish/update. Built as a raw Buffer body so it goes
// through the modern httpRequest helper: n8n strips source comments at build
// time, so a legacy `this.helpers.request` call cannot be lint-suppressed in the
// published dist (the community-package scanner lints the compiled .js and
// re-flags it). Sending a hand-built multipart body avoids the deprecated helper
// entirely. `authed` picks httpRequestWithAuthentication (credential injects the
// Bearer) vs httpRequest (anonymous publish).
async function multipartRequest(
	ctx: IExecuteFunctions,
	method: IHttpRequestMethods,
	url: string,
	file: { filename: string; contentType: string; buffer: Buffer },
	fields: Record<string, string>,
	authed: boolean,
): Promise<IDataObject> {
	const boundary = '----stacktree' + randomBytes(12).toString('hex');
	const CRLF = '\r\n';
	const chunks: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		chunks.push(
			Buffer.from(
				`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
			),
		);
	}
	chunks.push(
		Buffer.from(
			`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${file.filename}"${CRLF}Content-Type: ${file.contentType}${CRLF}${CRLF}`,
		),
	);
	chunks.push(file.buffer);
	chunks.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));

	const options: IHttpRequestOptions = {
		method,
		url,
		body: Buffer.concat(chunks),
		headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
		json: false, // body is raw bytes; parse the JSON response ourselves
	};
	const raw = authed
		? await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'stacktreeApi', options)
		: await ctx.helpers.httpRequest.call(ctx, options);
	return typeof raw === 'string' ? (raw ? (JSON.parse(raw) as IDataObject) : {}) : (raw as IDataObject);
}

// Stacktree publishes the HTML your agents make to a private, unguessable URL.
// This node covers the API surface the MCP server exposes
// (packages/mcp-server): publish/update/get/list/delete a site, set its gating
// and lifetime, file it under a client space, manage those spaces, and read +
// resolve the on-page feedback viewers leave. Publishing works without a
// credential (anonymous, 24h link, returns a claim token); every other
// operation needs an API key.
//
// Plan ceilings are enforced server-side (2026-08-13 tier restructure): a free
// account gets 3 pages in total with a 7-day life each and no passcode or email
// gate, and hits HTTP 402 with a plan_* code past that. Field descriptions here
// say so plainly rather than promising something the API will refuse — but they
// stay factual, no pitch: an n8n parameter hint is not an upgrade prompt.

// Every JSON operation is authenticated, so it goes through
// httpRequestWithAuthentication: the credential's Bearer header is injected by
// n8n, which keeps auth out of this file and picks up future token-refresh and
// audit-log improvements for free.
async function authedRequest(
	ctx: IExecuteFunctions,
	method: IHttpRequestMethods,
	url: string,
	opts: { body?: IDataObject; raw?: boolean } = {},
): Promise<unknown> {
	const options: IHttpRequestOptions = { method, url, json: !opts.raw };
	if (opts.body !== undefined) options.body = opts.body;
	return ctx.helpers.httpRequestWithAuthentication.call(ctx, 'stacktreeApi', options);
}

export class Stacktree implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stacktree',
		name: 'stacktree',
		icon: 'file:stacktree.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Publish agent-made HTML to a private URL, gate it, and read viewer feedback',
		defaults: { name: 'Stacktree' },
		// AI Agent nodes can call this directly, the whole point of an agent-first host.
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'stacktreeApi',
				// Optional: publishing works anonymously. Management operations validate
				// the key is present at runtime and error clearly if it is missing.
				required: false,
			},
		],
		properties: [
			// ----- Resource -----------------------------------------------------
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Client Space', value: 'clientSpace' },
					{ name: 'Feedback', value: 'feedback' },
					{ name: 'Site', value: 'site' },
				],
				default: 'site',
			},

			// ----- Client Space operations (alphabetized by name) ---------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['clientSpace'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a client space',
						description:
							'Set a client up before any work is published for them. Rarely needed: publishing with a Client Space creates it automatically.',
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a client space',
						description:
							'Delete the space. Its pages are not deleted: they detach to floating pages and keep their URLs. The space-wide passcode or email gate goes with it, so any page that carried no gate of its own becomes reachable by anyone holding its link; set a passcode on those pages first. When a client is simply finished, prefer Update with Archived instead: everything keeps serving, the plan slot is freed, and it can be undone.',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a client space',
						description: 'Fetch one space with its pages, portal state, and connected address',
					},
					{
						name: 'List',
						value: 'list',
						action: 'Get many client spaces',
						description: 'List every client space on the account, most recently active first',
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a client space',
						description:
							'Rename, archive or unarchive, or set the viewer gate covering every page in the space',
					},
				],
				default: 'list',
			},

			// ----- Site operations (alphabetized by name) -----------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['site'] } },
				options: [
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a site',
						description: 'Permanently delete a site',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a site',
						description: 'Fetch a site\'s URL, visibility, size, and settings',
					},
					{
						name: 'Get Content',
						value: 'getContent',
						action: 'Get site content',
						description: 'Return the exact stored HTML so you can edit it and update in place',
					},
					{
						name: 'List',
						value: 'list',
						action: 'Get many sites',
						description: 'List every site owned by the API key',
					},
					{
						name: 'Publish',
						value: 'publish',
						action: 'Publish a site',
						description: 'Upload HTML or a file and get back a private, unguessable link',
					},
					{
						name: 'Set Options',
						value: 'set',
						action: 'Set site options',
						description: 'Set password, email-domain gate, expiry, public slug, or the feedback toolbar',
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update a site',
						description: 'Replace the HTML at an existing URL. The URL stays the same.',
					},
				],
				default: 'publish',
			},

			// ----- Feedback operations ------------------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['feedback'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'Get many feedback items',
						description: 'Read the annotations viewers left via the on-page toolbar (unresolved first)',
					},
					{
						name: 'Resolve',
						value: 'resolve',
						action: 'Resolve a feedback item',
						description: 'Mark a feedback item addressed after fixing the page',
					},
				],
				default: 'list',
			},

			// ----- Client Space: identity + create -----------------------------
			{
				displayName: 'Space ID or Slug',
				name: 'spaceIdOrSlug',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'acme-co',
				description: 'Space ID or slug from the List operation. Not the display name.',
				displayOptions: {
					show: { resource: ['clientSpace'], operation: ['get', 'update', 'delete'] },
				},
			},
			{
				displayName: 'Name',
				name: 'spaceName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Acme Co',
				displayOptions: { show: { resource: ['clientSpace'], operation: ['create'] } },
				description:
					'Display name for the client space. Casing is kept for display but identity is case-insensitive, so a space that already answers to this name comes back instead of a duplicate.',
			},

			// ----- Client Space: Update fields (alphabetized by displayName) ---
			{
				displayName: 'Update Fields',
				name: 'spaceSettings',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['clientSpace'], operation: ['update'] } },
				description: 'Only the fields you add are changed. Leave a field out to keep it as is.',
				options: [
					{
						displayName: 'Archived',
						name: 'archived',
						type: 'boolean',
						default: false,
						description:
							'Whether the space is archived. Everything keeps serving (pages, portal, connected address) and the plan slot is freed. Unarchiving takes a slot back and returns 402 when the plan is full.',
					},
					{
						displayName: 'Clear Email Gate',
						name: 'clearEmailGate',
						type: 'boolean',
						default: false,
						description: 'Whether to remove the space-wide email-domain gate',
					},
					{
						displayName: 'Clear Passcode',
						name: 'clearPassword',
						type: 'boolean',
						default: false,
						description: 'Whether to remove the space-wide passcode',
					},
					{
						displayName: 'Email Domain Gate',
						name: 'allowedEmailDomain',
						type: 'string',
						default: '',
						placeholder: 'acme.com',
						description:
							'Restrict every page in the space to viewers who prove they own an address at this domain, via a one-time magic link. Strict-equal match, subdomains are not covered. Paid plans only; a free account gets a 402 plan_viewer_gate_not_available.',
					},
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						description:
							'New display name. The slug is a permanent addressing contract and never moves. A 409 name_taken means another active space already answers to that name.',
					},
					{
						displayName: 'Passcode',
						name: 'password',
						type: 'string',
						typeOptions: { password: true },
						default: '',
						description:
							'One passcode that opens every page in the space, entered once by the client with no account. A page carrying its own passcode keeps it. Paid plans only; a free account gets a 402 plan_password_not_available.',
					},
				],
			},

			// ----- Site ID or Slug (one property per resource) ------------------
			// Two properties rather than one with a `hide`. n8n ORs the keys inside
			// a hide block ("Any of the defined hide rules have to match" —
			// node-helpers.js displayParameter returns on the first match), so
			// `hide: { resource: ['site'], operation: ['list'] }` fires on
			// resource === 'site' ALONE. That hid the field for every combination
			// the show block allowed, leaving Site Get/Get Content/Update/Set
			// Options/Delete and Feedback List with nowhere to type the id — and
			// a non-displayed parameter is stripped from the saved node, so
			// execute() then threw rather than merely defaulting. The intended
			// condition ("site AND not list, OR feedback AND list") cannot be
			// expressed in a single property: show is AND across keys.
			{
				displayName: 'Site ID or Slug',
				name: 'idOrSlug',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'q3-report or the unlisted token',
				description: 'Site ID, public slug, or unlisted token',
				displayOptions: {
					show: {
						resource: ['site'],
						operation: ['update', 'set', 'get', 'getContent', 'delete'],
					},
				},
			},
			{
				displayName: 'Site ID or Slug',
				name: 'idOrSlug',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'q3-report or the unlisted token',
				description: 'Site ID, public slug, or unlisted token',
				displayOptions: { show: { resource: ['feedback'], operation: ['list'] } },
			},

			// ----- Site: List paging + filter -----------------------------------
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['site'], operation: ['list'] } },
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				displayOptions: {
					show: { resource: ['site'], operation: ['list'], returnAll: [false] },
				},
				description: 'Max number of results to return',
			},
			{
				displayName: 'Filters',
				name: 'listFilters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { resource: ['site'], operation: ['list'] } },
				options: [
					{
						displayName: 'Client Space',
						name: 'client',
						type: 'string',
						default: '',
						placeholder: 'Acme Co',
						description: 'Only return pages filed under this client space, by name or slug',
					},
				],
			},

			// ----- Content source (publish + update) ----------------------------
			{
				displayName: 'Content Source',
				name: 'contentSource',
				type: 'options',
				displayOptions: { show: { resource: ['site'], operation: ['publish', 'update'] } },
				options: [
					{ name: 'HTML Text', value: 'text', description: 'Paste or map HTML directly' },
					{ name: 'Binary File', value: 'binary', description: 'Use a file from a previous node' },
				],
				default: 'text',
			},
			{
				displayName: 'HTML',
				name: 'html',
				type: 'string',
				typeOptions: { rows: 8 },
				default: '',
				required: true,
				displayOptions: {
					show: { resource: ['site'], operation: ['publish', 'update'], contentSource: ['text'] },
				},
				description: 'The full HTML to publish',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: 'index.html',
				displayOptions: {
					show: { resource: ['site'], operation: ['publish', 'update'], contentSource: ['text'] },
				},
				description: 'Logical filename for the uploaded content',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: { resource: ['site'], operation: ['publish', 'update'], contentSource: ['binary'] },
				},
				hint: 'The name of the input binary field holding the file',
				description: 'An HTML file, or a .zip of a multi-file site',
			},

			// ----- Publish options (alphabetized by displayName) ----------------
			{
				displayName: 'Options',
				name: 'publishOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['site'], operation: ['publish'] } },
				options: [
					{
						displayName: 'Burn After Read',
						name: 'burnAfterRead',
						type: 'boolean',
						default: false,
						description: 'Whether to delete the page automatically after the first view',
					},
					{
						displayName: 'Client Space',
						name: 'client',
						type: 'string',
						default: '',
						placeholder: 'Acme Co',
						description:
							'Client space to file this page under, by name or slug. Auto-created if it does not exist. Leave empty for a floating page. Requires an API key credential; ignored on anonymous publishes.',
					},
					{
						displayName: 'Expiry (Hours)',
						name: 'expiresInHours',
						type: 'string',
						default: '',
						placeholder: '168, or "never"',
						description:
							'Lifetime in hours, or "never" for a permanent link. Clamped to the account ceiling rather than refused: anonymous caps at 24 hours, a free account at 7 days (168), paid plans have no ceiling. Empty uses the server default. Check expires_at on the output for what the page got.',
					},
					{
						displayName: 'Feedback Toolbar (Agentation)',
						name: 'agentation',
						type: 'boolean',
						default: false,
						description:
							'Whether to inject the on-page feedback toolbar so viewers can annotate the page',
					},
					{
						displayName: 'Password',
						name: 'password',
						type: 'string',
						typeOptions: { password: true },
						default: '',
						description:
							'Gate the page behind a passcode. Anonymous publishes and paid plans only; a free account gets a 402 plan_password_not_available.',
					},
					{
						displayName: 'PII Scan',
						name: 'piiCheck',
						type: 'options',
						options: [
							{ name: 'Warn', value: 'warn', description: 'Publish but flag detected secrets in a response header' },
							{ name: 'Block', value: 'block', description: 'Reject the publish if secrets are detected' },
							{ name: 'Off', value: 'off', description: 'Skip the pre-flight scan' },
						],
						default: 'warn',
						description: 'Pre-flight scan for API keys, credentials, and PII before the page goes live',
					},
					{
						displayName: 'Public Slug',
						name: 'publicSlug',
						type: 'string',
						default: '',
						placeholder: 'q3-report',
						description:
							'Opt into a memorable {slug}.stacktr.ee URL. Leave empty for a private unlisted link.',
					},
				],
			},

			// ----- Update options -----------------------------------------------
			{
				displayName: 'Update Fields',
				name: 'updateOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['site'], operation: ['update'] } },
				options: [
					{
						displayName: 'PII Scan',
						name: 'piiCheck',
						type: 'options',
						options: [
							{ name: 'Warn', value: 'warn' },
							{ name: 'Block', value: 'block' },
							{ name: 'Off', value: 'off' },
						],
						default: 'warn',
						description: 'Pre-flight scan for secrets and PII before the new content goes live',
					},
				],
			},

			// ----- Set Options fields (alphabetized by displayName) -------------
			{
				displayName: 'Update Fields',
				name: 'settings',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: { show: { resource: ['site'], operation: ['set'] } },
				description: 'Only the fields you add are changed. Leave a field out to keep it as is.',
				options: [
					{
						displayName: 'Clear Email Gate',
						name: 'clearEmailGate',
						type: 'boolean',
						default: false,
						description: 'Whether to remove the email-domain gate',
					},
					{
						displayName: 'Clear Password',
						name: 'clearPassword',
						type: 'boolean',
						default: false,
						description: 'Whether to remove the password gate',
					},
					{
						displayName: 'Client Space',
						name: 'client',
						type: 'string',
						default: '',
						placeholder: 'Acme Co',
						description:
							'File this page under a client space, by name or slug. Auto-created if it does not exist. Filing is free on every plan.',
					},
					{
						displayName: 'Detach From Client Space',
						name: 'detachClient',
						type: 'boolean',
						default: false,
						description:
							'Whether to unfile this page from its client space and return it to a floating page. The page keeps its URL.',
					},
					{
						displayName: 'Email Domain Gate',
						name: 'allowedEmailDomain',
						type: 'string',
						default: '',
						placeholder: 'acme.com',
						description:
							'Restrict viewing to a company email domain (viewers verify via a magic link). Paid plans only; a free account gets a 402 plan_viewer_gate_not_available.',
					},
					{
						displayName: 'Expiry (Hours)',
						name: 'expiresInHours',
						type: 'string',
						default: '',
						placeholder: '168, or "never"',
						description:
							'New lifetime in hours, or "never". Clamped to the account ceiling: a free account caps at 7 days (168), paid plans have no ceiling.',
					},
					{
						displayName: 'Feedback Toolbar (Agentation)',
						name: 'agentation',
						type: 'boolean',
						default: false,
						description: 'Whether the on-page feedback toolbar is injected',
					},
					{
						displayName: 'Password',
						name: 'password',
						type: 'string',
						typeOptions: { password: true },
						default: '',
						description:
							'Set a passcode on the site. Paid plans only; a free account gets a 402 plan_password_not_available.',
					},
					{
						displayName: 'Public Slug',
						name: 'publicSlug',
						type: 'string',
						default: '',
						description: 'Set a public slug',
					},
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
						description: 'Display name for the site',
					},
					{
						displayName: 'Unpublish (Back to Unlisted)',
						name: 'unpublish',
						type: 'boolean',
						default: false,
						description:
							'Whether to remove the public slug and return the site to a private unlisted link',
					},
				],
			},

			// ----- Feedback: Resolve --------------------------------------------
			{
				displayName: 'Feedback ID',
				name: 'feedbackId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['feedback'], operation: ['resolve'] } },
				description: 'Feedback item ID from the List operation',
			},
			{
				displayName: 'Resolution Note',
				name: 'resolutionNote',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['feedback'], operation: ['resolve'] } },
				description: 'Optional note describing what was changed to address the feedback',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Credential is optional. Publishing works anonymously; everything else
		// needs the key. Resolve base URL and the anonymous-publish auth header
		// once, tolerating the credential's absence.
		let apiKey: string | undefined;
		let baseUrl = 'https://api.stacktr.ee';
		try {
			const creds = await this.getCredentials('stacktreeApi');
			apiKey = (creds.apiKey as string) || undefined;
			if (creds.baseUrl) baseUrl = (creds.baseUrl as string).replace(/\/+$/, '');
		} catch {
			// No credential configured, anonymous publish only.
		}

		const requireAuth = (operation: string, itemIndex: number) => {
			if (!apiKey) {
				throw new NodeOperationError(
					this.getNode(),
					`The "${operation}" operation needs a Stacktree API key. Add a Stacktree credential, or use Publish (which works anonymously).`,
					{ itemIndex },
				);
			}
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let responseData: IDataObject | IDataObject[] | string;

				if (resource === 'site') {
					if (operation === 'publish' || operation === 'update') {
						// Read the file: either an HTML string or an upstream binary.
						const contentSource = this.getNodeParameter('contentSource', i) as string;
						let buffer: Buffer;
						let fileName: string;
						if (contentSource === 'binary') {
							const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
							this.helpers.assertBinaryData(i, binaryPropertyName);
							buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
							fileName = items[i].binary?.[binaryPropertyName]?.fileName || 'index.html';
						} else {
							const html = this.getNodeParameter('html', i) as string;
							fileName = (this.getNodeParameter('fileName', i) as string) || 'index.html';
							buffer = Buffer.from(html, 'utf8');
						}

						const contentType = fileName.toLowerCase().endsWith('.zip')
							? 'application/zip'
							: 'text/html';
						const file = { filename: fileName, contentType, buffer };

						if (operation === 'publish') {
							const opts = this.getNodeParameter('publishOptions', i) as IDataObject;
							const fields: Record<string, string> = {};
							if (opts.password) fields.password = opts.password as string;
							if (opts.publicSlug) fields.public_slug = opts.publicSlug as string;
							if (opts.client) fields.client = opts.client as string;
							if (opts.expiresInHours) fields.expires_in_hours = String(opts.expiresInHours);
							if (opts.burnAfterRead) fields.burn_after_read = 'true';
							if (opts.agentation) fields.agentation = 'true';
							if (opts.piiCheck) fields.pii_check = opts.piiCheck as string;
							// Authenticated when a key is present (owned, and permanent on a paid
							// plan), anonymous otherwise (24h link + a claim_token).
							responseData = await multipartRequest(this, 'POST', `${baseUrl}/sites`, file, fields, !!apiKey);
						} else {
							requireAuth('Update', i);
							const idOrSlug = this.getNodeParameter('idOrSlug', i) as string;
							const opts = this.getNodeParameter('updateOptions', i) as IDataObject;
							const fields: Record<string, string> = {};
							if (opts.piiCheck) fields.pii_check = opts.piiCheck as string;
							responseData = await multipartRequest(
								this,
								'PUT',
								`${baseUrl}/sites/${encodeURIComponent(idOrSlug)}`,
								file,
								fields,
								true,
							);
						}
					} else if (operation === 'get') {
						requireAuth('Get', i);
						const idOrSlug = this.getNodeParameter('idOrSlug', i) as string;
						responseData = (await authedRequest(
							this,
							'GET',
							`${baseUrl}/sites/${encodeURIComponent(idOrSlug)}`,
						)) as IDataObject;
					} else if (operation === 'getContent') {
						requireAuth('Get Content', i);
						const idOrSlug = this.getNodeParameter('idOrSlug', i) as string;
						const html = (await authedRequest(
							this,
							'GET',
							`${baseUrl}/sites/${encodeURIComponent(idOrSlug)}/content`,
							{ raw: true },
						)) as string;
						responseData = { id_or_slug: idOrSlug, html };
					} else if (operation === 'list') {
						requireAuth('List', i);
						const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
						const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i, 50) as number);
						const filters = this.getNodeParameter('listFilters', i, {}) as IDataObject;
						// Keyset pagination, not offset: the cursor is (updated_at, id), so a
						// page republished mid-scroll cannot make a row repeat or vanish.
						// The API caps a single request at 500.
						const sites: IDataObject[] = [];
						let before: number | null = null;
						let beforeId: string | null = null;
						for (;;) {
							const qs = new URLSearchParams();
							if (filters.client) qs.set('client', String(filters.client));
							qs.set('limit', String(Math.min(returnAll ? 200 : limit - sites.length, 500)));
							if (before !== null) qs.set('before', String(before));
							if (beforeId !== null) qs.set('before_id', beforeId);
							const page = (await authedRequest(
								this,
								'GET',
								`${baseUrl}/sites?${qs.toString()}`,
							)) as IDataObject;
							const batch = (page.sites as IDataObject[] | undefined) ?? [];
							sites.push(...batch);
							if (sites.length >= limit) {
								sites.length = limit;
								break;
							}
							// An empty batch also stops the loop: without it a server that
							// reported has_more with no rows would spin forever.
							if (!page.has_more || batch.length === 0) break;
							before = (page.next_before as number | null) ?? null;
							beforeId = (page.next_before_id as string | null) ?? null;
							if (before === null && beforeId === null) break;
						}
						// One item per site. The API answers with an envelope
						// ({ sites, has_more, ... }); emitting that verbatim made every
						// downstream node need a Split Out (changed in 0.2.0).
						responseData = sites;
					} else if (operation === 'delete') {
						requireAuth('Delete', i);
						const idOrSlug = this.getNodeParameter('idOrSlug', i) as string;
						responseData = (await authedRequest(
							this,
							'DELETE',
							`${baseUrl}/sites/${encodeURIComponent(idOrSlug)}`,
						)) as IDataObject;
					} else if (operation === 'set') {
						requireAuth('Set Options', i);
						const idOrSlug = this.getNodeParameter('idOrSlug', i) as string;
						const settings = this.getNodeParameter('settings', i) as IDataObject;
						const body: IDataObject = {};

						if (settings.clearPassword) body.password = null;
						else if (settings.password) body.password = settings.password;

						if (settings.clearEmailGate) body.allowed_email_domain = null;
						else if (settings.allowedEmailDomain) body.allowed_email_domain = settings.allowedEmailDomain;

						if (settings.expiresInHours !== undefined && settings.expiresInHours !== '') {
							const raw = String(settings.expiresInHours);
							body.expires_in_hours = raw === 'never' ? null : parseInt(raw, 10);
						}
						if (settings.unpublish) body.public_slug = null;
						else if (settings.publicSlug) body.public_slug = settings.publicSlug;

						// Detach wins over a name, same shape as the clear/set pairs above:
						// null is the API's explicit "unfile this page".
						if (settings.detachClient) body.client = null;
						else if (settings.client) body.client = settings.client;

						if (settings.agentation !== undefined) body.agentation = settings.agentation as boolean;
						if (settings.title) body.title = settings.title;

						if (Object.keys(body).length === 0) {
							throw new NodeOperationError(this.getNode(), 'Add at least one field to change.', {
								itemIndex: i,
							});
						}

						responseData = (await authedRequest(
							this,
							'PATCH',
							`${baseUrl}/sites/${encodeURIComponent(idOrSlug)}`,
							{ body },
						)) as IDataObject;
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown site operation: ${operation}`, {
							itemIndex: i,
						});
					}
				} else if (resource === 'clientSpace') {
					const SPACE_OP_LABEL: Record<string, string> = {
						create: 'Create Client Space',
						delete: 'Delete Client Space',
						get: 'Get Client Space',
						list: 'List Client Spaces',
						update: 'Update Client Space',
					};
					requireAuth(SPACE_OP_LABEL[operation] ?? operation, i);
					if (operation === 'list') {
						const res = (await authedRequest(this, 'GET', `${baseUrl}/spaces`)) as IDataObject;
						// One item per space. Pre-migration deployments answer { spaces: [] }
						// rather than erroring, so an empty array here is the day-one state.
						responseData = (res.spaces as IDataObject[] | undefined) ?? [];
					} else if (operation === 'get') {
						const idOrSlug = this.getNodeParameter('spaceIdOrSlug', i) as string;
						responseData = (await authedRequest(
							this,
							'GET',
							`${baseUrl}/spaces/${encodeURIComponent(idOrSlug)}`,
						)) as IDataObject;
					} else if (operation === 'create') {
						const name = this.getNodeParameter('spaceName', i) as string;
						responseData = (await authedRequest(this, 'POST', `${baseUrl}/spaces`, {
							body: { name },
						})) as IDataObject;
					} else if (operation === 'update') {
						const idOrSlug = this.getNodeParameter('spaceIdOrSlug', i) as string;
						const settings = this.getNodeParameter('spaceSettings', i) as IDataObject;
						const body: IDataObject = {};

						if (settings.clearPassword) body.password = null;
						else if (settings.password) body.password = settings.password;

						if (settings.clearEmailGate) body.allowed_email_domain = null;
						else if (settings.allowedEmailDomain) body.allowed_email_domain = settings.allowedEmailDomain;

						if (settings.name) body.name = settings.name;
						if (settings.archived !== undefined) body.archived = settings.archived as boolean;

						if (Object.keys(body).length === 0) {
							throw new NodeOperationError(this.getNode(), 'Add at least one field to change.', {
								itemIndex: i,
							});
						}
						responseData = (await authedRequest(
							this,
							'PATCH',
							`${baseUrl}/spaces/${encodeURIComponent(idOrSlug)}`,
							{ body },
						)) as IDataObject;
					} else if (operation === 'delete') {
						const idOrSlug = this.getNodeParameter('spaceIdOrSlug', i) as string;
						responseData = (await authedRequest(
							this,
							'DELETE',
							`${baseUrl}/spaces/${encodeURIComponent(idOrSlug)}`,
						)) as IDataObject;
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown client space operation: ${operation}`, {
							itemIndex: i,
						});
					}
				} else if (resource === 'feedback') {
					requireAuth(operation === 'list' ? 'List Feedback' : 'Resolve Feedback', i);
					if (operation === 'list') {
						const idOrSlug = this.getNodeParameter('idOrSlug', i) as string;
						responseData = (await authedRequest(
							this,
							'GET',
							`${baseUrl}/sites/${encodeURIComponent(idOrSlug)}/feedback`,
						)) as IDataObject[];
					} else if (operation === 'resolve') {
						const feedbackId = this.getNodeParameter('feedbackId', i) as string;
						const note = (this.getNodeParameter('resolutionNote', i) as string) || null;
						responseData = (await authedRequest(
							this,
							'POST',
							`${baseUrl}/feedback/${encodeURIComponent(feedbackId)}/resolve`,
							{ body: { note } },
						)) as IDataObject;
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown feedback operation: ${operation}`, {
							itemIndex: i,
						});
					}
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`, {
						itemIndex: i,
					});
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as IDataObject | IDataObject[]),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Re-raise our own validation errors with their message intact; wrap
				// anything else (transport / HTTP) as a node API error.
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error.message, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
