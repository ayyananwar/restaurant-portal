import type { BillSnapshot, BillingProfile } from './contracts.js';

export const stateNames: Record<string,string> = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim',
  '12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya',
  '18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','26':'Dadra and Nagar Haveli and Daman and Diu','27':'Maharashtra','29':'Karnataka',
  '30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry',
  '35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh','97':'Other territory'
};

export const defaultBillingProfile: BillingProfile = {
  enabled:false,revision:0,legalName:'',address:'',stateCode:'20',gstin:'',taxMode:'none',
  rateBasisPoints:0,pricesIncludeTax:true,classification:'',series:'RP',creditSeries:'CN',testMode:true
};

export const billingProfileSchema = {
  type:'object', additionalProperties:false,
  required:['enabled','revision','legalName','address','stateCode','gstin','taxMode','rateBasisPoints','pricesIncludeTax','classification','series','testMode'],
  properties:{enabled:{type:'boolean'},revision:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},legalName:{type:'string',maxLength:150},address:{type:'string',maxLength:600},
    stateCode:{type:'string',pattern:'^[0-9]{2}$'},gstin:{type:'string',maxLength:15},taxMode:{enum:['none','gst','composition']},
    rateBasisPoints:{type:'integer',minimum:0,maximum:2800},pricesIncludeTax:{type:'boolean'},classification:{type:'string',maxLength:8},
    series:{type:'string',pattern:'^[A-Z0-9]{1,4}$'},creditSeries:{type:'string',pattern:'^[A-Z0-9]{1,4}$'},testMode:{type:'boolean'}}
};

export function normalizeBillingProfile(input: BillingProfile): BillingProfile & { creditSeries: string } {
  return {...input,legalName:input.legalName.trim(),address:input.address.trim(),gstin:input.gstin.trim().toUpperCase(),
    series:input.series.trim().toUpperCase(),creditSeries:(input.creditSeries??'CN').trim().toUpperCase(),classification:input.classification.trim()};
}

export function billingProfileIssue(profile: BillingProfile): string | undefined {
  if (!profile.enabled) return;
  if (!profile.legalName || !profile.address || !stateNames[profile.stateCode]) return 'Enter the business name, address, and state.';
  if (profile.taxMode !== 'none' && (!validGstin(profile.gstin) || profile.gstin.slice(0,2) !== profile.stateCode || !/^\d{4,8}$/.test(profile.classification))) {
    return 'Enter the correct GSTIN, matching state, and HSN/SAC classification.';
  }
  if (profile.taxMode === 'none' && profile.gstin) return 'Choose GST or bill of supply for a registered business.';
  if ((profile.taxMode !== 'gst' && profile.rateBasisPoints !== 0) || (profile.taxMode === 'gst' && profile.rateBasisPoints <= 0)) {
    return 'Enter the applicable GST percentage, or use zero for non-GST and bill-of-supply billing.';
  }
}

export function validGstin(value:string) {
  if(!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)||!stateNames[value.slice(0,2)]) return false;
  const digits='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let factor=2;
  let sum=0;
  for(let index=value.length-2;index>=0;index--) {
    const product=factor*digits.indexOf(value[index]!);
    sum+=Math.floor(product/36)+product%36;
    factor=factor===2?1:2;
  }
  return digits[(36-sum%36)%36]===value.at(-1);
}

export function roundRatio(amount:number,numerator:number,denominator:number) {
  return Number((BigInt(amount)*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator));
}

export function billAmounts(subtotalPaise:number,discountPaise:number,profile:BillingProfile,placeState:string):
  Pick<BillSnapshot,'taxablePaise'|'cgstPaise'|'sgstPaise'|'igstPaise'|'roundingPaise'|'totalPaise'> {
  const net=subtotalPaise-discountPaise;
  const rate=profile.taxMode==='gst'?profile.rateBasisPoints:0;
  const taxablePaise=profile.pricesIncludeTax?roundRatio(net,10000,10000+rate):net;
  const interstate=placeState!==profile.stateCode;
  const cgstPaise=interstate?0:roundRatio(taxablePaise,rate,20000);
  const sgstPaise=cgstPaise;
  const igstPaise=interstate?roundRatio(taxablePaise,rate,10000):0;
  const computed=taxablePaise+cgstPaise+sgstPaise+igstPaise;
  const totalPaise=profile.pricesIncludeTax?net:computed;
  return {taxablePaise,cgstPaise,sgstPaise,igstPaise,totalPaise,roundingPaise:totalPaise-computed};
}
