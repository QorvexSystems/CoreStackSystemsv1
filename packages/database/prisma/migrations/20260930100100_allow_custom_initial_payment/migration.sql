ALTER TABLE "SalesOrder"
DROP CONSTRAINT "SalesOrder_credit_check";

ALTER TABLE "SalesOrder"
ADD CONSTRAINT "SalesOrder_credit_check" CHECK (
  "initialPaymentRate" >= 0
  AND "initialPaymentRate" <= 1
  AND "initialPaymentAmount" >= 0
  AND "initialPaymentAmount" <= "total"
  AND ("creditTermDays" IS NULL OR "creditTermDays" > 0)
  AND (
    (
      "paymentMode" = 'CASH'
      AND "initialPaymentOption" IS NULL
      AND "initialPaymentRate" = 0
      AND "initialPaymentAmount" = 0
      AND "creditTermOption" IS NULL
      AND "creditTermDays" IS NULL
      AND "dueDate" IS NULL
    )
    OR (
      "paymentMode" = 'CREDIT'
      AND "customerId" IS NOT NULL
      AND "initialPaymentOption" IS NOT NULL
      AND "creditTermOption" IS NOT NULL
      AND "creditTermDays" IS NOT NULL
      AND "dueDate" IS NOT NULL
      AND (
        (
          "initialPaymentOption" = 'CUSTOM'
          AND "initialPaymentAmount" > 0
        )
        OR (
          "initialPaymentAmount" = round("total" * "initialPaymentRate", 2)
          AND (
            ("initialPaymentOption" = 'NONE' AND "initialPaymentRate" = 0)
            OR ("initialPaymentOption" = 'PERCENT_30' AND "initialPaymentRate" = 0.3)
            OR ("initialPaymentOption" = 'PERCENT_50' AND "initialPaymentRate" = 0.5)
            OR ("initialPaymentOption" = 'PERCENT_70' AND "initialPaymentRate" = 0.7)
          )
        )
      )
    )
  )
);
