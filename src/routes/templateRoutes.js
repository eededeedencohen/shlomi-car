import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/templateController.js';

const router = express.Router();

router.use(protect);

router.get('/', ctrl.listTemplates);
router.post('/', ctrl.createTemplate);
router.put('/:id', ctrl.updateTemplate);
router.delete('/:id', ctrl.deleteTemplate);

export default router;
