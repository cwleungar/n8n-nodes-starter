import {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon
} from 'n8n-workflow';


export class VertexAiServiceAccountApi implements ICredentialType {
	name = 'vertexAiServiceAccountApi';
	displayName = 'Vertex AI Service Account API';
	documentationUrl = 'https://cloud.google.com/vertex-ai/docs/authentication';
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://www.googleapis.com',
			url: '/discovery/v1/apis', // Public Google discovery endpoint
			method: 'GET',
		},
	};

	icon= 'file:vertexAiServiceAccountApi.svg' as Icon;
	properties: INodeProperties[] = [
		{
			displayName: 'Service Account JSON (Base64)',
			name: 'serviceAccountJsonB64',
			type: 'string',
			typeOptions: {
				rows: 8,
				password: true,
			},
			default: '',
			required: true,
			description:
				'Base64 encoded Google service account JSON with Vertex AI and GCS access. Paste the full JSON, encode it as base64.',
		},
	];
}
