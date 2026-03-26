import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { getVertexAccessToken } from '../utils';

interface VertexError {
	error?: {
		message: string;
		status: string;
	};
	candidates?: Array<{
		content: {
			parts: Array<{
				text?: string;
			}>;
		};
	}>;
}

export class GeminiMediaToolVertex implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Gemini Media Tool (Vertex AI)',
		name: 'geminiMediaToolVertex',
		icon: 'file:geminiMediaTool.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		description: 'Call Gemini 3.1 Pro via Vertex AI with pre-uploaded GCS file links',
		defaults: {
			name: 'Gemini Media Tool (Vertex)',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'vertexAiServiceAccountApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Project ID',
				name: 'projectId',
				type: 'string',
				default: '',
				required: true,
				description: 'GCP project ID used for Vertex AI',
			},
			{
				displayName: 'Location',
				name: 'location',
				type: 'string',
				default: 'us-central1',
				required: true,
				description: 'Vertex AI region, for example "us-central1"',
			},
			{
				displayName: 'Model ID',
				name: 'modelId',
				type: 'string',
				default: 'gemini-1.5-pro-002',
				required: true,
				description: 'Vertex AI Gemini model ID, e.g. "gemini-1.5-pro-002"',
			},
			{
				displayName: 'User Prompt',
				name: 'userPrompt',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				description: 'The text prompt that will be sent to Gemini',
			},
			{
				displayName: 'Media File Links (JSON Array)',
				name: 'mediaLinksJson',
				type: 'json',
				default:
					'[\n  {\n    "fileUri": "gs://your-bucket/agent-media/hash-file.png",\n    "mimeType": "image/png"\n  }\n]',
				required: true,
				description:
					'JSON array of pre-uploaded GCS files with "fileUri" (gs:// format) and "mimeType". Upload files first with Files To GCP Storage node.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const projectId = this.getNodeParameter('projectId', i) as string;
				const location = this.getNodeParameter('location', i) as string;
				const modelId = this.getNodeParameter('modelId', i) as string;
				const userPrompt = this.getNodeParameter('userPrompt', i) as string;
				const mediaInput = this.getNodeParameter(
					'mediaLinksJson',
					i,
				) as string | Array<{ fileUri: string; mimeType: string }>;

				// 1. Get access token
				const { accessToken } = await getVertexAccessToken(this);

				// 2. Parse media links array
				const mediaArray =
					typeof mediaInput === 'string'
						? JSON.parse(mediaInput)
						: mediaInput;

				if (!Array.isArray(mediaArray)) {
					throw new NodeOperationError(this.getNode(), 'Media File Links must be a valid JSON array.');
				}

				// Validate each file link
				const mediaParts: Array<{ fileData: { fileUri: string; mimeType: string } }> = [];
				for (const fileObj of mediaArray) {
					const { fileUri, mimeType } = fileObj;
					if (!fileUri || !mimeType) {
						throw new NodeOperationError(this.getNode(), 
							'Each media object must contain "fileUri" (gs:// format) and "mimeType" fields.',
						);
					}
					// if (!fileUri.startsWith('gs://')) {
					// 	throw new NodeOperationError(this.getNode(), `fileUri must be GCS format (gs://...). Got: ${fileUri}`);
					// }
					mediaParts.push({
						fileData: {
							fileUri,
							mimeType,
						},
					});
				}

				// 3. Call Gemini via Vertex AI
				const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

				const parts = [{ text: userPrompt }, ...mediaParts];

				const vertexOptions: IHttpRequestOptions = {
					method: 'POST',
					url: vertexUrl,
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json',
					},
					body: {
						contents: [
							{
								role: 'user',
								parts,
							},
						],
					},
					ignoreHttpStatusErrors: true,
				};

				const vertexResp = (await this.helpers.httpRequest(vertexOptions)) as VertexError;

				if (vertexResp.error) {
					throw new NodeOperationError(this.getNode(), 
						`Vertex AI Error: ${vertexResp.error.status} - ${vertexResp.error.message}`,
					);
				}

				const text =
					vertexResp.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? '';

				returnData.push({
					json: {
						success: true,
						model: modelId,
						answer: text,
						input_media: mediaArray,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
