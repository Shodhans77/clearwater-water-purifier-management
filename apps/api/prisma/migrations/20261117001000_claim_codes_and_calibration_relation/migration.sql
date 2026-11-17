ALTER TABLE "Device" ADD COLUMN "claimCodeHash" TEXT;
ALTER TABLE "Calibration" ADD CONSTRAINT "Calibration_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
