const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=path.join(__dirname,'..','extension');
const read=file=>fs.readFileSync(path.join(root,'src',file),'utf8');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function hook(response,readyState='loading'){
  const messages=[],calls=[];let listener;
  const win={addEventListener:(_,fn)=>listener=fn,postMessage:msg=>messages.push(msg),fetch:async(input,init)=>{calls.push({input,init});return response(input,init);}};
  const context={window:win,document:{readyState},location:{origin:'https://www.youtube.com'},URL,Request,Response,Headers,Blob,TextDecoder,DecompressionStream,Date};
  vm.runInNewContext(read('main.js'),context);
  const arm=(nonce='0123456789abcdef',id='123456789')=>listener({source:win,origin:context.location.origin,data:{gcfy:'to-main',type:'arm',nonce,id}});
  const send=(text='hello ',nonce='0123456789abcdef',endpoint='create_comment',extra={})=>win.fetch(`https://www.youtube.com/youtubei/v1/comment/${endpoint}`,{method:'POST',body:JSON.stringify({commentText:text+`[[gif:123456789:${nonce}]]`,context:{client:{}}}),...extra});
  return {win,messages,calls,arm,send};
}
const success=()=>new Response(JSON.stringify({actionResult:{status:'STATUS_SUCCEEDED'}}));
async function backendTests(){
  await test('preserves whitespace and changes only armed GIF request',async()=>{
    const h=hook(success);h.arm();await h.send('  hello\n ');
    const data=JSON.parse(h.calls[0].init.body);assert.equal(data.commentText,'  hello\n ');assert.equal(data.tenorId,'123456789');assert(!h.calls[0].init.body.includes('[[gif:'));assert.equal(h.messages.at(-1).kind,'posted');
  });
  await test('reply and GIF-only comment',async()=>{const h=hook(success);h.arm();await h.send('','0123456789abcdef','create_comment_reply');assert.equal(JSON.parse(h.calls[0].init.body).commentText,undefined);});
  await test('400 INVALID_ARGUMENT is one rejected request, not account diagnosis',async()=>{const h=hook(()=>new Response(JSON.stringify({error:{status:'INVALID_ARGUMENT',message:'Invalid context'}}),{status:400}));h.arm();await h.send();assert.equal(h.calls.length,1);assert.equal(h.messages.at(-1).kind,'rejected');assert.equal(h.messages.at(-1).message,'Invalid context');});
  await test('connection loss remains uncertain',async()=>{const h=hook(()=>{throw new TypeError('Network reset');});h.arm();await assert.rejects(h.send());assert.equal(h.messages.at(-1).kind,'uncertain');assert.equal(h.calls.length,1);});
  await test('5xx and unreadable response remain uncertain',async()=>{for(const response of [()=>new Response('{}',{status:503}),()=>new Response('not json')]){const h=hook(response);h.arm();await h.send();assert.equal(h.messages.at(-1).kind,'uncertain');}});
  await test('nested YouTube error actions reject HTTP 200',async()=>{const h=hook(()=>new Response(JSON.stringify({actions:[{commandExecutorCommand:{commands:[{showErrorAction:{errorMessage:{simpleText:'Rejected'}}}]}}]})));h.arm();await h.send();assert.equal(h.messages.at(-1).kind,'rejected');});
  await test('unknown nonce, edit and marker in middle are blocked',async()=>{for(const which of ['unknown','edit','middle']){const h=hook(success);if(which!=='unknown')h.arm();const promise=which==='middle'?h.win.fetch('https://www.youtube.com/youtubei/v1/comment/create_comment',{method:'POST',body:JSON.stringify({commentText:'[[gif:123456789:0123456789abcdef]] trailing'})}):h.send('hello ','0123456789abcdef',which==='edit'?'update_comment':'create_comment');await assert.rejects(promise);assert.equal(h.calls.length,0);}});
  await test('replayed nonce is blocked',async()=>{const h=hook(success);h.arm();await h.send();h.arm();await assert.rejects(h.send());assert.equal(h.calls.length,1);});
  await test('only one arm accepted at a time',async()=>{const h=hook(success);h.arm();h.arm('fedcba9876543210');assert.equal(h.messages.at(-1).type,'refused');});
  await test('unreadable gzip blocked while armed',async()=>{const h=hook(success);h.arm();await assert.rejects(h.send('',undefined,undefined,{headers:{'content-encoding':'gzip'}}));assert.equal(h.calls.length,0);assert.equal(h.messages.at(-1).code,'unreadable');});
  await test('valid gzip is decoded and request headers preserved',async()=>{
    const zlib=require('node:zlib');const h=hook(success);h.arm();
    const req=new Request('https://www.youtube.com/youtubei/v1/comment/create_comment',{method:'POST',headers:{'content-encoding':'gzip','x-test':'retained'},body:zlib.gzipSync(JSON.stringify({commentText:'hello [[gif:123456789:0123456789abcdef]]'}))});
    await h.win.fetch(req);const sent=h.calls[0].input;assert.equal(sent.headers.get('x-test'),'retained');assert.equal(sent.headers.get('content-encoding'),null);assert.equal((await sent.json()).tenorId,'123456789');
  });
  await test('ordinary comments and foreign origins pass through',async()=>{const h=hook(success);h.arm();await h.win.fetch('https://www.youtube.com/youtubei/v1/comment/create_comment',{method:'POST',body:'{"commentText":"normal"}'});await h.win.fetch('https://example.org/youtubei/v1/comment/create_comment',{method:'POST',body:'normal'});assert.equal(h.calls.length,2);});
  const storage={};let handler;const pendingCalls=[];
  const chrome={runtime:{id:'test',onInstalled:{addListener(){}},onMessage:{addListener(fn){handler=fn;}}},storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,structuredClone(storage[k])])),set:async data=>{await new Promise(r=>setTimeout(r,2));Object.assign(storage,structuredClone(data));},remove:async key=>delete storage[key]}}};
  const context={chrome,URL,URLSearchParams,AbortSignal,navigator:{language:'ru'},Map,Date,atob,fetch:async url=>{pendingCalls.push(url);if(url==='https://tenor.com/'){const res=new Response('<script id="store-cache" type="text/x-cache">{}</script><script id="data" type="text/x-cache">'+btoa(JSON.stringify({API_V2_KEY:'test',API_V2_CLIENT_KEY:'test'}))+'</script>');Object.defineProperty(res,'url',{value:url});return res;}return new Response(JSON.stringify({results:[{id:'123456789',content_rating:'G',media_formats:{tinygif:{url:'https://media.tenor.com/demo/a.gif',dims:[200,100]}}}],next:'page2'}));}};
  vm.createContext(context);vm.runInContext(read('shared.js'),context);vm.runInContext(read('sw.js'),context);
  const send=msg=>new Promise(resolve=>handler(msg,{id:'test'},resolve));
  const gif=id=>({id,title:'Test',preview:'https://media.tenor.com/demo/a.gif',width:200,height:100,contentRating:'G'});
  await test('concurrent favorite operations retain both updates',async()=>{const results=await Promise.all([send({type:'library:toggle',gif:gif('111111')}),send({type:'library:toggle',gif:gif('222222')})]);assert(results.every(r=>r.ok));assert.equal(storage.favorites.length,2);});
  await test('invalid imports do not change favorites',async()=>{const before=JSON.stringify(storage.favorites);assert.equal((await send({type:'library:import',gifs:[{...gif('333333'),preview:'https://evil.example/a.gif'}]})).ok,false);assert.equal(JSON.stringify(storage.favorites),before);});
  await test('malformed dimensions and URL credentials rejected',async()=>{for(const bad of [{...gif('3'),width:Infinity},{...gif('3'),preview:'https://user@media.tenor.com/a.gif'}])assert.equal((await send({type:'library:toggle',gif:bad})).ok,false);});
  await test('recent list deduplicates and caps at 30',async()=>{for(let i=0;i<35;i++)await send({type:'library:recent',gif:gif(String(100+i))});await send({type:'library:recent',gif:gif('134')});assert.equal(storage.recent.length,30);assert.equal(storage.recent[0].id,'134');});
  await test('search combines in-flight requests and returns continuation',async()=>{const results=await Promise.all([send({type:'search',query:'wow',locale:'ru_RU'}),send({type:'search',query:'wow',locale:'ru_RU'})]);assert.equal(results[0].next,'page2');assert.equal(pendingCalls.filter(u=>u.includes('/search?')).length,1);});
  await test('recovery draft validation and cleanup',async()=>{await send({type:'library:recover',draft:{key:'a',videoId:'abcdefghijk',text:'my text',gif:gif('1')}});assert.equal(storage.recovery[0].text,'my text');await send({type:'library:forgetDraft',key:'a'});assert.equal(storage.recovery.length,0);});
  await test('manifest requests precise hosts and has no personal identity',async()=>{const m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));assert(m.host_permissions.includes('https://tenor.googleapis.com/*'));assert(!JSON.stringify(m).includes('rayytor'));assert(m.content_scripts[1].js[0]==='src/shared.js');});
}

backendTests().then(()=>console.log(`ALL ${passed} CORE TESTS PASSED`)).catch(e=>{console.error(e);process.exitCode=1;});
