import {createHash} from "node:crypto";

/** Metadata-only audit; never exports prompt text, gold answers or user context. */
export interface GoldCase {
 id:string;message:string;group:string;split?:string;annotationStatus?:string;
 previous?:unknown;dataClass?:string;
}
const norm=(s:string)=>s.normalize("NFKC").trim().toLowerCase()
 .replace(/\s+/g,"").replace(/[.,!?。！？，]/g,"");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export function auditIntentDataset(cases:readonly GoldCase[]){
 if(!cases.length)throw Error("empty evaluation dataset");
 const ids=new Set<string>(),exact=new Map<string,Set<string>>();
 let invalid=0;
 const splits=new Map<string,number>(),annotations=new Map<string,number>();
 for(const c of cases){
  if(!c||typeof c.id!=="string"||!c.id.trim()||ids.has(c.id)||
     typeof c.message!=="string"||!c.message.trim()||
     typeof c.group!=="string"||!c.group.trim()||
     c.dataClass!=="EVALUATION_ONLY"){
    invalid++;
    continue;
  }
  ids.add(c.id);
  const split=c.split??"unassigned";
  splits.set(split,(splits.get(split)??0)+1);
  const state=c.annotationStatus??"unreviewed";
  annotations.set(state,(annotations.get(state)??0)+1);
  const key=hash(JSON.stringify([norm(c.message),c.previous??null]));
  const entry=exact.get(key)??new Set<string>();
  entry.add(split);exact.set(key,entry);
 }
 const crossSplitDuplicateGroups=[...exact.values()].filter(v=>v.size>1).length;
 const summary={
  cases:cases.length,uniqueIds:ids.size,invalidCases:invalid,
  splits:Object.fromEntries([...splits].sort(([a],[b])=>a.localeCompare(b))),
  annotationStatuses:Object.fromEntries([...annotations].sort(([a],[b])=>a.localeCompare(b))),
  crossSplitDuplicateGroups,
  independentlyApproved:annotations.get("independently_adjudicated")===cases.length,
  safeForBlindHoldout:invalid===0&&crossSplitDuplicateGroups===0&&
    annotations.get("independently_adjudicated")===cases.length
 };
 return summary;
}
