import {Queue,Worker} from 'bullmq';
import {generate} from './authoring.ts';
import * as store from './store.ts';
export function redis(){const url=new URL(process.env.REDIS_URL!);return {host:url.hostname,port:Number(url.port||6379),username:url.username||undefined,password:url.password||undefined,...(url.protocol==='rediss:'?{tls:{}}:{})};}
export function queue(){return new Queue('openmerit-authoring',{connection:redis()});}
export function startWorker(){return new Worker('openmerit-authoring',async job=>{const {workspace,input,id}=job.data;await store.put(workspace,'jobs',id,{id,status:'running'});try{const proposal=await generate(workspace,input);await store.put(workspace,'jobs',id,{id,status:'complete',proposal});return {id};}catch(e){await store.put(workspace,'jobs',id,{id,status:'failed',error:e instanceof Error?e.message:'Generation failed'});throw e;}},{connection:redis(),concurrency:2});}
