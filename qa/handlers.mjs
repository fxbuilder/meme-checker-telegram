// Isolated process: substitute only Telegram transport; no network or real token.
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const shim=`export class Telegraf { start(f){globalThis.h.start=f} help(f){globalThis.h.help=f} command(k,f){globalThis.h[k]=f} on(k,f){globalThis.h[k]=f} catch(){} async launch(){} } export const Markup={button:{url:(text,url)=>({text,url})},inlineKeyboard:rows=>({reply_markup:{inline_keyboard:rows}})};`;
registerHooks({resolve(s,c,next){return s==='telegraf'?{url:'data:text/javascript,'+encodeURIComponent(shim),shortCircuit:true}:next(s,c)}});
process.env.SCAN_MODE='mock';process.env.TELEGRAM_BOT_TOKEN='offline-only';process.env.TOKEN_PAGE_BASE_URL='';globalThis.h={};
await import(pathToFileURL(resolve(process.env.QA_TELEGRAM||'../telegram','src/bot.mjs')));
const address='0xabcdef0123456789abcdef0123456789abcdef01';
async function send(k,text,is_bot,id){const out=[];await h[k]({message:{text},chat:{id},from:{id:13,is_bot},reply:async(t)=>{out.push(t);return {message_id:1}},telegram:{editMessageText:async(a,b,c,t)=>out.push(t)}});return out;}
// Inspect the keyboard attached to the final card, not the scanner field.
for (const [idx, [chain, ca]] of [['solana','FiXtUrE111111111111111111111111111111111111'],['bsc',address]].entries()) {
  for (const [j, base] of ['', 'https://qa.memechecker.test'].entries()) {
    test(`${chain}: outgoing analysis button with ${base ? 'configured' : 'empty'} base`, async () => {
      process.env.TOKEN_PAGE_BASE_URL = base;
      try {
        const botUrl = pathToFileURL(resolve(process.env.QA_TELEGRAM || '../telegram','src/bot.mjs'));
        botUrl.searchParams.set('qa', `${idx}-${j}`);
        await import(botUrl.href);
        const cards = [];
        await h.message({message:{text:ca},chat:{id:100+idx*2+j},from:{id:9,is_bot:false},
          reply:async()=>({message_id:1}),
          telegram:{editMessageText:async(_chat,_msg,_inline,text,options)=>cards.push({text,options})}});
        assert.equal(cards.length,1);
        assert.match(cards[0].text,/\[mock\]/);
        const links=(cards[0].options.reply_markup?.inline_keyboard??[]).flat()
          .filter(b=>b.text.includes('View Full Analysis')).map(b=>{const url=new URL(b.url);return url.origin+url.pathname;});
        assert.deepEqual(links,base ? [`${base}/check/${chain}/${ca}`] : []);
      } finally {process.env.TOKEN_PAGE_BASE_URL='';}
    });
  }
}
for(const k of ['message','check','help'])test('bot sender ignored: '+k,async()=>assert.deepEqual(await send(k,k==='message'?address:`/${k} ${address}`,true,1),[]));
test('human group text and manual check return marked card',async()=>{for(const [k,id] of [['message',2],['check',3]])assert.match((await send(k,k==='message'?address:'/check '+address,false,id)).at(-1),/\[mock\]/)});
