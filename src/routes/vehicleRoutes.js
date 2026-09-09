import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/vehicleController.js';

const router = express.Router();

router.use(protect);

router.get('/', ctrl.list);
// declared before /:id so "lookup" and "makes" are never parsed as ids
router.get('/lookup/:plate', ctrl.lookup);
router.get('/makes', ctrl.makes);
router.get('/:id', ctrl.getOne);
router.get('/:id/deletion', ctrl.deletionPreview);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.put('/:id/transfer', ctrl.transfer);
router.put('/:id/annual', ctrl.updateAnnual);
router.post('/:id/annual/backfill', ctrl.backfillAnnual);
router.delete('/:id', ctrl.remove);

export default router;
