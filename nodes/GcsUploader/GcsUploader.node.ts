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

export class GcsUploader implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Files To GCP Storage',
		name: 'gcsUploader',
		icon: 'file:gcsUploader.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		description: 'Upload an array of Base64 files to Google Cloud Storage',
		defaults: {
			name: 'Files To GCP Storage',
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
			},
			{
				displayName: 'Bucket Name',
				name: 'bucketName',
				type: 'string',
				default: '',
				required: true,
			},
			{
				displayName: 'Files (JSON Array)',
				name: 'filesJson',
				type: 'json',
				default:
					'[\n  {\n    "b64": "iVBORw0K...",\n    "filename": "image.png"\n , "mimeType": "image/png" }\n]',
				required: true,
				description: 'Array of file objects containing "b64" (base64 string) and "filename"',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				// const projectId = this.getNodeParameter('projectId', i) as string;
				const bucketName = this.getNodeParameter('bucketName', i) as string;
				const filesInput = this.getNodeParameter(
					'filesJson',
					i,
				) as string | Array<Record<string, string>>;

				// Parse input array
				const filesArray =
					typeof filesInput === 'string' ? JSON.parse(filesInput) : filesInput;
				if (!Array.isArray(filesArray)) {
					throw new NodeOperationError(this.getNode(), "Error: 'filesJson' should be a valid JSON array of file objects.");
				}

				// 1. Get access token from shared helper (uses vertexAiServiceAccount credential)
				const { accessToken } = await getVertexAccessToken(this);

				// 2. Iterate, Decode Base64, and Upload
				const results: Array<{
					status: string;
					path: string;
					public_url?: string;
                    fileUri?: string;
                    mimeType?: string;
					error?: string;
				}> = [];

				for (const fileObj of filesArray) {
					const b64Data = fileObj.b64;
					const fileName = fileObj.filename || 'unknown_file';

					if (!b64Data) {
						results.push({
							status: 'error',
							error: 'Missing b64 parameter',
							path: fileName,
						});
						continue;
					}

					try {
						// Decode base64 to binary buffer
						const cleanB64 =
							b64Data.includes('base64,') ? b64Data.split('base64,')[1] : b64Data;
						const blobData = Buffer.from(cleanB64, 'base64');

						// Hash prefix
						const hash = crypto
							.createHash('sha256')
							.update(blobData)
							.digest('hex');
						const hashPrefix = hash.substring(0, 8);
						const destinationBlobName = `userUpload/${hashPrefix}-${fileName}`;

						// Upload to GCS
						const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(
							destinationBlobName,
						)}`;
                        const mimeType = fileObj.mimeType || 'application/octet-stream';
						const uploadOptions: IHttpRequestOptions = {
							method: 'POST',
							url: uploadUrl,
							headers: {
								Authorization: `Bearer ${accessToken}`,
								'Content-Type': mimeType,
							},
							body: blobData,
							ignoreHttpStatusErrors: true,
						};

						interface GcsResponse {
							error?: { message: string; code: number };
						}
						const uploadResponse = (await this.helpers.httpRequest(
							uploadOptions,
						)) as GcsResponse;

						if (uploadResponse.error) {
						
							throw new NodeOperationError(this.getNode(), `GCS Upload Error: ${uploadResponse.error.code} - ${uploadResponse.error.message}`);
						}

						// Make public
						const aclUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(
							destinationBlobName,
						)}/acl`;
						await this.helpers.httpRequest({
							method: 'POST',
							url: aclUrl,
							headers: {
								Authorization: `Bearer ${accessToken}`,
								'Content-Type': 'application/json',
							},
							body: { entity: 'allUsers', role: 'READER' },
							ignoreHttpStatusErrors: true,
						});

						results.push({
							status: 'success',
							path: destinationBlobName,
							public_url: `https://storage.googleapis.com/${bucketName}/${destinationBlobName}`,
                            fileUri: `https://storage.googleapis.com/${bucketName}/${destinationBlobName}`,
                            mimeType: mimeType,
						});
					} catch (err) {
						results.push({
							status: 'error',
							error: err instanceof Error ? err.message : String(err),
							path: fileName,
						});
					}
				}

				// 3. Output format
				returnData.push({
					json: {
						uris: results,
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
