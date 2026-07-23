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
// This node mirrors the API surface the MCP server exposes (packages/mcp-server):
// publish/update/get/list/delete a site, set its gating and lifetime, and read +
// resolve the on-page feedback viewers leave. Publishing works without a
// credential (anonymous, 24h link, returns a claim token); every other operation
// needs an API key.

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
					{ name: 'Site', value: 'site' },
					{ name: 'Feedback', value: 'feedback' },
				],
				default: 'site',
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

			// ----- Site ID or Slug (shared) -------------------------------------
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
						resource: ['site', 'feedback'],
						operation: ['update', 'set', 'get', 'getContent', 'delete', 'list'],
					},
					hide: {
						resource: ['site'],
						operation: ['list'],
					},
				},
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
						displayName: 'Expiry (Hours)',
						name: 'expiresInHours',
						type: 'string',
						default: '',
						placeholder: '168, or "never"',
						description:
							'Lifetime in hours, or "never" for a permanent link (requires an API key). Empty uses the server default.',
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
						description: 'Gate the page behind a password',
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
						displayName: 'Email Domain Gate',
						name: 'allowedEmailDomain',
						type: 'string',
						default: '',
						placeholder: 'acme.com',
						description:
							'Restrict viewing to a company email domain (viewers verify via a magic link)',
					},
					{
						displayName: 'Expiry (Hours)',
						name: 'expiresInHours',
						type: 'string',
						default: '',
						placeholder: '168, or "never"',
						description: 'New lifetime in hours, or "never"',
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
						description: 'Set a password on the site',
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
							if (opts.expiresInHours) fields.expires_in_hours = String(opts.expiresInHours);
							if (opts.burnAfterRead) fields.burn_after_read = 'true';
							if (opts.agentation) fields.agentation = 'true';
							if (opts.piiCheck) fields.pii_check = opts.piiCheck as string;
							// Authenticated when a key is present (owned, permanent), anonymous otherwise.
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
						responseData = (await authedRequest(this, 'GET', `${baseUrl}/sites`)) as IDataObject[];
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
