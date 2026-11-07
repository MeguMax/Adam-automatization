import type { FilingJobView, WorkflowDatabase } from './database';
import { MiFileFilingRunner, type MiFilePreparationResult } from './mifileFilingRunner';
import { filingReleaseChecks, savedBundleRecoverySnapshot } from './mifilePreparationEvidence';

export async function recheckSavedFilingJob(db:WorkflowDatabase,job:FilingJobView,
    check?:(job:FilingJobView)=>Promise<MiFilePreparationResult>):Promise<void> {
    const active=()=>{
        const current=db.getFilingJob(job.id);
        return current?.status==='running' && current.startedAt===job.startedAt;
    };
    try {
        if(!active())return;
        const saved=savedBundleRecoverySnapshot(job);
        const runner=new MiFileFilingRunner(entry=>{if(active())db.appendFilingJobLog(job.id,{...entry,
            checkpoint:'verify_saved_bundle',details:{...entry.details,readOnlyRecheck:true,readCheckpoint:entry.checkpoint}});});
        const result=await (check ? check(job) : runner.recheckSavedBundle(job));
        if(!active())return;
        const completedResult={url:result.url,uploadedDocuments:result.uploadedDocuments,mifileVersion:result.mifileVersion,
            documentManifest:result.documentManifest,savedBundleEvidence:result.savedBundleEvidence,readOnlyRecheck:true};
        if(result.externalBundleId!==saved.externalBundleId || result.temporaryCaseNumber!==saved.temporaryCaseNumber ||
            result.savedBundleEvidence?.accountEmail!==saved.accountEmail ||
            !filingReleaseChecks({...job,status:'prepared',result:completedResult},null).savedBundleVerified) {
            throw new Error('The rechecked result did not match the original saved-bundle identity and complete PDF snapshot.');
        }
        db.completeFilingJob({filingJobId:job.id,status:'prepared',checkpoint:result.checkpoint,
            externalBundleId:result.externalBundleId,temporaryCaseNumber:result.temporaryCaseNumber,
            debugArtifactPath:result.screenshotPath,result:completedResult});
    } catch(error) {
        if(!active())return;
        const message=(error instanceof Error ? error.message : 'The saved bundle could not be verified.')+
            ' No PDF uploads, new bundle, payment or court submission were attempted by this check.';
        db.appendFilingJobLog(job.id,{level:'warning',checkpoint:'reconciliation_required',message,details:{event:'saved_bundle_read_only_check_failed'}});
        db.completeFilingJob({filingJobId:job.id,status:'reconciliation_required',checkpoint:'reconciliation_required',
            errorCode:'SAVED_BUNDLE_RECHECK_FAILED',errorMessage:message,debugArtifactPath:job.debugArtifactPath});
    }
}
