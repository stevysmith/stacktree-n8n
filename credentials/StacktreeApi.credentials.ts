import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class StacktreeApi implements ICredentialType {
	name = 'stacktreeApi';

	displayName = 'Stacktree API';

	icon: Icon = 'file:stacktree.svg';

	documentationUrl = 'https://stacktr.ee/mcp-publish-html';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your Stacktree API key. Create one in the dashboard at app.stacktr.ee. Publishing works without a key (anonymous links expire in 24 hours and return a claim token); a key makes links permanent and unlocks update, delete, list, gating, and the feedback loop.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.stacktr.ee',
			description: 'API base URL. Only change this for self-hosted Stacktree.',
		},
	];

	// Bearer token on every request.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Lists the caller's sites — a cheap authenticated GET that fails cleanly on a bad key.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/sites',
			method: 'GET',
		},
	};
}
