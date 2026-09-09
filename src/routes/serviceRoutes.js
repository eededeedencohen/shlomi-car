import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/serviceController.js';

const router = express.Router();

router.use(protect);

router.get('/', ctrl.listServices);
router.post('/', ctrl.createService);

router.get('/:id', ctrl.getService);
router.put('/:id', ctrl.updateService);
router.delete('/:id', ctrl.deleteService);
router.patch('/:id/status', ctrl.setStatus);

// items: `reorder` MUST be declared before `/:id/items/:itemId` so it is not captured as an item id
router.post('/:id/items', ctrl.addItems);
router.put('/:id/items/reorder', ctrl.reorderItems);
router.put('/:id/items/:itemId', ctrl.updateItem);
router.patch('/:id/items/:itemId/toggle', ctrl.toggleItem);
router.delete('/:id/items/:itemId', ctrl.removeItem);

router.post('/:id/carry', ctrl.carryIntoService);

router.post('/:id/payments', ctrl.addPayment);
router.put('/:id/payments/:paymentId', ctrl.updatePayment);
router.delete('/:id/payments/:paymentId', ctrl.removePayment);

export default router;
