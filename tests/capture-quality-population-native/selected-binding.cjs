const { isIPv4 } = require('node:net');
const { requireStage, hash, identifier } = require('./value.cjs');
const endpoint = 'https://sub2api.big.zone/v1/responses';
function selectionShape(binding, endpoints, approvalID) {
  requireStage(binding?.kind === 'parent-node-selected-address-v1' && binding.endpoint === endpoint &&
    binding.hostname === 'sub2api.big.zone' && isIPv4(binding.address) && binding.family === 4 && binding.port === 443 &&
    JSON.stringify(endpoints) === JSON.stringify([endpoint]), 'selected_provider_binding');
  const evidence = binding.selection;
  requireStage(identifier(evidence?.id) && evidence.approval_id === approvalID &&
    /^[a-f0-9]{64}$/.test(evidence.resolution_sha256 ?? '') && /^[a-f0-9]{64}$/.test(evidence.route_sha256 ?? '') &&
     /^[a-zA-Z0-9]{1,32}$/.test(evidence.route_interface ?? ''), 'selected_provider_binding');
  requireStage(Number.isFinite(Date.parse(evidence.selected_at)), 'selected_provider_binding');
}
function validateSelection(binding, endpoints, approvalID) {
  selectionShape(binding, endpoints, approvalID);
  const age = Date.now() - Date.parse(binding.selection.selected_at);
  requireStage(Number.isFinite(age) && age >= 0 && age <= 300000, 'selected_provider_binding');
}
function assertSelectedBinding(input, approval) {
  validateSelection(input.network_binding, input.endpoints, approval.approval_id);
  requireStage(approval.network_binding && hash(approval.network_binding) === hash(input.network_binding), 'selected_provider_binding');
}
module.exports = { validateSelection, selectionShape, assertSelectedBinding };
