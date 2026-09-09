/**
 * GET /api/bootstrap - the whole working set in one (gzipped) answer: customers, vehicles, services (with
 * items, payments and status history), catalog tasks and bundles. The client loads it once when the app
 * opens and works on its own copy from then on (lists, dashboard, search and details are computed locally;
 * every change is applied locally first and sent to the API in the background).
 */
import Customer from '../models/Customer.js';
import Vehicle from '../models/Vehicle.js';
import Service from '../models/Service.js';
import WorkItemTemplate from '../models/WorkItemTemplate.js';
import ServiceBundle from '../models/ServiceBundle.js';
import asyncHandler from '../utils/asyncHandler.js';

export const getBootstrap = asyncHandler(async (req, res) => {
  const [customers, vehicles, services, templates, bundles] = await Promise.all([
    Customer.find({}).lean(),
    Vehicle.find({}).lean(),
    Service.find({}).lean(),
    WorkItemTemplate.find({}).lean(),
    ServiceBundle.find({}).lean(),
  ]);
  res.json({
    success: true,
    data: { customers, vehicles, services, templates, bundles, generatedAt: new Date() },
  });
});
