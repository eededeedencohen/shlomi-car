import mongoose from 'mongoose';

const { Schema } = mongoose;

/** One part (חלק) of a task: `price` is the UNIT price, the line is qty x price. */
export const partSchema = new Schema({
  title: {
    type: String,
    required: [true, 'שם החלק הוא שדה חובה'],
    trim: true,
    maxlength: [200, 'שם החלק ארוך מדי'],
  },
  qty: { type: Number, min: [1, 'כמות חייבת להיות לפחות 1'], default: 1 },
  price: { type: Number, min: [0, 'מחיר לא יכול להיות שלילי'], default: null },
});

/** The work (עבודה, labor) of a task: a name and a price, no quantity. */
export const workSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, 'שם העבודה הוא שדה חובה'],
      trim: true,
      maxlength: [200, 'שם העבודה ארוך מדי'],
    },
    price: { type: Number, min: [0, 'מחיר לא יכול להיות שלילי'], default: null },
  },
  { _id: false }
);

/** Fields every task-shaped document shares (service items, catalog templates, bundle lines). */
export const taskFields = () => ({
  title: {
    type: String,
    required: [true, 'שם הפריט הוא שדה חובה'],
    trim: true,
    maxlength: [200, 'שם הפריט ארוך מדי'],
  },
  work: { type: workSchema, default: null },
  parts: { type: [partSchema], default: [] },
  // record price: overrides labor + parts when set
  price: { type: Number, min: [0, 'מחיר לא יכול להיות שלילי'], default: null },
});
