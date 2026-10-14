// Integration test: disposable PostgreSQL + local Evolution HTTP simulator only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {buildApp} from '../dist/src/app.js';
import {loadEnv} from '../dist/src/config/env.js';
import {PostgresRepository} from '../dist/src/repositories/postgres.repository.js';
import {PiiCipher} from '../dist/src/security/pii-cipher.js';
import {RuntimeSecretStore} from '../dist/src/security/runtime-secret.store.js';
import {EvolutionService} from '../dist/src/services/evolution.service.js';
import {ConversationService} from '../dist/src/services/conversation.service.js';
import {HumanMessagesService} from '../dist/src/services/human-messages.service.js';
import {CoordinatorNotificationService} from '../dist/src/services/coordinator-notification.service.js';
assert.match(process.env.DATABASE_URL ?? '', /ownership-test/);
const key='human-portal-test-key';const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
let coordinator='5521999994321';
const repo=new PostgresRepository(pool,key,async()=>coordinator);
const sent=[];let mode=200;
const server=createServer(async(req,res)=>{
 let data='';for await(const chunk of req) data+=chunk;
 if(mode===429 || mode===400) {res.writeHead(mode);res.end('{}');return;}
 sent.push({url:req.url,...JSON.parse(data)});
 if(mode===504) {req.socket.destroy();return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(mode===204 ? {} : {key:{id:`human-sim-${sent.length}`}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const env=loadEnv({...process.env,LOG_LEVEL:'silent',EVOLUTION_API_URL:`http://127.0.0.1:${server.address().port}`,EVOLUTION_API_KEY:'simulated',EVOLUTION_INSTANCE_NAME:'same-debora-channel',EVOLUTION_MAX_RETRIES:'0'});
const evolution=new EvolutionService(env);
const human=new HumanMessagesService(pool,repo,evolution,key);
const agent={embed:async()=>null,respond:async()=>'Resposta IA'};
const conversations=new ConversationService(repo,agent,evolution);
const secrets=new RuntimeSecretStore('/tmp/human-portal-secrets.json',key);
const app=await buildApp({env,repository:repo,evolution,conversations,openai:agent,secrets,humanMessages:human});
const inbound=(text,id=randomUUID())=>({externalMessageId:id,phone:'5521988887777',pushName:'Cliente de teste',content:text,timestamp:new Date(),raw:{}});
try {
 const context=(await repo.ingestInbound(inbound('Início'))).context;
 const url=`/dashboard/conversations/${context.conversationId}/messages`;
 const payload={text:'Resposta humana pelo portal',requestKey:randomUUID(),version:0};
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/dashboard/auth/login',payload:{username:env.DASHBOARD_USERNAME,password:env.DASHBOARD_PASSWORD}});
 assert.equal(login.statusCode,200);
 const headers={authorization:`Bearer ${login.json().token}`};
 assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,409);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,phone:'5521999994321'}})).statusCode,400);
 assert.equal((await app.inject({method:'PATCH',url:`/dashboard/conversations/${context.conversationId}/workflow`,headers,payload:{state:'coordinator_attending',reason:'Assumir teste'}})).statusCode,200);
 payload.version=(await repo.getContext(context.conversationId)).ownershipVersion;
 const [first,second]=await Promise.all([app.inject({method:'POST',url,headers,payload}),app.inject({method:'POST',url,headers,payload})]);
 assert.equal(first.statusCode,202);assert.equal(first.json().message.id,second.json().message.id);
 await Promise.all([human.runOnce(),new HumanMessagesService(pool,repo,evolution,key).runOnce()]);
 assert.equal(sent.length,1);assert.equal(sent[0].number,context.phone);assert.match(sent[0].url,/same-debora-channel$/);
 const page=(await app.inject({method:'GET',url,headers})).json();
 assert.equal(page.outgoing[0].status,'accepted');assert.ok(page.outgoing[0].providerMessageId);
 assert.equal(page.messages[0].author,`dashboard:${env.DASHBOARD_USERNAME}`);
 assert.equal((await conversations.handle(inbound('oi'))).status,'paused');assert.equal(sent.length,1);
 await repo.recordHumanOutbound({...inbound('eco'),externalMessageId:page.outgoing[0].providerMessageId});
 assert.equal((await repo.getContext(context.conversationId)).ownershipVersion,payload.version);
 const queued=await human.enqueue(context.conversationId,'Não enviar após devolver',randomUUID(),payload.version,'dashboard:operator');
 await repo.setConversationWorkflow(context.conversationId,'ai_attending','ai','Devolvido','dashboard:operator');
 await human.runOnce();
 assert.equal((await human.page(context.conversationId)).outgoing.find(row=>row.id===queued.id).status,'cancelled');assert.equal(sent.length,1);
 await repo.setConversationWorkflow(context.conversationId,'coordinator_attending','coordinator','Assumido');
 const version=(await repo.getContext(context.conversationId)).ownershipVersion;
 for(const [status,expected] of [[429,'queued'],[400,'failed'],[204,'unknown'],[504,'unknown']]) {
  mode=status;const job=await human.enqueue(context.conversationId,`Test ${status}`,randomUUID(),version,'dashboard:operator');
  await human.runOnce();assert.equal((await human.page(context.conversationId)).outgoing.find(row=>row.id===job.id).status,expected);
 }
 mode=200;
 const before=sent.length;await human.runOnce();assert.equal(sent.length,before,'unknown must never resend');
 await pool.query("UPDATE human_outbound_jobs SET status='processing',updated_at=now()-interval '3 minutes' WHERE status='queued'");
 await new HumanMessagesService(pool,repo,evolution,key).runOnce();
 assert.equal((await pool.query("SELECT count(*) FROM human_outbound_jobs WHERE status='processing'")).rows[0].count,'0');
 const pii=new PiiCipher(key);
 await pool.query(`INSERT INTO messages(conversation_id,external_message_id,direction,content,timestamp)
   SELECT $1,gen_random_uuid()::text,'inbound',$2,now() - n*interval '1 minute' FROM generate_series(1,125) n`,[context.conversationId,pii.encrypt('Histórico antigo')]);
 let cursor;const ids=new Set();do {const result=(await app.inject({method:'GET',url:`${url}${cursor ? '?cursor='+cursor : ''}`,headers})).json();for(const row of result.messages) ids.add(row.id);cursor=result.nextCursor;}while(cursor);
 assert.ok(ids.size>=128);
 await pool.query("UPDATE conversations SET status='closed' WHERE id=$1",[context.conversationId]);
 const newer=(await repo.ingestInbound(inbound('Nova conversa'))).context;
 assert.notEqual(newer.conversationId,context.conversationId);
 const exact=(await app.inject({method:'GET',url:`/dashboard/conversations/${context.conversationId}`,headers})).json().lead;
 assert.equal(exact.conversation_id,context.conversationId);
 coordinator=context.phone;
 assert.equal((await conversations.handle(inbound('Mensagem coordenador'))).status,'ignored');
 assert.equal(await repo.isPhoneIgnored('+55 (21) 98888-7777'),true);
 coordinator='5521999994321';
 const notifier=new CoordinatorNotificationService(repo,evolution,async()=>coordinator,'https://portal.example');
 await notifier.notify(newer,{assessment:{temperature:'hot',reason:'Humano',mainQuestions:[],objections:[],course:null,interest:null,shouldHandoff:true,handoffReason:'Humano',notInterested:false},summary:'Resumo',lastMessage:'Solicitação',reason:'Humano',sourceMessageId:'notification-check',requestedAt:new Date()});
 assert.equal(sent.at(-1).number,coordinator);assert.match(sent.at(-1).text,new RegExp(newer.conversationId));
 assert.equal((await pool.query('SELECT count(*) FROM contacts WHERE phone_hash=$1',[pii.phoneHash(coordinator)])).rows[0].count,'0','coordinator needs no prior inbound conversation');
 console.log('PASS: portal authentication, fixed recipient/channel, idempotency, concurrency, cancellation on return, provider failures/unknowns, restart recovery, >100 messages, exact conversation, coordinator exclusion/notification');
} finally {await app.close();server.close();await pool.end();}
