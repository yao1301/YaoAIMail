import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function windowsArgs(input) {
  const args=[...input];
  const bundleOnly=args.includes('--bundle-only');
  if(bundleOnly)args.splice(args.indexOf('--bundle-only'),1);
  const index=args.indexOf('--bundles');
  if(index>=0){if(args[index+1]!=='nsis')throw new Error('Windows release packaging expects --bundles nsis');args.splice(index,2);}
  return {bundleOnly,build:['build','--no-bundle',...args],bundle:['bundle','--bundles','nsis',...args,'--config','release-bundle.example.json'],args};
}

export function isX64Pe(data) {
  if(data.length<64||data.toString('ascii',0,2)!=='MZ')return false;
  const offset=data.readUInt32LE(0x3c);
  return offset+6<=data.length&&data.toString('binary',offset,offset+4)==='PE\0\0'&&data.readUInt16LE(offset+4)===0x8664;
}

export function stageWindowsLoader(root,args) {
  const metadata=JSON.parse(execFileSync('cargo',['metadata','--no-deps','--format-version','1'],{cwd:root,encoding:'utf8'}));
  const index=args.indexOf('--target');
  const target=index>=0?args[index+1]:process.env.CARGO_BUILD_TARGET;
  const buildDir=path.join(metadata.target_directory,...(target?[target]:[]),args.includes('--debug')?'debug':'release','build');
  const candidates=fs.readdirSync(buildDir,{withFileTypes:true})
    .filter(item=>item.isDirectory()&&item.name.startsWith('webview2-com-sys-'))
    .map(item=>path.join(buildDir,item.name,'out','x64','WebView2Loader.dll'))
    .filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  if(!candidates.length)throw new Error('No built x64 WebView2Loader.dll; build the application first');
  if(!isX64Pe(fs.readFileSync(candidates[0])))throw new Error('WebView2Loader.dll is not a valid x64 PE image');
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const relative=`.release-loader-${version}/WebView2Loader.dll`;
  const destination=path.join(root,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(candidates[0],destination);
  return relative;
}

export function buildWindows(input) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const cli=path.join(root,'node_modules','@tauri-apps','cli','tauri.js');
  const command=windowsArgs(input);
  const run=args=>{
    const result=spawnSync(process.execPath,[cli,...args],{cwd:root,stdio:'inherit',env:process.env});
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error(`Tauri exited with status ${result.status}`);
  };
  if(!command.bundleOnly)run(command.build);
  const loader=stageWindowsLoader(root,command.args);
  console.log(`[bundle] Including ${loader}`);
  run(command.bundle);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))buildWindows(process.argv.slice(2));
