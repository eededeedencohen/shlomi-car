/**
 * recompute.js - re-saves every service (runs recalc + date consistency) and rebuilds
 * every vehicle's derived fields (annual reminder, counters).
 *   node src/scripts/recompute.js     (npm run recompute)
 * Safe to run any time; timestamps are not bumped.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Service } = await import('../models/Service.js');
const { default: Vehicle } = await import('../models/Vehicle.js');
const { recomputeVehicleStats } = await import('../utils/annual.js');

await connectDB();

let servicesOk = 0;
let servicesFailed = 0;
let vehiclesOk = 0;
let vehiclesFailed = 0;

try {
  for await (const svc of Service.find().cursor()) {
    try {
      await svc.save({ timestamps: false });
      servicesOk += 1;
    } catch (err) {
      servicesFailed += 1;
      console.error(`service ${svc._id} (${svc.plateNumber}): ${err.message}`);
    }
  }

  const vehicles = await Vehicle.find().select('_id plateNumber').lean();
  for (const v of vehicles) {
    try {
      await recomputeVehicleStats(v._id);
      vehiclesOk += 1;
    } catch (err) {
      vehiclesFailed += 1;
      console.error(`vehicle ${v._id} (${v.plateNumber}): ${err.message}`);
    }
  }

  console.log(
    `\nRecompute done: services ${servicesOk} ok / ${servicesFailed} failed, ` +
      `vehicles ${vehiclesOk} ok / ${vehiclesFailed} failed.\n`
  );
} finally {
  await disconnectDB();
}

process.exit(servicesFailed || vehiclesFailed ? 1 : 0);
