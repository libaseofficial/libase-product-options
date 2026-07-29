-- CreateTable
CREATE TABLE "OptionSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "easifySetId" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "settingsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OptionField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionSetId" TEXT NOT NULL,
    "easifyFieldId" TEXT,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "name" TEXT,
    "helpText" TEXT,
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "minLength" INTEGER,
    "maxLength" INTEGER,
    "minValue" REAL,
    "maxValue" REAL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "settingsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionField_optionSetId_fkey" FOREIGN KEY ("optionSetId") REFERENCES "OptionSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OptionChoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionFieldId" TEXT NOT NULL,
    "easifyChoiceId" TEXT,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "priceAdjustment" INTEGER NOT NULL DEFAULT 0,
    "linkedProductId" TEXT,
    "linkedVariantId" TEXT,
    "imageUrl" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "settingsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionChoice_optionFieldId_fkey" FOREIGN KEY ("optionFieldId") REFERENCES "OptionField" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OptionCondition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceFieldId" TEXT NOT NULL,
    "targetFieldId" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "expectedValue" TEXT,
    "action" TEXT NOT NULL DEFAULT 'show',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "settingsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionCondition_sourceFieldId_fkey" FOREIGN KEY ("sourceFieldId") REFERENCES "OptionField" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OptionCondition_targetFieldId_fkey" FOREIGN KEY ("targetFieldId") REFERENCES "OptionField" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionSetId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productHandle" TEXT,
    "productTitle" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductMapping_optionSetId_fkey" FOREIGN KEY ("optionSetId") REFERENCES "OptionSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "summaryJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "OptionSet_shop_idx" ON "OptionSet"("shop");

-- CreateIndex
CREATE INDEX "OptionSet_shop_status_idx" ON "OptionSet"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OptionSet_shop_easifySetId_key" ON "OptionSet"("shop", "easifySetId");

-- CreateIndex
CREATE INDEX "OptionField_optionSetId_idx" ON "OptionField"("optionSetId");

-- CreateIndex
CREATE INDEX "OptionChoice_optionFieldId_idx" ON "OptionChoice"("optionFieldId");

-- CreateIndex
CREATE INDEX "OptionChoice_linkedVariantId_idx" ON "OptionChoice"("linkedVariantId");

-- CreateIndex
CREATE INDEX "OptionCondition_sourceFieldId_idx" ON "OptionCondition"("sourceFieldId");

-- CreateIndex
CREATE INDEX "OptionCondition_targetFieldId_idx" ON "OptionCondition"("targetFieldId");

-- CreateIndex
CREATE INDEX "ProductMapping_shopifyProductId_idx" ON "ProductMapping"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_optionSetId_shopifyProductId_key" ON "ProductMapping"("optionSetId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ImportJob_shop_idx" ON "ImportJob"("shop");

-- CreateIndex
CREATE INDEX "ImportJob_shop_status_idx" ON "ImportJob"("shop", "status");
