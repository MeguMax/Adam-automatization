import { createHash } from 'node:crypto';
import type { DocumentRecognition, SupportingDocumentKind } from './documentRecognition';

export const SUPPORTING_KINDS = ['demand','notice_to_quit','lease','deed','affidavit','other','unknown'] as const;

export type SupportingRequirement = 'unknown' | 'demand' | 'notice_to_quit' | 'none';
export interface SupportingEvidence {
    kind: SupportingDocumentKind;
    source: 'content' | 'manual' | 'unknown';
    contentHash: string | null;
}
export interface CompletenessDocument {
    id: string;
    oneDriveUrl: string | null;
    fileSize: number | null;
    sourceVersion?: string | null;
    supportingEvidence?: SupportingEvidence;
    requiredForFiling?: boolean;
    packageRole: string;
    isPrimary: boolean;
    status?: string;
}
export interface PackageCompleteness {
    version: 1;
    requirement: SupportingRequirement;
    source: 'complaint' | 'documents' | 'manual' | 'unknown';
    reason: string | null;
    contextHash: string;
    reviewStale: boolean;
    issues: Array<{field:string;severity:'error';message:string}>;
}

export function supportingEvidence(recognition:DocumentRecognition | null, manual:any, sourceVersion:string, libraryHash?:string):SupportingEvidence {
    const hash=/^[a-f0-9]{64}$/.test(recognition?.contentHash || '') ? recognition!.contentHash! :
        /^[a-f0-9]{64}$/.test(libraryHash || '') ? libraryHash! : null;
    if(manual && SUPPORTING_KINDS.includes(manual.kind) && hash && manual.contentHash===hash && manual.sourceVersion===sourceVersion) {
        return {kind:manual.kind,source:'manual',contentHash:hash};
    }
    return {kind:recognition?.supportingKind || 'unknown',source:recognition?.source==='content'?'content':'unknown',contentHash:hash};
}

export function completenessContext(courtName: string | null, documents: CompletenessDocument[]): string {
    const sources = documents.filter(document=>document.requiredForFiling !== false && document.packageRole !== 'fee')
        .map(document=>({id:document.id,url:document.oneDriveUrl,size:document.fileSize,
            version:document.sourceVersion || null,primary:document.isPrimary,evidence:document.supportingEvidence || null}))
        .sort((a,b)=>a.id.localeCompare(b.id));
    return createHash('sha256').update(JSON.stringify({courtName,sources})).digest('hex');
}

export function evaluatePackageCompleteness(courtName:string | null, documents:CompletenessDocument[], formType:string | null,
    manual: {requirement?:unknown;reason?:unknown;contextHash?:unknown} = {}): PackageCompleteness {
    const contextHash=completenessContext(courtName,documents);
    const included=documents.filter(document=>document.requiredForFiling !== false && document.packageRole !== 'fee');
    const proof=(kind:SupportingRequirement) => included.some(document=>document.supportingEvidence?.kind===kind &&
        ['content','manual'].includes(document.supportingEvidence.source) && /^[a-f0-9]{64}$/.test(document.supportingEvidence.contentHash || '') &&
        document.oneDriveUrl && (!document.status || ['uploaded','downloaded','replaced'].includes(document.status)));
    const explicit=['demand','notice_to_quit','none'].includes(String(manual.requirement));
    const result:PackageCompleteness={version:1,requirement:'unknown',source:'unknown',reason:null,contextHash,
        reviewStale:explicit && manual.contextHash !== contextHash,issues:[]};
    if(explicit && !result.reviewStale) {
        result.requirement=manual.requirement as SupportingRequirement;result.source='manual';
        result.reason=typeof manual.reason==='string'?manual.reason.trim():null;
    } else if (/^NONPAYMENT OF RENT$/i.test(formType || '')) {
        result.requirement='demand';result.source='complaint';
    } else {
        const found=(['demand','notice_to_quit'] as const).filter(proof);
        if(found.length===1){result.requirement=found[0];result.source='documents';}
    }
    const fail=(message:string)=>result.issues.push({field:'package.supporting',severity:'error',message});
    if(included.some(document=>!/^[a-f0-9]{64}$/.test(document.supportingEvidence?.contentHash || ''))) {
        fail('Wait for automatic PDF content verification. Every included PDF must be pinned before confirming the package.');
    }
    if(result.reviewStale) fail('The supporting-document review is outdated because the court or PDFs changed. Confirm the requirement again.');
    if(result.requirement==='unknown') fail('Confirm whether this case requires a Demand for possession or Notice to quit. A Deed, Lease, or generic Other does not establish completeness.');
    else if(result.requirement==='none') {
        if(result.source!=='manual' || !result.reason || result.reason.length<10) fail('Enter the attorney\'s reason why no Demand or Notice is required for this case.');
    } else if(!proof(result.requirement)) fail('The package is missing a verified '+
        (result.requirement==='demand'?'Demand for possession':'Notice to quit')+'. Include the PDF and confirm its contents if recognition is uncertain; Other/Connected is only its MiFILE upload type.');
    return result;
}

export function validCompletenessSnapshot(payload: {courtName:string;documents:CompletenessDocument[];completeness?:PackageCompleteness}): boolean {
    const snapshot=payload.completeness;
    if(!snapshot || snapshot.version!==1 || snapshot.reviewStale || !Array.isArray(snapshot.issues) || snapshot.issues.length ||
        snapshot.contextHash!==completenessContext(payload.courtName,payload.documents)) return false;
    const evaluated=evaluatePackageCompleteness(payload.courtName,payload.documents,null,
        {requirement:snapshot.requirement,reason:snapshot.reason,contextHash:snapshot.contextHash});
    return !evaluated.issues.length && snapshot.requirement!=='unknown' &&
        ['complaint','documents','manual'].includes(snapshot.source) && (snapshot.requirement!=='none' || snapshot.source==='manual');
}
