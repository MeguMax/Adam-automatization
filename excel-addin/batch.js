(function(root) {
    'use strict';
    const rows=typeof module!=='undefined' && module.exports ? require('./row.js') : root.DevlinExcelRow;
    const zip=typeof module!=='undefined' && module.exports ? require('fflate') : root.fflate;
    const MAX_BYTES=16*1024*1024;
    function cancelled(signal,isCurrent) {
        if(signal?.aborted)throw Object.assign(new Error('Generation canceled. No files are available.'),{code:'batch_cancelled'});
        if(isCurrent && !isCurrent())throw new Error('The worksheet changed. Generate the cases again.');
    }
    function folder(data) {
        const label=[data.metadata.caseNumber,data.metadata.defendant].filter(Boolean).join(' - ')
            .normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/\s+/g,' ').trim();
        return ('Row '+data.row+' - '+label).slice(0,70).replace(/[. ]+$/g,'');
    }
    async function generate(snapshot,forms,options) {
        if(!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length<1 || snapshot.rows.length>10 ||
            !Array.isArray(forms) || !forms.length || forms.length>3 || new Set(forms.map(form=>form.id)).size!==forms.length ||
            forms.some(form=>!['dc105','dc508','mc202'].includes(form.id)) ||
            JSON.stringify(snapshot.formIds)!==JSON.stringify(forms.map(form=>form.id)))throw new Error('Read the selected cases and forms again.');
        const files={},results=[],members=[];let byteCount=0;
        const progress=record=>options.onProgress?.({...record});
        async function fresh() {
            cancelled(options.signal,options.isCurrent);
            const latest=await options.readCurrent();
            if(JSON.stringify(snapshot)!==JSON.stringify(latest))throw new Error('The worksheet changed. Generate the cases again.');
            cancelled(options.signal,options.isCurrent);
        }
        await fresh();
        snapshot.rows.forEach(record=>progress({row:record.row,name:record.data?.name || '',
            status:record.error ? record.error.code==='hidden_row'?'skipped':'failed' : 'queued',error:record.error?.message || ''}));
        for(const record of snapshot.rows) {
            cancelled(options.signal,options.isCurrent);
            const result={row:record.row,name:record.data?.name || '',status:'failed',error:record.error?.message || ''};
            if(record.error) {if(record.error.code==='hidden_row')result.status='skipped';results.push(result);continue;}
            const pending={},pendingMembers=[];
            try {
                progress({...result,status:'generating',completed:0,total:forms.length});
                for(const [index,form] of forms.entries()) {
                    cancelled(options.signal,options.isCurrent);
                    const filename=rows.pdfFilename({...record.data,form:form.id}).slice(0,-4).slice(0,100).replace(/[. ]+$/g,'')+'.pdf';
                    const values=Object.fromEntries(form.fields.map(field=>[field,record.data.values[field]]));
                    const bytes=await options.generate({form:form.id,values,filename},options.signal);
                    cancelled(options.signal,options.isCurrent);
                    if(!(bytes instanceof Uint8Array) || bytes.length<5 || new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('The PDF service returned an invalid PDF.');
                    if(bytes.length>8*1024*1024 || byteCount+bytes.length>MAX_BYTES)throw Object.assign(new Error('The archive exceeds 16 MB. Select fewer cases.'),{code:'batch_size'});
                    const path=folder(record.data)+'/'+filename;
                    pending[path]=bytes;byteCount+=bytes.length;
                    pendingMembers.push({row:record.row,form:form.id,path,filename:'Row '+record.row+' - '+filename});
                    progress({...result,status:'generating',completed:index+1,total:forms.length});
                }
                await fresh();
                Object.assign(files,pending);members.push(...pendingMembers);result.status='ready';
            }catch(error) {
                cancelled(options.signal,options.isCurrent);
                if(error.code==='batch_size' || /worksheet changed/i.test(error.message))throw error;
                result.error=error.message;
                Object.values(pending).forEach(bytes=>{byteCount-=bytes.length;});
                await fresh();
            }
            results.push(result);progress(result);
        }
        await fresh();
        if(!results.some(result=>result.status==='ready'))throw new Error('No cases generated. Correct the row errors and try again.');
        const plain=value=>String(value || '').replace(/[\r\n\t]/g,' ').slice(0,350);
        files['results.txt']=new TextEncoder().encode('Sheet: '+plain(snapshot.sheet)+'\r\nForms: '+forms.map(form=>form.id.toUpperCase()).join(', ')+
            '\r\n\r\n'+results.map(result=>'Row '+result.row+' | '+plain(result.name)+' | '+result.status+(result.error?' | '+plain(result.error):'')).join('\r\n'));
        return {bytes:zip.zipSync(files,{level:0}),results,members};
    }
    function readPdf(archive,path) {
        if(!(archive instanceof Uint8Array) || archive.length>MAX_BYTES+128*1024 ||
            typeof path!=='string' || !path.endsWith('.pdf'))throw new Error('The generated files are invalid. Generate them again.');
        let found=0,total=0;
        const files=zip.unzipSync(archive,{filter:file=>{
            total+=file.originalSize;
            if(total>MAX_BYTES+128*1024 || file.originalSize>8*1024*1024)throw new Error('The generated files exceed the download limit.');
            if(file.name!==path)return false;
            if(++found>1)throw new Error('The generated PDF is duplicated. Generate the files again.');
            return true;
        }});
        const bytes=files[path];
        if(found!==1 || !bytes || bytes.length<5 || new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')
            throw new Error('The generated PDF is missing or invalid. Generate the files again.');
        return bytes;
    }
    const api={generate,folder,readPdf};
    if(typeof module!=='undefined' && module.exports)module.exports=api;else root.DevlinExcelBatch=api;
})(globalThis);
