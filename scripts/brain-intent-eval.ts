import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";
import {createIntentPort,parseShoppingIntent} from "../src/brain/intent.ts";
import {resolveShoppingPlan} from "../src/brain/shopping-plan.ts";
import {providerIntentModel} from "../src/brain/provider-intent.ts";
import {summarizeLatency} from "../src/brain/latency.ts";
import type {ShoppingPlan} from "../src/brain/shopping-plan.ts";

type Case={
 id:string;group:string;message:string;previous:ShoppingPlan|null;
 goldOutput:Record<string,unknown>;
 expected:{query:string;maxTotalWon:number|null;requiredConditions:string[];currentPreferences:Record<string,string>};
};
type Mode="gold-replay"|"live";
const path=fileURLToPath(new URL("../eval/brain/intent-v1.json",import.meta.url));
const file=JSON.parse(readFileSync(path,"utf8")) as {version:string;cases:Case[]};
if(file.version!=="brain-intent-eval-v1"||file.cases.length<10)throw new Error("invalid intent goldset");
const mode:Mode=process.argv.includes("--live")?"live":"gold-replay";
if(mode==="live"&&process.env.BRAIN_LIVE_EVAL_APPROVED!=="1")
 throw new Error("Live eval requires explicit BRAIN_LIVE_EVAL_APPROVED=1; never use in CI");
if(mode==="live"&&(!process.env.LLM_API_KEY||!process.env.LLM_MODEL))
 throw new Error("Live eval requires LLM_API_KEY and LLM_MODEL");
const ids=new Set(file.cases.map(c=>c.id));
if(ids.size!==file.cases.length)throw new Error("duplicate evaluation case ID");
type RecordResult={
 id:string;group:string;passed:boolean;fields:Record<string,boolean>;
 latencyMs:number;error?:string;model?:string
};
const results:RecordResult[]=[];
let provider: {chat:unknown;name:string}|null=null;
if(mode==="live"){
 // Import only when explicitly approved, keeping mock CI keyless.
 const mod=await import("../src/llm.ts");
 provider=mod.liveProvider();
}
const matches=(actual:unknown,expected:unknown)=>JSON.stringify(actual)===JSON.stringify(expected);
for(const c of file.cases){
 let raw="";
 const model=mode==="gold-replay"
   ?{complete:async()=>JSON.stringify(c.goldOutput)}
   :providerIntentModel(provider as Parameters<typeof providerIntentModel>[0],45000);
 const start=performance.now();
 let fields:Record<string,boolean>={},error: string|undefined;
 try{
   const extraction=await createIntentPort(model).extract(c.message,[],c.previous??undefined);
   const p=resolveShoppingPlan(c.previous,extraction);
   fields={
     query:p.query===c.expected.query,
     maxTotalWon:p.maxTotalWon===c.expected.maxTotalWon,
     requiredConditions:matches(p.requiredConditions,c.expected.requiredConditions),
     currentPreferences:matches(p.currentPreferences,c.expected.currentPreferences)
   };
   if(mode==="gold-replay"){
     const parsed=parseShoppingIntent(JSON.stringify(c.goldOutput));
     if(!matches(parsed,extraction))throw Error("gold replay parsed differently");
   }
 }catch(e){error=e instanceof Error?e.message:"unknown evaluator error";fields={plan:false};}
 const elapsed=performance.now()-start;
 results.push({id:c.id,group:c.group,passed:Object.values(fields).every(Boolean),fields,latencyMs:elapsed,
   ...(error?{error}:{}),...(mode==="live"?{model:process.env.LLM_MODEL}: {})});
}
const failures=results.filter(r=>!r.passed);
const lat=summarizeLatency(results.map(r=>r.latencyMs));
const summary={
 version:"brain-intent-eval-report-v1",mode,
 dataset:file.version,model:mode==="live"?process.env.LLM_MODEL:null,
 cases:results.length,passed:results.length-failures.length,failed:failures.length,
 exactPlanAccuracy:(results.length-failures.length)/results.length,
 latencyMs:lat,results
};
const destination=process.env.BRAIN_EVAL_REPORT_PATH;
if(destination){
 const dest=resolve(destination);
 mkdirSync(dirname(dest),{recursive:true});
 writeFileSync(dest,JSON.stringify(summary,null,2)+"\n");
}
process.stdout.write(JSON.stringify(summary,null,2)+"\n");
if(failures.length)process.exitCode=1;
