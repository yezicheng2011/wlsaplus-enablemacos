import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
const candidates=[process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
const cache=join(homedir(),'.cache','ms-playwright');
if(existsSync(cache))for(const folder of readdirSync(cache).filter(name=>name.startsWith('chromium-')))for(const directory of ['chrome-linux64','chrome-linux'])candidates.push(join(cache,folder,directory,'chrome'));
const chrome=candidates.find(value=>value && existsSync(value));
test('VPN recovery uses disconnect once and remains available without a selected node',{skip:!chrome && 'Chrome unavailable; open Tests/vpn-recovery-browser.html to run this bridge contract.',timeout:30000},async()=>{
  const profile=await mkdtemp(join(tmpdir(),'wlsaplus-vpn-ui-test-'));
  try{
    const {stdout}=await promisify(execFile)(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--virtual-time-budget=3000','--dump-dom',new URL('./vpn-recovery-browser.html',import.meta.url).href],{timeout:20000,maxBuffer:256*1024});
    const result=/<script id="vpn-recovery-test-results" type="application\/json">([\s\S]*?)<\/script>/u.exec(stdout);
    assert.ok(result,'Browser did not finish the VPN recovery checks.');
    const report=JSON.parse(result[1]);assert.deepEqual(report.failures,[]);assert.equal(report.passed,2);
  }finally{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
