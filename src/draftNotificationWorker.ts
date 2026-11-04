import type { WorkflowDatabase } from './database';
import { deliverDraftNotifications, draftNotificationConfig } from './draftNotifications';
import { getGraphClient } from './graphClient';
import { RetryHandlerOptions } from '@microsoft/microsoft-graph-client/lib/src/middleware/options/RetryHandlerOptions';

export async function runDraftNotificationWorker(db: WorkflowDatabase, signal: AbortSignal): Promise<void> {
    const store = db.draftNotifications();
    store.recover();
    while (!signal.aborted) {
        try {
            if (draftNotificationConfig().ready) await deliverDraftNotifications(store, async mail => {
                await getGraphClient().api(`/users/${encodeURIComponent(process.env.SENDER_USER_ID!)}/sendMail`)
                    .middlewareOptions([new RetryHandlerOptions(0, 0)]).options({ signal: AbortSignal.timeout(20_000) }).post({ message: {
                        subject: mail.subject, body: { contentType: 'Text', content: mail.bodyText },
                        toRecipients: [{ emailAddress: { address: mail.to } }],
                    }, saveToSentItems: true });
            });
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
