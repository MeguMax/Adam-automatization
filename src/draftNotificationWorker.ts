import type { WorkflowDatabase } from './database';
import { deliverDraftNotifications, draftNotificationConfig } from './draftNotifications';
import { getGraphClient } from './graphClient';
import { RetryHandlerOptions } from '@microsoft/microsoft-graph-client/lib/src/middleware/options/RetryHandlerOptions';
import { getMiFileRuntimeConfig } from './mifileRuntimeConfig';

export async function runDraftNotificationWorker(db: WorkflowDatabase, signal: AbortSignal): Promise<void> {
    const store = db.draftNotifications();
    store.recover();
    const send = async (mail: { subject: string; bodyText: string; to: string }) => {
        await getGraphClient().api(`/users/${encodeURIComponent(process.env.SENDER_USER_ID!)}/sendMail`)
            .middlewareOptions([new RetryHandlerOptions(0, 0)]).options({ signal: AbortSignal.timeout(20_000) }).post({ message: {
                subject: mail.subject, body: { contentType: 'Text', content: mail.bodyText },
                toRecipients: [{ emailAddress: { address: mail.to } }],
            }, saveToSentItems: true });
    };
    while (!signal.aborted) {
        try {
            if (draftNotificationConfig().ready) {
                const autoPrepare = process.env.MIFILE_AUTO_PREPARE_ENABLED !== 'false' &&
                    !['false','0','no','off'].includes((process.env.MIFILE_FILING_WORKER_ENABLED || 'true').trim().toLowerCase()) &&
                    getMiFileRuntimeConfig().ready;
                for (let count = 0; count < 3 && !signal.aborted; count++) {
                    const mail = store.claimIntake(emailId => db.intakeResultNotification(emailId, autoPrepare));
                    if (!mail) break;
                    try { await send(mail); store.finishIntake(mail, { sent: true }); }
                    catch (error) { store.finishIntake(mail, { error }); }
                }
                if (!signal.aborted) await deliverDraftNotifications(store, send);
            }
        } catch (error) {
            console.error('Draft notification queue could not be checked:', error instanceof Error ? error.message : String(error));
        }
        if (signal.aborted) break;
        await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 10_000);
            signal.addEventListener('abort', finish, { once: true });
        });
    }
}
