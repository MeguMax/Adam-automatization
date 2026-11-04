import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizePaymentLedger,validatePaymentAudit} from './mifilePaymentAudit';

const now=Date.parse('2026-11-04T20:00:00Z'),range={from:'2026-09-29',through:'2026-11-04'};
const targets=[{caseNumber:'26-01617-LT',courtName:'MI Example County - 29th District Court'}];
const row={CaseNumber:'26-01617-LT',CourtName:targets[0].courtName,TransactionId:'private-transaction-id',
    AuthorizationDateTime:'2026-10-29T14:00:00Z',AuthorizationAmount:'126.69',DocumentType:'Complaint',
    PaymentId:'private-payment-id',PaymentAccount:'PRIVATE CARD DETAILS',AuthorizationCode:'PRIVATE CODE'};

test('payment audit retains authorization evidence without calling it settlement or unpaid',()=>{
    const result=summarizePaymentLedger([row,row,{...row,TransactionId:'refund-reference',AuthorizationAmount:-13}],targets,range,now);
    assert.equal(result.cases[0].records.length,2);assert.equal(result.cases[0].records[0].authorizationCents,12669);
    assert.equal(result.cases[0].records[1].authorizationCents,-1300);
    assert.equal(result.cases[0].evidence,'authorization_records_found');
    assert.equal(result.cases[0].unpaidConfirmed,false);assert.equal(result.cases[0].settlementVerified,false);
    assert.equal(result.cases[0].retryAuthorized,false);assert.equal(result.readOnly,true);
    assert.ok(!/PRIVATE|private-transaction|private-payment|PaymentAccount|AuthorizationCode/.test(JSON.stringify(result)));
});

test('payment audit matches the exact court and case, not substrings or another court',()=>{
    const result=summarizePaymentLedger([{...row,CaseNumber:'126-01617-LT'},
        {...row,CourtName:'MI Different County - 29th District Court'}],targets,range,now);
    assert.equal(result.cases[0].records.length,0);assert.equal(result.cases[0].evidence,'no_matching_records');
    assert.equal(result.cases[0].unpaidConfirmed,false);assert.equal(result.cases[0].alternateCourtNames.length,1);
});

test('malformed or out-of-range matching financial evidence requires review, never a guessed amount',()=>{
    for(const change of [{AuthorizationAmount:'1.001'},{AuthorizationAmount:'$126.69'},
        {AuthorizationDateTime:'2020-01-01'},{TransactionId:null},{PaymentId:{}},{DocumentType:'\nSecret'}]) {
        const result=summarizePaymentLedger([{...row,...change}],targets,range,now);
        assert.equal(result.cases[0].evidence,'review_required');assert.equal(result.cases[0].records.length,0);
        assert.equal(result.cases[0].unpaidConfirmed,false);
    }
    assert.throws(()=>summarizePaymentLedger({},targets,range,now));
    assert.throws(()=>summarizePaymentLedger(Array(10_001).fill(row),targets,range,now));
});

test('case audit bounds targets and valid calendar dates before login or network access',()=>{
    for(const items of [[],Array(11).fill(targets[0]),[...targets,...targets],
        [{caseNumber:'26-01617-LT/?secret',courtName:targets[0].courtName}],null])assert.throws(()=>validatePaymentAudit(items,range,now));
    for(const dates of [{from:'2026-02-30',through:'2026-11-04'},
        {from:'2026-01-01',through:'2026-11-04'},{from:'2026-11-04',through:'2026-10-01'},
        {from:'2026-11-04',through:'2026-11-07'}])assert.throws(()=>validatePaymentAudit(targets,dates,now));
    validatePaymentAudit(targets,range,now);
});
