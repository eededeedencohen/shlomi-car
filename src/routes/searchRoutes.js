import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/searchController.js';

const router = express.Router();

router.use(protect);

// GET /api/search?q=
router.get('/', ctrl.search);

export default router;
