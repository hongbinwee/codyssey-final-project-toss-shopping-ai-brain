import type {ShoppingPlan} from "./shopping-plan.ts";

export type BrainIntentKind="GREETING"|"SOCIAL"|"CAPABILITY"|"SHOPPING_SEARCH"|"SHOPPING_FOLLOWUP"|"REVIEW_COMPARE"|"CS_REQUEST"|"UNCERTAIN";
export interface BrainRoute {kind:BrainIntentKind;search:boolean;text?:string}
/** Pure, conservative routing: only complete social/help phrases bypass research. */
export function routeBrainMessage(message:string,previous?:ShoppingPlan):BrainRoute{
 const text=message.trim().replace(/[!?？!。.,~]+$/g,"").trim();
 if(/^(안녕(?:하세요|하십니까)?|하이|반가워(?:요)?|hello|hi)$/i.test(text))
  return {kind:"GREETING",search:false,text:"안녕하세요! 어떤 상품을 찾고 계세요? 예산이나 원하는 점을 알려주시면 함께 살펴볼게요."};
 if(/^(고마워(?:요)?|감사(?:합니다|해요)?|고맙습니다|thanks?|잘 알겠어(?:요)?)$/i.test(text))
  return {kind:"SOCIAL",search:false,text:"도움이 됐다니 좋아요. 더 궁금한 점이 있으면 말씀해 주세요."};
 if(/^(뭘 할 수 있(?:어|어요)|무엇을 할 수 있(?:어|나요)|기능(?: 소개| 알려줘)?|사용법|도움말|help)$/i.test(text))
  return {kind:"CAPABILITY",search:false,text:"상품을 찾고 예산·조건에 맞춰 비교하거나, 제공된 리뷰의 장단점을 근거와 함께 설명해 드려요. 원하는 조건은 대화 중 바꿀 수 있고, 장기 선호는 직접 확인할 때만 저장해요. 현재 시연 상품은 실제 주문·결제할 수 없어요."};
 if(/(?:내|제|주문번호|주문\s*(?:취소|변경|내역|조회)|환불|반품|교환\s*(?:신청|접수)|배송\s*(?:조회|추적|상태))/.test(text)&&
   /주문|취소|환불|반품|교환|배송/.test(text))
  return {kind:"CS_REQUEST",search:false,text:"주문·배송·취소는 해당 주문 화면에서 확인해 주세요. 이 쇼핑 대화에서는 주문 변경이나 환불을 실행하지 않아요. 현재 시연 상품은 주문·결제가 차단돼 있어요."};
 if(/^(도와줘|도와주세요|뭐|음|글쎄|추천해\s*줘|골라\s*줘|아무거나|그거)$/i.test(text)&&!previous)
  return {kind:"UNCERTAIN",search:false,text:"어떤 상품을 찾으세요? 상품 종류와 대략적인 예산부터 알려주시면 돼요."};
 if(/리뷰|후기|장단점|비교/.test(text))return {kind:"REVIEW_COMPARE",search:true};
 if(previous&&/^(그럼|그러면|그중|그 중|좀 더|더 |예산|가격|조건|가성비|아까|이전|대신|이번엔|그대로|향|색상|사이즈)/.test(text))
  return {kind:"SHOPPING_FOLLOWUP",search:true};
 if(text.length<2)return {kind:"UNCERTAIN",search:false,text:"찾으시는 상품이나 궁금한 점을 조금만 더 알려주세요."};
 return {kind:"SHOPPING_SEARCH",search:true};
}
