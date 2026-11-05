import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadDraftPdf } from './draftPdfDownload';

test('a stalled PDF read is bounded, aborts its request and cannot return a late result',async()=>{
    let signal:AbortSignal|undefined,release!:(value:Buffer)=>void;
    const pending=downloadDraftPdf('https://onedrive.example/pdf',{timeoutMs:10,download:async(_url,current)=>{
        signal=current;return new Promise<Buffer>(resolve=>{release=resolve;});
    }});
    await assert.rejects(pending,/PDF download timed out/);
    assert.equal(signal!.aborted,true);
    release(Buffer.from('late result'));
    const next=await downloadDraftPdf('https://onedrive.example/next',{timeoutMs:100,download:async()=>Buffer.from('next PDF')});
    assert.equal(next.toString(),'next PDF');
});

test('PDF download preserves ordinary read errors and clears its timeout after success',async()=>{
    const failure=new Error('Cloud read denied');
    await assert.rejects(downloadDraftPdf('https://onedrive.example/pdf',{timeoutMs:100,download:async()=>{throw failure;}}),error=>error===failure);
    let signal:AbortSignal|undefined;
    const result=await downloadDraftPdf('https://onedrive.example/pdf',{timeoutMs:5,download:async(_url,current)=>{
        signal=current;return Buffer.from('PDF');
    }});
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(signal!.aborted,false);assert.equal(result.toString(),'PDF');
});
