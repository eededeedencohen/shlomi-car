import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/bundleController.js';

const router = express.Router();

router.use(protect);

router.get('/', ctrl.listBundles);
router.post('/', ctrl.createBundle);
router.put('/:id', ctrl.updateBundle);
router.delete('/:id', ctrl.deleteBundle);

export default router;
