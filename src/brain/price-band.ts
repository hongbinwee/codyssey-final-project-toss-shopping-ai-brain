/** Exact KRW band interpretation for user-selected 만원대 chips.
 * No implicit widening; additional non-Won currencies are not converted. */
export function parseKrwTenThousandBand(text:string):{minTotalWon:number;maxTotalWon:number}|null{
 const found=[...text.matchAll(/(?:^|\s)(\d{1,3})\s*만\s*원대(?=$|\s|[,.!?]|에서|로|를|은|는|에)/g)];
 if(found.length!==1||/이하|이상|초과|미만|부터|까지/.test(text))return null;
 const n=Number(found[0][1]);
 if(!Number.isSafeInteger(n)||n<1||n>999)return null;
 // "1만원대" = 10,000–19,999, "15만원대" = 150,000–159,999.
 const trailingZeros=String(n).match(/0+$/)?.[0].length??0;
 const step=10000*10**trailingZeros;
 const min=n*10000,max=min+step-1;
 return Number.isSafeInteger(max)?{minTotalWon:min,maxTotalWon:max}:null;
}
