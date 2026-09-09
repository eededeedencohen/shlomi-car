import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/dashboardController.js';

const router = express.Router();

router.use(protect);

// GET /api/dashboard
router.get('/', ctrl.getSummary);
// GET /api/dashboard/annual?state=due|overdue|due_soon|none|muted&page&limit
router.get('/annual', ctrl.listAnnual);
// GET /api/dashboard/open-balances?groupBy=service|customer&page&limit
router.get('/open-balances', ctrl.listOpenBalances);

export default router;
