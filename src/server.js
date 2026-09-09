// שעון ישראל לכל חישובי הזמן המקומיים - גם כשהשרת רץ ב-UTC. חייב להיקבע לפני כל שימוש ב-Date.
process.env.TZ = 'Asia/Jerusalem';

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectDB } = await import('./config/db.js');
const { default: app } = await import('./app.js');

const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
      console.error('JWT_SECRET must be set in production');
      process.exit(1);
    }
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Shlomi Garage API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
};

start();

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
