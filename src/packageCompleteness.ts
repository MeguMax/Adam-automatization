import { createHash } from 'node:crypto';
import type { DocumentRecognition, SupportingDocumentKind } from './documentRecognition';

export const SUPPORTING_KINDS = ['demand','notice_to_quit','lease','deed','affidavit','other','unknown'] as const;

export type SupportingRequirement = 'unknown' | 'demand' | 'notice_to_quit' | 'none' | 'supplied';
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
    filingType?: string | null;
    filingRelation?: string;
}
export interface PackageCompleteness {
    version: 1 | 2;
    requirement: SupportingRequirement;
    source: 'complaint' | 'documents' | 'manual' | 'unknown' | 'attorney_policy';
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
            version:document.sourceVersion || null,primary:document.isPrimary,role:document.packageRole,
            filingType:document.filingType || null,relation:document.filingRelation || null,evidence:document.supportingEvidence || null}))
        .sort((a,b)=>a.id.localeCompare(b.id));
    return createHash('sha256').update(JSON.stringify({policy:'supplied-supporting-pdfs-v2',courtName,sources})).digest('hex');
}

export function evaluatePackageCompleteness(courtName:string | null, documents:CompletenessDocument[], _formType:string | null,
    _manual: {requirement?:unknown;reason?:unknown;contextHash?:unknown} = {}): PackageCompleteness {
    const contextHash=completenessContext(courtName,documents);
    const included=documents.filter(document=>document.requiredForFiling !== false && document.packageRole !== 'fee');
    // The sender determines substantive sufficiency; this gate verifies the supplied PDF snapshot.
    const result:PackageCompleteness={version:2,requirement:'supplied',source:'attorney_policy',reason:null,contextHash,
        reviewStale:false,issues:[]};
    const fail=(message:string)=>result.issues.push({field:'package.supporting',severity:'error',message});
    if(!included.length) fail('Include the filing PDFs before confirming the package.');
    if(included.some(document=>!/^[a-f0-9]{64}$/.test(document.supportingEvidence?.contentHash || ''))) {
        fail('Wait for automatic PDF content verification. Every included PDF must be pinned before confirming the package.');
    }
    if(included.some(document=>!document.oneDriveUrl || (document.status && !['uploaded','downloaded','replaced'].includes(document.status)))) {
        fail('Every included PDF must finish processing and be available in OneDrive before confirming the package.');
    }
    return result;
}

export function validCompletenessSnapshot(payload: {courtName:string;documents:CompletenessDocument[];completeness?:PackageCompleteness}): boolean {
    const snapshot=payload.completeness;
    if(!snapshot || snapshot.version!==2 || snapshot.requirement!=='supplied' || snapshot.source!=='attorney_policy' ||
        snapshot.reviewStale || !Array.isArray(snapshot.issues) || snapshot.issues.length ||
        snapshot.contextHash!==completenessContext(payload.courtName,payload.documents)) return false;
    const evaluated=evaluatePackageCompleteness(payload.courtName,payload.documents,null,
        {requirement:snapshot.requirement,reason:snapshot.reason,contextHash:snapshot.contextHash});
    return !evaluated.issues.length;
}
