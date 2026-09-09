import mongoose from 'mongoose';

/**
 * Builds the MongoDB connection string.
 * DATABASE may contain a `<PASSWORD>` placeholder that is substituted with DATABASE_PASSWORD.
 * MONGODB_URI (full URI) takes precedence when present.
 */
export const buildMongoUri = () => {
  const { DATABASE, DATABASE_PASSWORD, MONGODB_URI } = process.env;
  if (MONGODB_URI) return MONGODB_URI;
  if (!DATABASE) {
    throw new Error('Missing DATABASE (or MONGODB_URI) in environment / .env');
  }
  return DATABASE.replace('<PASSWORD>', encodeURIComponent(DATABASE_PASSWORD || ''));
};

export const connectDB = async () => {
  const uri = buildMongoUri();
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const { host, name } = mongoose.connection;
  console.log(`MongoDB connected -> ${host}/${name}`);
  return mongoose.connection;
};

export const disconnectDB = async () => {
  await mongoose.disconnect();
};

export default connectDB;
