export interface InterviewEntry {
 text:string;
 reply?:{intent_kind?:string;shopping_plan?:{query:string;maxTotalWon:number|null;attributePreferences?:string[]}|null};
}
const normalizedQuery=(query:string)=>query.trim().toLowerCase().replace(/\s+/g," ");
const answeredWithoutBudget=(text:string)=>/(?:예산|가격(?:대)?)\s*(?:은|이|는)?\s*(?:상관없|무관|제한\s*없)/.test(text);
const answeredPurpose=(text:string)=>/(?:보습|진정|산뜻한 사용감|기능 선호는 상관없)/.test(text);
export function resolveBrainInterviewState(entries:readonly InterviewEntry[],busy:boolean){
 const hidden={showBudgetQuestion:false,showEssencePurposeQuestion:false};
 if(busy)return hidden;
 const latest=entries.at(-1);
 const plan=latest?.reply?.shopping_plan;
 if(!plan)return hidden;
 const query=normalizedQuery(plan.query),current:InterviewEntry[]=[];
 for(let i=entries.length-1;i>=0;i--){
  const entry=entries[i],prior=entry.reply?.shopping_plan;
  if(prior&&normalizedQuery(prior.query)!==query)break;
  if(prior)current.push(entry);
 }
 const budgetKnown=plan.maxTotalWon!==null||current.some(entry=>answeredWithoutBudget(entry.text));
 const purposeKnown=(plan.attributePreferences?.length??0)>0||current.some(entry=>answeredPurpose(entry.text));
 return {showBudgetQuestion:!budgetKnown,showEssencePurposeQuestion:/에센스|세럼/.test(plan.query)&&budgetKnown&&!purposeKnown};
}
