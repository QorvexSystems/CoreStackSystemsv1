// Explicit projections prevent commercial data leaking through nested relations or action responses.
export function factoryProduct(product: any) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    unit: product.unit,
    kind: product.kind,
    material: product.material,
    measurement: product.measurement,
    imageUrl: product.imageUrl,
    status: product.status,
    category: product.category,
  };
}
export function factoryOrder(order: any) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    clientName: order.clientName,
    status: order.status,
    source: order.source,
    productionStage: order.productionStage,
    exceptionStatus: order.exceptionStatus,
    priority: order.priority,
    promisedAt: order.promisedAt,
    requiresProduction: order.requiresProduction,
    designApprovedAt: order.designApprovedAt,
    qualityApprovedAt: order.qualityApprovedAt,
    productionNotes: order.productionNotes,
    deliveredAt: order.deliveredAt,
    isCorporate: order.isCorporate,
    corporateUnits: order.corporateUnits,
    deliveryMethod: order.deliveryMethod,
    dispatchLocation: order.dispatchLocation,
    deliveryAddress: order.deliveryAddress,
    deliveryPhone: order.deliveryPhone,
    createdAt: order.createdAt,
    workflowEvents: order.workflowEvents,
    customer: order.customer
      ? { id: order.customer.id, name: order.customer.name, phone: order.customer.phone }
      : null,
    items: order.items.map((item: any) => ({
      id: item.id,
      productId: item.productId,
      sku: item.sku,
      barcode: item.barcode,
      description: item.description,
      quantity: item.quantity,
      personalization: item.personalization,
      product: factoryProduct(item.product),
    })),
  };
}
