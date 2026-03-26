import { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import * as crypto from 'crypto';

export async function getVertexAccessToken(
	ctx: IExecuteFunctions,
): Promise<{ accessToken: string }> {
	const creds = await ctx.getCredentials('vertexAiServiceAccountApi');
	
	// Decode base64 credential field
	const saJsonString = Buffer.from(creds.serviceAccountJsonB64 as string, 'base64').toString('utf-8');
	const saJson = JSON.parse(saJsonString) as {
		client_email: string;
		private_key: string;
	};

	const now = Math.floor(Date.now() / 1000);
	const headerObj = { alg: 'RS256', typ: 'JWT' };
	const claimObj = {
		iss: saJson.client_email,
		scope: 'https://www.googleapis.com/auth/cloud-platform',
		aud: 'https://oauth2.googleapis.com/token',
		exp: now + 3600,
		iat: now,
	};

	const base64url = (obj: Record<string, unknown>) =>
		Buffer.from(JSON.stringify(obj)).toString('base64url');
	const signatureInput = `${base64url(headerObj)}.${base64url(claimObj)}`;

	const sign = crypto.createSign('RSA-SHA256');
	sign.update(signatureInput);
	const signature = sign.sign(saJson.private_key, 'base64url');
	const jwt = `${signatureInput}.${signature}`;

	const tokenOptions: IHttpRequestOptions = {
		method: 'POST',
		url: 'https://oauth2.googleapis.com/token',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
	};

	const tokenResp = (await ctx.helpers.httpRequest(tokenOptions)) as {
		access_token: string;
	};
	return { accessToken: tokenResp.access_token };
}
