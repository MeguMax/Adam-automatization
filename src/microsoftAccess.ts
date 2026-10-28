import { ClientSecretCredential } from '@azure/identity';

type Check = { status: 'ok' | 'failed' | 'not_configured'; reason?: string; http?: number };
type Permission = 'granted_not_tested' | 'not_granted' | 'unknown';
export interface MicrosoftAccessReport {
    checkedAt: string;
    readOnly: true;
    authentication: Check;
    inbox: Check;
    oneDrive: Check & { host?: string };
    fileWritePermission: Permission;
    mailSendPermission: Permission;
}

class CheckFailure extends Error {
    constructor(public readonly reason: string, public readonly http?: number) { super(reason); }
}

export async function checkMicrosoftAccess(options: {
    env?: NodeJS.ProcessEnv;
    getToken?: (signal: AbortSignal) => Promise<string>;
    request?: typeof fetch;
    timeoutMs?: number;
} = {}): Promise<MicrosoftAccessReport> {
    const env = options.env || process.env;
    const result: MicrosoftAccessReport = {
        checkedAt: new Date().toISOString(), readOnly: true,
        authentication: { status: 'not_configured' }, inbox: { status: 'not_configured' },
        oneDrive: { status: 'not_configured' }, fileWritePermission: 'unknown', mailSendPermission: 'unknown',
    };
    if (!env.TENANT_ID || !env.CLIENT_ID || !env.CLIENT_SECRET) return result;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    const signal = controller.signal;
    const aborted = new Promise<never>((_resolve, reject) => signal.addEventListener('abort',
        () => reject(new CheckFailure('timeout')), {once:true}));
    const failure = (error: unknown): Check => ({ status: 'failed',
        reason: signal.aborted ? 'timeout' : error instanceof CheckFailure ? error.reason : 'unavailable',
        ...(error instanceof CheckFailure && error.http ? { http:error.http } : {}),
    });
    try {
        const token = await Promise.race([options.getToken ? options.getToken(signal) :
            new ClientSecretCredential(env.TENANT_ID,env.CLIENT_ID,env.CLIENT_SECRET)
                .getToken('https://graph.microsoft.com/.default',{abortSignal:signal}).then(value=>value?.token || ''), aborted]);
        if (!token) throw new CheckFailure('sign_in_failed');
        result.authentication = {status:'ok'};
        // Claims are diagnostic only. Graph itself enforces the actual resource access below.
        let roles: string[] = [];
        try {
            const claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
            if (Array.isArray(claims.roles)) roles = claims.roles.filter((role: unknown): role is string => typeof role === 'string');
        } catch { /* Opaque tokens do not establish a permission claim. */ }
        if (roles.length) {
            result.fileWritePermission = roles.some(role=>['Files.ReadWrite.All','Sites.ReadWrite.All'].includes(role))
                ? 'granted_not_tested' : roles.some(role => role.includes('Selected')) ? 'unknown' : 'not_granted';
            result.mailSendPermission = roles.includes('Mail.Send') ? 'granted_not_tested' : 'not_granted';
        }
        const get = async (pathname: string) => {
            const response = await Promise.race([(options.request || fetch)('https://graph.microsoft.com/v1.0'+pathname, {
                method:'GET', redirect:'error', signal, headers:{Authorization:'Bearer '+token},
            }), aborted]);
            if (!response.ok) {
                try { await Promise.race([response.body?.cancel(), aborted]); } catch { /* Preserve the bounded status-only failure. */ }
                throw new CheckFailure(response.status === 403 ? 'access_denied' : response.status === 404 ? 'not_found' :
                    response.status === 401 ? 'sign_in_failed' : 'unavailable',response.status);
            }
            try { return await Promise.race([response.json(),aborted]); }
            catch { throw new CheckFailure(signal.aborted ? 'timeout' : 'invalid_response'); }
        };
        await Promise.all([
            (async () => {
                if (!env.USER_EMAIL) return;
                try {
                    const inbox = await get('/users/'+encodeURIComponent(env.USER_EMAIL)+'/mailFolders/inbox?$select=id');
                    if (!inbox?.id) throw new CheckFailure('invalid_response');
                    result.inbox = {status:'ok',http:200};
                } catch(error) { result.inbox = failure(error); }
            })(),
            (async () => {
                if (!env.ONEDRIVE_ROOT_SHARE_URL) return;
                try {
                    let share: URL;
                    try { share = new URL(env.ONEDRIVE_ROOT_SHARE_URL); }
                    catch { throw new CheckFailure('invalid_configuration'); }
                    if (share.protocol !== 'https:' || share.username || share.password || share.port ||
                        !(share.hostname.endsWith('.sharepoint.com') || ['1drv.ms','onedrive.live.com'].includes(share.hostname))) {
                        throw new CheckFailure('invalid_configuration');
                    }
                    const shareId = 'u!'+Buffer.from(env.ONEDRIVE_ROOT_SHARE_URL).toString('base64url');
                    const item = await get('/shares/'+shareId+'/driveItem?$select=id,folder,parentReference');
                    if (!item?.folder || !item.id || !item.parentReference?.driveId) throw new CheckFailure('not_a_folder');
                    const drive = encodeURIComponent(item.parentReference.driveId), folder = encodeURIComponent(item.id);
                    const listing = await get('/drives/'+drive+'/items/'+folder+'/children?$top=1&$select=id');
                    if (!Array.isArray(listing?.value)) throw new CheckFailure('invalid_response');
                    result.oneDrive = {status:'ok',http:200,host:share.hostname};
                } catch(error) { result.oneDrive = failure(error); }
            })(),
        ]);
    } catch(error) {
        result.authentication = failure(error);
        const reason = signal.aborted ? 'timeout' : 'sign_in_failed';
        if (env.USER_EMAIL) result.inbox = {status:'failed',reason};
        if (env.ONEDRIVE_ROOT_SHARE_URL) result.oneDrive = {status:'failed',reason};
    } finally { clearTimeout(timer); }
    return result;
}

if (require.main === module) {
    require('dotenv').config({quiet:true});
    checkMicrosoftAccess().then(report=>{
        process.stdout.write(JSON.stringify(report,null,2)+'\n');
        if ([report.authentication,report.inbox,report.oneDrive].some(check=>check.status !== 'ok')) process.exitCode=1;
    }).catch(()=>{ process.stderr.write('Microsoft connection check failed.\n'); process.exitCode=1; });
}
