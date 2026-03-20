import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	IHttpRequestOptions,
} from 'n8n-workflow';
import * as crypto from 'crypto';

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
		properties: [
			{
				displayName: 'Service Account JSON (Base64)',
				name: 'serviceAcB64',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				description: 'Base64 encoded Google Cloud Service Account JSON',
			},
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
				description: 'Optional. If provided, the generated image will be uploaded to this bucket.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const serviceAcB64 = this.getNodeParameter('serviceAcB64', i) as string;
				const projectId = this.getNodeParameter('projectId', i) as string;
				const location = this.getNodeParameter('location', i) as string;
				const modelId = this.getNodeParameter('modelId', i) as string;
				const contentsJson = this.getNodeParameter('contents', i) as string | Record<string, unknown>;
				const bucketName = this.getNodeParameter('bucketName', i) as string;

				// 1. Decode credentials
				const saJsonString = Buffer.from(serviceAcB64, 'base64').toString('utf-8');
				const credentials = JSON.parse(saJsonString) as { client_email: string; private_key: string };

				// 2. Generate Native JWT for Google OAuth2
				const now = Math.floor(Date.now() / 1000);
				const headerObj = { alg: 'RS256', typ: 'JWT' };
				const claimObj = {
					iss: credentials.client_email,
					scope: 'https://www.googleapis.com/auth/cloud-platform',
					aud: 'https://oauth2.googleapis.com/token',
					exp: now + 3600,
					iat: now,
				};

				const base64url = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url');
				const signatureInput = `${base64url(headerObj)}.${base64url(claimObj)}`;
				
				const sign = crypto.createSign('RSA-SHA256');
				sign.update(signatureInput);
				const signature = sign.sign(credentials.private_key, 'base64url');
				const jwt = `${signatureInput}.${signature}`;

				// 3. Get Google Access Token using n8n's httpRequest helper
				const tokenOptions: IHttpRequestOptions = {
					method: 'POST',
					url: 'https://oauth2.googleapis.com/token',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
				};
				const tokenResponse = (await this.helpers.httpRequest(tokenOptions)) as { access_token: string };
				const accessToken = tokenResponse.access_token;

				// 4. Call Vertex AI API
				const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;
				const vertexOptions: IHttpRequestOptions = {
					method: 'POST',
					url: vertexUrl,
					headers: {
						'Authorization': `Bearer ${accessToken}`,
						'Content-Type': 'application/json',
					},
					body: {
						contents: typeof contentsJson === 'string' ? JSON.parse(contentsJson) : contentsJson,
					},
				};
				
				interface VertexResponse {
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
				const vertexResponse = (await this.helpers.httpRequest(vertexOptions)) as VertexResponse;

				const parts = vertexResponse.candidates[0].content.parts;
				const inline = parts[parts.length - 1].inlineData;
				const imageB64 = inline.data;
				const mimeType = inline.mimeType || 'image/png';

				// 5. Decode Image
				const imageBuffer = Buffer.from(imageB64, 'base64');
				const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
				const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
				const filename = `${imageHash}.${ext}`;
				const gcsPath = `nanobanana-image/${filename}`;

				let publicUrl = '';
				let fileId = '';

				// 6. Upload to GCS using REST API
				if (bucketName) {
					// Upload binary payload
					const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(gcsPath)}`;
					const uploadOptions: IHttpRequestOptions = {
						method: 'POST',
						url: uploadUrl,
						headers: {
							'Authorization': `Bearer ${accessToken}`,
							'Content-Type': mimeType,
						},
						body: imageBuffer,
					};
					await this.helpers.httpRequest(uploadOptions);

					// Make object publicly readable
					const aclUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(gcsPath)}/acl`;
					const aclOptions: IHttpRequestOptions = {
						method: 'POST',
						url: aclUrl,
						headers: {
							'Authorization': `Bearer ${accessToken}`,
							'Content-Type': 'application/json',
						},
						body: {
							entity: 'allUsers',
							role: 'READER',
						},
					};
					try {
						await this.helpers.httpRequest(aclOptions);
					} catch {
						// Ignored if Bucket Level Access policy strictly overrides object ACLs
					}
					
					publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsPath}`;
					fileId = gcsPath;
				}

				// 7. Format n8n Output Data
				const binaryData = await this.helpers.prepareBinaryData(imageBuffer, filename, mimeType);
				
				returnData.push({
					json: {
						file_id: fileId,
						uri: publicUrl,
						mimeType: mimeType,
						success: true,
					},
					binary: {
						data: binaryData,
					},
				});

			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: error.message } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
