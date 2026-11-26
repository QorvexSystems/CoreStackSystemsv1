export const salesScope = { tenantId:'synthetictenant00000001', issuerRnc:'101010632', environment:'production' as const };
export function electronicSalesFixture(type: 31 | 32 = 31) {
  return {version:'1',operationId:'synthetic-operation',source:{documentId:'synthetic-invoice',revision:'2026-11-24T12:00:00.000Z'},
    type,issuedOn:'2026-11-24',currency:'DOP',pricesIncludeTax:false,
    issuer:{rnc:salesScope.issuerRnc,fiscalName:'Synthetic issuer',address:'Synthetic address'},
    buyer:{kind:'DOMESTIC',identifier:'101010632',fiscalName:'Synthetic buyer'},incomeType:'01',payment:{type:1},
    lines:[{sourceLineId:'synthetic-line',description:'Synthetic goods',kind:'GOOD',quantity:'1.00',unitPrice:'100.0000',discount:'0.00',billingIndicator:1}],
    expectedTotals:{net:'100.00',itbis:'18.00',total:'118.00',itbisWithheld:'0.00',isrWithheld:'0.00'}};
}
