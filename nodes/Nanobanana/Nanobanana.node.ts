import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	IHttpRequestOptions,
} from 'n8n-workflow';
import * as crypto from 'crypto';
import { getVertexAccessToken } from '../utils';

interface VertexResponse {
	error?: {
		message: string;
		status: string;
	};
	candidates: Array<{
		content: {
			parts: Array<{
				inlineData: {
					data: string;
					mimeType?: string;
				};
			}>;
		};
	}>;
}

export class Nanobanana implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Nanobanana Vertex AI',
		name: 'nanobanana',
		icon: 'file:nanobanana.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		description: 'Generate images via Vertex AI and upload to GCS',
		defaults: {
			name: 'Nanobanana Vertex AI',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'vertexAiServiceAccount', // must match credential class `name`
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
			},
			{
				displayName: 'Location',
				name: 'location',
				type: 'string',
				default: 'us-central1',
				required: true,
			},
			{
				displayName: 'Model ID',
				name: 'modelId',
				type: 'string',
				default: 'imagegeneration@006',
				required: true,
			},
			{
				displayName: 'Contents (JSON)',
				name: 'contents',
				type: 'json',
				default: '[]',
				required: true,
				description: 'Request contents array for the Vertex AI API',
			},
			{
				displayName: 'GCS Bucket Name',
				name: 'bucketName',
				type: 'string',
				default: '',
				description:
					'Optional. If provided, the generated image will be uploaded to this bucket.',
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
				const contentsJson = this.getNodeParameter('contents', i) as
					| string
					| Record<string, unknown>;
				const bucketName = this.getNodeParameter('bucketName', i) as string;

				// 1. Get access token from shared helper using n8n credentials
				const { accessToken } = await getVertexAccessToken(this);

				// 2. Call Vertex AI API
				const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

				const payloadContents =
					typeof contentsJson === 'string'
						? JSON.parse(contentsJson)
						: contentsJson;

				const vertexOptions: IHttpRequestOptions = {
					method: 'POST',
					url: vertexUrl,
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json',
					},
					body: {
						contents: payloadContents,
					},
					ignoreHttpStatusErrors: true,
				};

				const vertexResponse = (await this.helpers.httpRequest(
					vertexOptions,
				)) as VertexResponse;

				if (vertexResponse.error) {
					throw new Error(
						`Vertex AI API Error: ${vertexResponse.error.status} - ${vertexResponse.error.message}. Payload sent: ${JSON.stringify(
							payloadContents,
						)}`,
					);
				}

				const parts = vertexResponse.candidates[0].content.parts;
				const inline = parts[parts.length - 1].inlineData;
				const imageB64 = inline.data;
				const mimeType = inline.mimeType || 'image/png';

				// 3. Decode image
				const imageBuffer = Buffer.from(imageB64, 'base64');
				const imageHash = crypto
					.createHash('sha256')
					.update(imageBuffer)
					.digest('hex');
				const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
				const filename = `${imageHash}.${ext}`;
				const gcsPath = `nanobanana-image/${filename}`;

				let publicUrl = '';
				let fileId = '';

				// 4. Upload to GCS (optional)
				if (bucketName) {
					const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(
						gcsPath,
					)}`;
					const uploadOptions: IHttpRequestOptions = {
						method: 'POST',
						url: uploadUrl,
						headers: {
							Authorization: `Bearer ${accessToken}`,
							'Content-Type': mimeType,
						},
						body: imageBuffer,
					};
					await this.helpers.httpRequest(uploadOptions);

					const aclUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(
						gcsPath,
					)}/acl`;
					const aclOptions: IHttpRequestOptions = {
						method: 'POST',
						url: aclUrl,
						headers: {
							Authorization: `Bearer ${accessToken}`,
							'Content-Type': 'application/json',
						},
						body: {
							entity: 'allUsers',
							role: 'READER',
						},
						ignoreHttpStatusErrors: true,
						timeout: 180000, //3min
						// In case of uniform bucket-level access, ACLs are disabled and this request will fail. We can ignore that error.
					};
					try {
						await this.helpers.httpRequest(aclOptions);
					} catch {
						// ignore ACL errors for uniform bucket-level access
					}

					publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;
					fileId = gcsPath;
				}

				// 5. Output
				const binaryData = await this.helpers.prepareBinaryData(
					imageBuffer,
					filename,
					mimeType,
				);

				returnData.push({
					json: {
						file_id: fileId,
						uri: publicUrl,
						mimeType,
						success: true,
					},
					binary: {
						data: binaryData,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
}
