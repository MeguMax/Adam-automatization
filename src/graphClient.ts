import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';
import { TENANT_ID, CLIENT_ID, CLIENT_SECRET } from './config';

let graphClient: Client | null = null;

export function getGraphClient(): Client {
    if (graphClient) return graphClient;

    const credential = new ClientSecretCredential(
        TENANT_ID,
        CLIENT_ID,
        CLIENT_SECRET
    );

    graphClient = Client.initWithMiddleware({
        authProvider: {
            getAccessToken: async () => {
                const scope = 'https://graph.microsoft.com/.default';
                const token = await credential.getToken(scope);
                if (!token) {
                    throw new Error('Failed to acquire access token');
                }
                return token.token;
            },
        },
    });

    return graphClient;
}
