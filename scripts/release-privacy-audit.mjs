import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function scanFiles(root, config={}) {
  const findings=[];let files=0;
  const visit=directory=>{
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      const full=path.join(directory,item.name),relative=path.relative(root,full).replaceAll('\\','/');
      if(item.isSymbolicLink()){findings.push({path:relative,rule:'symlink'});continue;}
      if(item.isDirectory()){
        if(/^(data|EBWebView|logs|Tencent|\.git|node_modules|target)$/i.test(item.name)){findings.push({path:relative,rule:'private-or-generated-directory'});continue;}
        visit(full);continue;
      }
      if(!item.isFile())continue;files++;
      if(/(?:^|\/)(?:\.env(?!\.example$)|portable-key|pebble-profile\.txt)|\.(?:db(?:-wal|-shm)?|sqlite(?:-wal|-shm)?|xlog|mmap3|log|pem|key|p12)$/i.test(relative))findings.push({path:relative,rule:'private-file'});
      const data=fs.readFileSync(full);
      const text=data.toString('utf8');
      for(const [index,marker] of (config.markers??[]).entries()){
        if(marker.length<4)throw new Error('Audit markers must be at least four characters');
        if([Buffer.from(marker),Buffer.from(marker,'utf16le')].some(bytes=>data.includes(bytes)) || text.toLowerCase().includes(marker.toLowerCase()) || data.toString('utf16le').toLowerCase().includes(marker.toLowerCase()))findings.push({path:relative,rule:`private-marker-${index+1}`});
      }
      // Print locations, never the credential or matched private value.
      if(/(?:^|[^\w])(?:sk-[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{24,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(text))findings.push({path:relative,rule:'credential-shaped-literal'});
    }
  };visit(path.resolve(root));return {files,findings,passed:findings.length===0};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,configPath]=process.argv.slice(2);if(!root)throw new Error('Usage: node release-privacy-audit.mjs DIRECTORY [PRIVATE_CONFIG_JSON]');
  const report=scanFiles(root,configPath?JSON.parse(fs.readFileSync(configPath,'utf8')):{});
  console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
}
