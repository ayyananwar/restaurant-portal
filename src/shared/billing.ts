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
