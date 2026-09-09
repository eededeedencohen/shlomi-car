import express from 'express';
import { protect } from '../middleware/auth.js';
import { getBootstrap } from '../controllers/bootstrapController.js';

const router = express.Router();

router.use(protect);
router.get('/', getBootstrap);

export default router;
