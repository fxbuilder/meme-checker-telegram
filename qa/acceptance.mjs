// Run in the QA worktree; override both source roots to test an integrated build.
import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const load=(root,file)=>import(pathToFileURL(resolve(root,'src',file+'.mjs')));
const t=process.env.QA_TELEGRAM || '../telegram', i=process.env.QA_INTEGRATION || '../integration';
const {detectCandidates}=await load(t,'detect-ca'), {formatCard}=await load(t,'format-card'), {checkCooldown}=await load(t,'cooldown');
const {mockScan,normalizeMock}=await load(i,'mock-scan');
const sol='FiXtUrE111111111111111111111111111111111111', bnb='0xabcdef0123456789abcdef0123456789abcdef01';
for(const [chain,address,input] of [['solana',sol,sol],['bsc',bnb,bnb.toUpperCase()]])test(chain+' candidate → fixture → exact CTA',async()=>{
 const [req]=detectCandidates(`Please check (${input})`);assert.deepEqual(req,{chain,address});const r=await mockScan(req);const {text,buttons}=formatCard(r);assert.match(text,/\[mock\]/);assert.match(text,new RegExp(r.token.name));assert.equal(new URL(buttons[0][0].url).pathname,`/check/${chain}/${address}`);assert.doesNotMatch(text,/NARRATIVE/);
 if(chain==='bsc'){assert.match(text,/Volume 24H: \$0/);assert.doesNotMatch(text,/Market Cap:/);assert.match(text,/FDV:/);}
});
const req={chain:'solana',address:sol},data={...req,token:{name:'Example',symbol:'EX'}};
test('wrong chain or same ticker with wrong address fails closed',()=>{for(const patch of [{chain:'bsc'},{address:sol.toLowerCase()}]){const r=normalizeMock(req,{success:true,data:{...data,...patch}});assert.equal(r.status,'invalid-response');assert.deepEqual(formatCard(r).buttons,[]);}});
test('miss and invalid response are distinct',async()=>{const miss=await mockScan({...req,address:sol.toLowerCase()});assert.equal(miss.status,'not-found');assert.match(formatCard(miss).text,/Token Not Found/);assert.doesNotMatch(formatCard(normalizeMock(req,null)).text,/Token Not Found/);});
for(const status of ['not-found','invalid-response'])test('visible mock label on '+status,()=>assert.match(formatCard({mode:'mock',status},{mockLabel:true}).text,/\[mock\]/));
const gate=(userId,chatId,address)=>checkCooldown({userId,chatId,address});
test('duplicate across users; cooldown on another address; independent chat',()=>{assert.equal(gate(1,1,sol).blocked,false);assert.equal(gate(2,1,sol).reason,'duplicate');assert.equal(gate(1,1,bnb).reason,'cooldown');assert.equal(gate(2,2,sol).blocked,false);});
test('distinct Solana keys must not collide in group dedup',()=>{assert.equal(gate(1,3,sol).blocked,false);assert.equal(gate(2,3,sol.toLowerCase()).blocked,false);});
test('missing confirmed token route must not synthesize analysis link',async()=>{const r=await mockScan(req);r.fullAnalysisUrl=null;const links=formatCard(r,{websiteBase:'https://site.invalid'}).buttons.flat();assert.equal(links.find(b=>b.text.includes('View Full Analysis'))?.url,undefined);});
