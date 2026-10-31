import { fork } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ComplaintSelections } from './pdfCheckboxes';

export interface OcrLine {
    verifiedByConsensus?: boolean;
    text: string;
    confidence: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pageNumber: number;
}
export interface OcrPage {
    selections?: ComplaintSelections;
    text: string;
    confidence: number;
    lines: OcrLine[];
    words: OcrLine[];
    rotationRadians?: number;
    recognitionPasses?: number;
}

export interface OcrRegion { left: number; top: number; right: number; bottom: number }

export function ocrDistrictCode(value: string): string|null {
    const normalized=value.trim().replace(/\s+/g,'').replace(/-(?=[AB](?:st|nd|rd|th)?$)/i,'');
    return normalized.match(/^(\d{1,3}[AB]?(?:-\d)?)(?:st|nd|rd|th)?$/i)?.[1].toUpperCase() || null;
}

export function paragraph2Boundary(words: OcrLine[], attorneyY: number|undefined): number|undefined {
    if (attorneyY===undefined) return;
    const anchor=words.filter(word=>word.x<170 && word.y>attorneyY+35 && word.confidence>=50 &&
        (/^2\.(?:\s|$)/.test(word.text) || /^There\b/i.test(word.text)) &&
        words.some(other=>other.x>=word.x && Math.abs(other.y-word.y)<8 && /\b(?:pending|resolved|civil)\b/i.test(other.text)))
        .sort((a,b)=>a.y-b.y)[0];
    return anchor ? anchor.y-4 : undefined;
}

export interface OcrLineVerification {
    region: OcrRegion;
    pageNumber: number;
    text: string;
    confirmingReads: number;
    kind: 'text'|'phone'|'district'|'money';
}

function regionWords(words: OcrLine[], region: OcrRegion, retainSigns=false): OcrLine[] {
    return words.filter(word=>word.x+word.width/2>=region.left && word.x+word.width/2<region.right &&
        word.y+word.height/2>=region.top && word.y+word.height/2<region.bottom &&
        (/[a-z0-9&]/i.test(word.text) || retainSigns && /^[+-]$/.test(word.text)))
        .sort((a,b)=>a.x-b.x);
}

function verificationText(words: OcrLine[], kind: OcrLineVerification['kind']): string {
    const text=words.map(word=>word.text).join(' ').normalize('NFKC').replace(/[\u2018\u2019]/g,"'")
        .replace(/\{/g,'(').replace(/\}/g,')').replace(/\s+/g,' ').trim().toLowerCase();
    if (kind==='district') return ocrDistrictCode(text) || '';
    if (kind==='money') {
        const value=text.replace(/^\$\s*/, '').replace(/,/g,'');
        if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return '';
        const [whole,decimal='']=value.split('.');
        if (decimal.length>2 && /[1-9]/.test(decimal.slice(2))) return '';
        return whole.replace(/^0+(?=\d)/,'')+'.'+decimal.padEnd(2,'0').slice(0,2);
    }
    if (kind==='text') return text;
    if (!/^[+()\d .-]+$/.test(text)) return '';
    const digits=text.replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
    return /^[2-9]\d{9}$/.test(digits) ? digits : '';
}

/** Two clear rereads must agree with the final line; any legible contrary read keeps review. */
export function verifyOcrLineReads(words: OcrLine[], before: OcrLine[], reads: OcrLine[][],
    region: OcrRegion, kind: OcrLineVerification['kind']='text'): OcrLineVerification | null {
    const current=regionWords(words,region,kind==='money'), text=verificationText(current,kind);
    if (!current.length || !text || new Set(current.map(word=>word.pageNumber)).size!==1) return null;
    const pageNumber=current[0].pageNumber;
    const original=regionWords(before,region,kind==='money');
    if (original.length && original.every(word=>Number.isFinite(word.confidence) && word.confidence>=80) &&
        verificationText(original,kind)!==text) return null;
    let confirmingReads=0;
    for (const read of reads) {
        const candidates=regionWords(read,region,kind==='money');
        if (!candidates.length || candidates.some(word=>word.pageNumber!==pageNumber || !Number.isFinite(word.confidence))) continue;
        const value=verificationText(candidates,kind);
        if (value && candidates.every(word=>word.confidence>=75) && value!==text) return null;
        if (value===text && candidates.every(word=>word.confidence>=80)) confirmingReads++;
    }
    return confirmingReads>=2 ? {region,pageNumber,text,confirmingReads,kind} : null;
}

export function applyOcrLineVerifications(words: OcrLine[], verifications: OcrLineVerification[]): OcrLine[] {
    const verified=new Set<OcrLine>();
    for (const proof of verifications) {
        const current=regionWords(words,proof.region,proof.kind==='money');
        if (!Number.isInteger(proof.confirmingReads) || proof.confirmingReads<2 || current.some(word=>word.pageNumber!==proof.pageNumber) ||
            verificationText(current,proof.kind)!==proof.text) continue;
        current.forEach(word=>verified.add(word));
    }
    return words.map(word=>({...word,verifiedByConsensus:verified.has(word)}));
}

/** A second pass may repair missing words, but conflicting spellings stay uncertain. */
export function mergeOcrRegionWords(words: OcrLine[], reread: OcrLine[], region: OcrRegion): OcrLine[] {
    const inside = (word: OcrLine) => word.x + word.width / 2 >= region.left &&
        word.x + word.width / 2 < region.right && word.y + word.height / 2 >= region.top &&
        word.y + word.height / 2 < region.bottom;
    const overlap = (a: OcrLine, b: OcrLine) => {
        const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
            Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
    };
    const prior = words.filter(inside), next = reread.filter(inside), used = new Set<OcrLine>();
    const normalize = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const merged = prior.map(word => {
        const matches = next.filter(candidate => candidate.pageNumber === word.pageNumber && overlap(word, candidate) > 0.5);
        if (matches.length !== 1 || prior.filter(other => overlap(other, matches[0]) > 0.5).length !== 1) return word;
        const candidate = matches[0]; used.add(candidate);
        if (normalize(word.text) === normalize(candidate.text)) {
            return {...word, confidence:Math.max(word.confidence, candidate.confidence)};
        }
        return {...word, confidence:Math.min(79, word.confidence)};
    });
    for (const word of next) {
        if (!used.has(word) && word.confidence >= 80 && !prior.some(other => overlap(other, word) > 0.15)) merged.push(word);
    }
    return [...words.filter(word => !inside(word)), ...merged];
}

/** Independent line preprocessings may repair a spelling, but disagreement still requires review. */
export function mergeOcrLineReads(words: OcrLine[], reads: OcrLine[][], region: OcrRegion, numericFallback=false): OcrLine[] {
    const inside = (word:OcrLine) => word.x + word.width/2 >= region.left && word.x + word.width/2 < region.right &&
        word.y + word.height/2 >= region.top && word.y + word.height/2 < region.bottom;
    const overlap = (a:OcrLine,b:OcrLine) => Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)) *
        Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)) / Math.max(1,Math.min(a.width*a.height,b.width*b.height));
    const normalize = (value:string) => value.replace(/[^a-z0-9]/gi,'').toLowerCase();
    const clean = (value:string) => value.replace(/^[|\[\]`\u2018\u2019]+(?=[a-z0-9])/i,'').replace(/\{/g,'(').replace(/\}/g,')');
    const prior = words.filter(inside);
    return words.map(word => {
        if (!inside(word)) return word;
        const votes = new Map<string,OcrLine[]>();
        for (const read of reads) {
            const matches = read.filter(candidate => candidate.pageNumber === word.pageNumber && overlap(word,candidate)>0.5);
            if (matches.length !== 1 || prior.filter(other => overlap(other,matches[0])>0.5).length !== 1) continue;
            const key = normalize(matches[0].text);
            if (key) votes.set(key,[...(votes.get(key) || []),matches[0]]);
        }
        const ranked = [...votes].sort((a,b)=>b[1].length-a[1].length);
        const winner = ranked[0];
        const unopposedNumber=numericFallback && ranked.length===1 && winner?.[1].length===1 &&
            winner[1][0].confidence>=70 && word.confidence<80 && /^\+?1?\D*[2-9]\d{2}\D*\d{3}\D*\d{4}\D*$/.test(winner[1][0].text);
        if (!winner || (winner[1].length < 2 && !unopposedNumber) || winner[1].every(candidate=>candidate.confidence<50) ||
            ranked[1]?.[1].length === winner[1].length) return word;
        if (winner[0] === normalize(word.text)) return {...word,text:clean(word.text),
            confidence:Math.max(word.confidence,...winner[1].map(candidate=>candidate.confidence))};
        const repeated = words.filter(other=>!inside(other) && other.pageNumber===word.pageNumber && other.confidence>=80);
        if (/^[a-z]{4,}$/i.test(normalize(word.text)) && repeated.some(other=>normalize(other.text)===normalize(word.text)) &&
            !repeated.some(other=>normalize(other.text)===winner[0])) return word;
        const candidate = [...winner[1]].sort((a,b)=>b.confidence-a.confidence)[0];
        return {...word,text:clean(candidate.text),confidence:Math.min(79,candidate.confidence)};
    });
}

let queue: Promise<unknown> = Promise.resolve();
const cache=new Map<string,{expires:number;pageCount:number;pages:Map<number,OcrPage>}>();

/** One isolated OCR process at a time; a bad PDF must not take down the web server. */
export function recognizeScannedPdf(buffer: Buffer, pageNumbers?: number[]): Promise<OcrPage[]> {
    if (pageNumbers && (!pageNumbers.length || pageNumbers.some(page => !Number.isInteger(page) || page < 1) || new Set(pageNumbers).size !== pageNumbers.length)) {
        return Promise.reject(new Error('OCR page numbers must be unique positive integers.'));
    }
    const digest=createHash('sha256').update(buffer).digest('hex');
    const run = async () => {
        for(const [key,value] of cache)if(value.expires<Date.now())cache.delete(key);
        const known=cache.get(digest),numbers=pageNumbers || (known && known.pages.size===known.pageCount ? [...known.pages.keys()].sort((a,b)=>a-b) : null);
        if(known && numbers?.every(number=>known.pages.has(number))) return structuredClone(numbers.map(number=>known.pages.get(number)!));
        return new Promise<OcrPage[]>((resolve, reject) => {
            const child = fork(path.join(__dirname, 'pdfOcrChild.js'), [], {
                stdio: ['ignore', 'ignore', 'pipe', 'ipc'], ...{ windowsHide: true },
                execArgv: ['--max-old-space-size=384'],
            });
            let settled = false;
            const timer = setTimeout(() => finish(new Error('Scan recognition timed out. Review this PDF or upload a clearer scan.')), 120_000);
            function finish(error?: Error, pages?: OcrPage[]) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.kill();
                if (error) reject(error); else resolve(pages || []);
            }
            child.stderr?.resume();
            child.once('error', error => finish(error));
            child.once('exit', code => { if (!settled) finish(new Error(`Scan recognition stopped (${code}). The original PDF is preserved.`)); });
            child.on('message', (message: any) => {
                if (message.error) finish(new Error(message.error));
                else {
                    if(Array.isArray(message.pages) && Number.isInteger(message.pageCount)) {
                        const entry=cache.get(digest) || {expires:Date.now()+120_000,pageCount:message.pageCount,pages:new Map<number,OcrPage>()};
                        message.pages.forEach((page:OcrPage,index:number)=>entry.pages.set(pageNumbers?.[index] || index+1,structuredClone(page)));
                        while(entry.pages.size>12)entry.pages.delete(entry.pages.keys().next().value!);
                        cache.set(digest,entry);while(cache.size>2)cache.delete(cache.keys().next().value!);
                    }
                    finish(undefined, message.pages);
                }
            });
            child.send({ pdf: buffer.toString('base64'), pageNumbers });
        });
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
}
