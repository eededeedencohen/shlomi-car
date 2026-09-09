import ApiError from '../utils/ApiError.js';

export const notFound = (req, res, next) => {
  next(new ApiError(404, `נתיב לא נמצא: ${req.originalUrl}`));
};

/** Hebrew message for a MongoDB duplicate key error (E11000), by the offending index field. */
const duplicateKeyMessage = (err) => {
  const keyValue = err.keyValue || {};
  const keys = Object.keys(keyValue);
  const patternKeys = Object.keys(err.keyPattern || {});
  const fields = keys.length ? keys : patternKeys;
  if (fields.includes('plateNumber')) {
    return `מספר רכב ${keyValue.plateNumber ?? ''} כבר קיים במערכת`.replace(/\s{2,}/g, ' ');
  }
  if (fields.includes('titleKey')) {
    return /servicebundles/i.test(String(err.message || '')) ? 'חבילה בשם זה כבר קיימת' : 'פריט קטלוג בשם זה כבר קיים';
  }
  return 'הערך כבר קיים במערכת';
};

/** CastError on `_id` (or any nested `xxx._id`) means "record not found" for the caller. */
const isIdCast = (err) => typeof err.path === 'string' && /(^|\.)_id$/.test(err.path);

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  let status = err.statusCode || 500;
  let message = err.message || 'שגיאת שרת';

  if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors || {})
      .map((e) => (e.name === 'CastError' ? `ערך לא תקין עבור ${e.path}` : e.message))
      .join(', ') || 'נתונים לא תקינים';
  } else if (err.name === 'CastError') {
    if (isIdCast(err)) {
      status = 404;
      message = 'לא נמצא';
    } else {
      status = 400;
      message = `ערך לא תקין עבור ${err.path}`;
    }
  } else if (err.code === 11000) {
    status = 400;
    message = duplicateKeyMessage(err);
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'גוף הבקשה אינו JSON תקין';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'גוף הבקשה גדול מדי';
  } else if (err.name === 'VersionError') {
    // optimistic concurrency: the document changed under us (double tap / second tab)
    status = 409;
    message = 'הרשומה עודכנה במקביל. רעננו את הדף ונסו שוב';
  }

  if (status >= 500) {
    // Log the real error, never leak driver / library internals to the client.
    console.error('ERROR', err);
    if (!err.isOperational) message = 'שגיאת שרת, נסו שוב מאוחר יותר';
  }

  const body = { success: false, message };
  // optional payload on operational errors, e.g. { existingVehicleId } on a duplicate plate (spec 4.3)
  if (err.data !== undefined) body.data = err.data;
  res.status(status).json(body);
};
