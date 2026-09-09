/**
 * seedUser.js - creates (or resets the password of) the login user.
 *   node src/scripts/seedUser.js
 * Env overrides: SEED_USERNAME (default "shlomi"), SEED_PASSWORD (default "shlomi123"), SEED_NAME.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: User } = await import('../models/User.js');

const username = (process.env.SEED_USERNAME || 'shlomi').toLowerCase();
const password = process.env.SEED_PASSWORD || 'shlomi123';
const name = process.env.SEED_NAME || 'שלומי';

await connectDB();

let user = await User.findOne({ username });
if (!user) user = new User({ username, name });
user.name = name;
user.active = true;
await user.setPassword(password);
await user.save();

console.log(`\nUser ready: ${name} | username: ${username} | password: ${password}`);
console.log('Change the password from inside the app after first login.\n');

await disconnectDB();
process.exit(0);
