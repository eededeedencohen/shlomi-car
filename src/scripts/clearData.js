/**
 * clearData.js - wipes all business data (customers, vehicles, services) before real use.
 * Keeps users and the work-item catalog.
 *   node src/scripts/clearData.js --yes
 * Refuses to run without --yes and refuses when NODE_ENV=production.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('clearData refuses to run in production');
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error('This deletes ALL customers, vehicles and services. Re-run with --yes to confirm.');
  process.exit(1);
}

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Customer } = await import('../models/Customer.js');
const { default: Vehicle } = await import('../models/Vehicle.js');
const { default: Service } = await import('../models/Service.js');

await connectDB();

const [services, vehicles, customers] = await Promise.all([
  Service.deleteMany({}),
  Vehicle.deleteMany({}),
  Customer.deleteMany({}),
]);

console.log(`Deleted: ${services.deletedCount} services, ${vehicles.deletedCount} vehicles, ${customers.deletedCount} customers.`);
console.log('Users and the work-item catalog were kept.');

await disconnectDB();
process.exit(0);
