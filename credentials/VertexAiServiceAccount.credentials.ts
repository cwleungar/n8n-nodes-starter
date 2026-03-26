import {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class VertexAiServiceAccount implements ICredentialType {
	name = 'vertexAiServiceAccount';
	displayName = 'Vertex AI Service Account';
	documentationUrl = '';

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
