import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [destination]=process.argv.slice(2);if(!destination)throw new Error('Supply a new empty source snapshot directory');
const root=process.cwd(),output=path.resolve(destination);
if(output===root||output.startsWith(root+path.sep))throw new Error('Snapshot must be outside the source checkout');
if(fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('Refusing to overwrite source snapshot');
const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(Boolean);
const rootFiles=new Set(['Cargo.toml','Cargo.lock','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','rust-toolchain.toml','index.html','vite.config.ts','tsconfig.json','tsconfig.node.json','LICENSE','README.md','README.zh-CN.md','REBUILDING.md','release-config.example.json','release-bundle.example.json','CHANGELOG.md','CHANGELOG.zh-CN.md','.gitignore','.env.example','icon.png']);
// Public policy fixtures are used by regression tests. Do not sweep website
// screenshots, deployment account settings or other unrelated local material.
const policyFiles=new Set(['site/index.html','site/main.js','site/privacy.html','site/terms.html','site/style.css','site/favicon.png']);
const manifest=[];
for(const relative of [...new Set(paths)].sort()){
  const approved=rootFiles.has(relative)||policyFiles.has(relative)||/^(?:src\/|tests\/|public\/|scripts\/|\.cargo\/|\.github\/|crates\/[^/]+\/)/.test(relative)||/^src-tauri\/(?:src\/|icons\/|capabilities\/|permissions\/|Cargo.toml$|build.rs$|tauri.conf.json$)/.test(relative);
  if(!approved||/(?:^|\/)(?:node_modules|target|Tencent|data|EBWebView|logs|\.bak)(?:\/|$)|\.(?:db(?:-wal|-shm)?|sqlite(?:-wal|-shm)?|log|xlog|mmap3|key|pem|p12|bak)$|(?:^|\/)\.env(?!\.example$)/i.test(relative))continue;
  const source=path.resolve(root,relative);if(!source.startsWith(root+path.sep))throw new Error('Invalid source path');
  if(!fs.existsSync(source))continue;const stat=fs.lstatSync(source);if(stat.isSymbolicLink())throw new Error('Symlinks are not release source files');if(!stat.isFile())continue;
  const data=fs.readFileSync(source),target=path.join(output,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
  manifest.push({path:relative,sha256:crypto.createHash('sha256').update(data).digest('hex')});
}
// Use the maintained pnpm lock. Do not resurrect an ignored local npm lock:
// it may describe an older application and a different dependency graph.
const buildFiles=['Cargo.toml','Cargo.lock','package.json','src-tauri/build.rs','src-tauri/tauri.conf.json','src-tauri/src/lib.rs','crates/pebble-websearch/src/investigation.rs'];
for(const required of buildFiles)if(!manifest.some(v=>v.path===required))throw new Error(`Missing build source: ${required}`);
fs.writeFileSync(path.join(output,'SOURCE-MANIFEST.json'),JSON.stringify({version:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,files:manifest},null,2)+'\n');
console.log(JSON.stringify({files:manifest.length,destination:output}));
