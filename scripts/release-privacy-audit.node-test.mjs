import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanFiles} from './release-privacy-audit.mjs';

function fixture(run){const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-audit-test-'));try{run(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('clean source passes without a user-specific marker list',()=>fixture(root=>{
 fs.writeFileSync(path.join(root,'main.ts'),'export const label = "Mail assistant";');assert.equal(scanFiles(root).passed,true);
}));
test('UTF-16 and case variations are caught without printing private values',()=>fixture(root=>{
 fs.writeFileSync(path.join(root,'program.exe'),Buffer.from('PRIVATE-FIXTURE-VALUE','utf16le'));
 const result=scanFiles(root,{markers:['private-fixture-value']});assert.equal(result.passed,false);
 assert.equal(result.findings[0].rule,'private-marker-1');assert.ok(!JSON.stringify(result).includes('PRIVATE-FIXTURE-VALUE'));
}));
test('local profile pointers, input-method caches and dotenv are rejected',()=>fixture(root=>{
 for(const name of ['pebble-profile.txt','.env','sample.xlog','portable-key'])fs.writeFileSync(path.join(root,name),'fixture');
 assert.equal(scanFiles(root).findings.filter(v=>v.rule==='private-file').length,4);
}));
test('credential-shaped literals are rejected',()=>fixture(root=>{
 fs.writeFileSync(path.join(root,'settings.js'),'const secret="'+'sk-'+'x'.repeat(32)+'";');
 assert.equal(scanFiles(root).findings[0].rule,'credential-shaped-literal');
}));
