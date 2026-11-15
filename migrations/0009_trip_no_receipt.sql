-- A trip recorded without a receipt (`trip.record` with noReceipt, src/domain/ops/shopping.ts): lines bought another day or
-- off the receipt. NULL = the trip has a receipt, so a record written before this column (recordedChanges pads a missing
-- key with null) still reads as one; calibration, `lastTrip` and `plan -- status` skip a trip with 1.
ALTER TABLE trips ADD COLUMN no_receipt INTEGER;
