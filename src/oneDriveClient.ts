import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';

const tenantId = process.env.TENANT_ID!;
const clientId = process.env.CLIENT_ID!;
const clientSecret = process.env.CLIENT_SECRET!;
const shareUrl = process.env.ONEDRIVE_ROOT_SHARE_URL!; // ссылка на Court Filing Working Folder

if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Missing TENANT_ID / CLIENT_ID / CLIENT_SECRET in .env');
}
if (!shareUrl) {
    throw new Error('Missing ONEDRIVE_ROOT_SHARE_URL in .env');
}

const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

export const oneDriveClient = Client.initWithMiddleware({
    authProvider: {
        getAccessToken: async () => {
            const token = await credential.getToken('https://graph.microsoft.com/.default');
            if (!token) throw new Error('Failed to get Graph access token (OneDrive)');
            return token.token;
        },
    },
});

let rootDriveId: string | null = null;
let rootItemId: string | null = null;

// получить driveId + itemId папки по share URL
export async function ensureRootFolder(): Promise<{ driveId: string; itemId: string }> {
    if (rootDriveId && rootItemId) {
        return { driveId: rootDriveId, itemId: rootItemId };
    }

    const encoded = Buffer.from(shareUrl).toString('base64');
    const shareId = `u!${encoded.replace(/=+$/g, '')}`;

    const item = await oneDriveClient
        .api(`/shares/${shareId}/driveItem`)
        .select('id,driveId,name,parentReference')
        .get();

    rootDriveId = item.parentReference?.driveId ?? item.driveId;
    rootItemId = item.id;

    if (!rootDriveId || !rootItemId) {
        throw new Error('Failed to resolve OneDrive root folder from share URL');
    }

    return { driveId: rootDriveId, itemId: rootItemId };
}

// создать/найти подпапку по имени (например "25-08830-LT - ...")
export async function ensureChildFolder(
    driveId: string,
    parentItemId: string,
    folderName: string,
): Promise<string> {
    const children = await oneDriveClient
        .api(`/drives/${driveId}/items/${parentItemId}/children`)
        .query({ $select: 'id,name,folder' })
        .get();

    const existing = (children.value ?? []).find(
        (c: any) => c.folder && c.name === folderName,
    );
    if (existing) return existing.id as string;

    const created = await oneDriveClient
        .api(`/drives/${driveId}/items/${parentItemId}/children`)
        .post({
            name: folderName,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'rename',
        });

    return created.id as string;
}

// загрузка Buffer в папку
export async function uploadFileBufferToFolder(
    driveId: string,
    folderItemId: string,
    fileName: string,
    content: Buffer,
): Promise<{ driveId: string; itemId: string; fileName: string }> {
    const item = await oneDriveClient
        .api(`/drives/${driveId}/items/${folderItemId}:/${encodeURIComponent(fileName)}:/content`)
        .put(content);

    // SDK вернёт DriveItem с id загруженного файла
    return {
        driveId,
        itemId: item.id as string,
        fileName,
    };
}

export async function itemExistsInFolder(
    driveId: string,
    folderItemId: string,
    fileName: string,
): Promise<boolean> {
    // ищем по имени среди children этой папки
    const children = await oneDriveClient
        .api(`/drives/${driveId}/items/${folderItemId}/children`)
        .query({
            $select: 'id,name',
            $filter: `name eq '${fileName.replace(/'/g, "''")}'`,
        })
        .get();

    const items = (children.value ?? []) as { id: string; name: string }[];
    return items.length > 0;
}

export async function createFileLink(
    driveId: string,
    itemId: string,
): Promise<string> {
    const res = await oneDriveClient
        .api(`/drives/${driveId}/items/${itemId}/createLink`)
        .post({
            type: 'view',
            scope: 'organization', // или 'anonymous', если нужно
        }); // [page:0]

    return res?.link?.webUrl as string;
}
