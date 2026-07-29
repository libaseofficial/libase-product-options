-- CreateIndex
CREATE UNIQUE INDEX "OptionChoice_optionFieldId_easifyChoiceId_key" ON "OptionChoice"("optionFieldId", "easifyChoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionField_optionSetId_easifyFieldId_key" ON "OptionField"("optionSetId", "easifyFieldId");

