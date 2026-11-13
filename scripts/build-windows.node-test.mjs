import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {windowsArgs,isX64Pe} from './build-windows.mjs';

test('Windows build separates compilation from bundling and retains config',()=>{
  const result=windowsArgs(['--bundles','nsis','--config','publisher.json']);
  assert.deepEqual(result.build,['build','--no-bundle','--config','publisher.json']);
  assert.deepEqual(result.bundle,['bundle','--bundles','nsis','--config','publisher.json','--config','release-bundle.example.json']);
  assert.equal(windowsArgs(['--bundle-only']).bundleOnly,true);
  assert.throws(()=>windowsArgs(['--bundles','msi']));
});
test('only an x64 PE loader can be staged',()=>{
  const data=Buffer.alloc(256);data.write('MZ');data.writeUInt32LE(128,0x3c);data.write('PE\0\0',128,'binary');data.writeUInt16LE(0x8664,132);
  assert.equal(isX64Pe(data),true);data.writeUInt16LE(0x14c,132);assert.equal(isX64Pe(data),false);
  assert.equal(isX64Pe(Buffer.alloc(10)),false);data.writeUInt32LE(500,0x3c);assert.equal(isX64Pe(data),false);
});
test('default Windows release includes its loader beside the installed executable',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const config=JSON.parse(fs.readFileSync(new URL('../release-bundle.example.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts['build:windows'],'node scripts/build-windows.mjs --bundles nsis');
  assert.equal(config.bundle.resources[`../.release-loader-${pkg.version}/WebView2Loader.dll`],'WebView2Loader.dll');
});
