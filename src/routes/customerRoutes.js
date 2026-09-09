import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/customerController.js';

const router = express.Router();

router.use(protect);

router.get('/', ctrl.list);
// declared before /:id so "lookup" is never parsed as an id
router.get('/lookup', ctrl.lookup);
router.get('/:id', ctrl.getOne);
router.get('/:id/deletion', ctrl.deletionPreview);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

export default router;
